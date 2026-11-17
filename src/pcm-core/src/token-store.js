'use strict';

/** Shared file-backed repository for typed opaque access-token records. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The demo configuration permits one-hour backdating. Retain another hour for
// an operator to exercise disabled-expiry behavior; authorization still uses exp.
const EXPIRED_TOKEN_RETENTION_SECONDS = 2 * 60 * 60;
const EXPIRY_BATCH_SIZE = 16;

const TOKEN_KINDS = Object.freeze([
    'authorization_code',
    'management',
    'introspection',
    'data_source_access',
    'presence_online',
    'presence_batch',
    'patient_authentication',
    'dependent_discovery',
    'sandbox_patient_sample'
]);

function defaultOpaqueTokenGenerator() {
    return crypto.randomUUID();
}

function tokenFileName(token) {
    return `token-${crypto.createHash('sha256').update(String(token)).digest('hex')}.json`;
}

/** File-backed typed token repository shared through runtime.stateDir. */
class FileTokenStore {
    constructor(directory, options = {}) {
        if (!directory) throw new Error('A token-store directory is required');
        this.directory = directory;
        this.clock = options.clock || (() => Math.floor(Date.now() / 1000));
        this.tokenGenerator = options.tokenGenerator || defaultOpaqueTokenGenerator;
        this.expiryCursor = null;
    }

    ensureDirectory() {
        fs.mkdirSync(this.directory, { recursive: true });
    }

    /** Release the directory cursor when clearing or retiring this store. */
    close() {
        if (this.expiryCursor) this.expiryCursor.closeSync();
        this.expiryCursor = null;
    }

    /** Reclaim at most one bounded batch, including records from earlier processes.
     * @returns {number} Directory entries inspected during this operation.
     */
    reclaimExpired() {
        if (!this.expiryCursor) {
            try { this.expiryCursor = fs.opendirSync(this.directory, { bufferSize: EXPIRY_BATCH_SIZE }); }
            catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
        }
        const now = this.clock();
        let visited = 0;
        while (visited < EXPIRY_BATCH_SIZE) {
            const entry = this.expiryCursor.readSync();
            if (!entry) { this.close(); break; }
            visited++;
            if (!entry.isFile() || !/^token-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            const file = path.join(this.directory, entry.name);
            let record;
            try {
                record = JSON.parse(fs.readFileSync(file, 'utf8'));
                this.validateRecord(record);
            } catch (_) { continue; } // Missing or unreadable records never authorize a request.
            if (record.exp + EXPIRED_TOKEN_RETENTION_SECONDS <= now) {
                fs.rmSync(file, { force: true });
                fs.rmSync(`${file}.revoked`, { force: true });
            }
        }
        return visited;
    }

    recordPath(token) {
        return path.join(this.directory, tokenFileName(token));
    }

    validateRecord(record) {
        if (!record || typeof record !== 'object' || !TOKEN_KINDS.includes(record.kind)) {
            throw new Error('Opaque token records require a supported explicit kind');
        }
        if (!Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp)) {
            throw new Error('Opaque token records require integer iat and exp');
        }
    }

    write(token, record) {
        this.validateRecord(record);
        this.ensureDirectory();
        const filePath = this.recordPath(token);
        const descriptor = fs.openSync(filePath, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    }

    /** Issue a new opaque token with an explicit kind and lifetime. */
    issue(kind, claims, lifetimeSeconds) {
        if (!TOKEN_KINDS.includes(kind)) throw new Error(`Unsupported token kind: ${kind}`);
        if (!Number.isSafeInteger(lifetimeSeconds)) throw new Error('Token lifetime must be integer seconds');
        const now = this.clock();
        if (!Number.isSafeInteger(now)) throw new Error('Token-store clock must return integer seconds');
        this.reclaimExpired();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const token = this.tokenGenerator();
            const record = { ...claims, kind, iat: now, exp: now + lifetimeSeconds };
            try {
                this.write(token, record);
                return { token, record };
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
        }
        throw new Error('Unable to allocate a unique opaque access token');
    }

    /** Test/bootstrap helper that retains explicit record validation. */
    set(token, record) {
        this.reclaimExpired();
        this.delete(token);
        this.write(token, record);
        return this;
    }

    /** Read one token record without treating expiration as authorization. */
    get(token) {
        this.reclaimExpired();
        return this.peek(token);
    }

    /** Inspect one retained record without cleanup, revocation, renewal or other writes. */
    peek(token) {
        if (typeof token !== 'string' || !token) return undefined;
        try {
            const record = JSON.parse(fs.readFileSync(this.recordPath(token), 'utf8'));
            this.validateRecord(record);
            if (record.exp + EXPIRED_TOKEN_RETENTION_SECONDS <= this.clock()) return undefined;
            if (fs.existsSync(`${this.recordPath(token)}.revoked`)) record.revoked = true;
            return record;
        } catch (error) {
            return undefined;
        }
    }

    /** Permanently deactivate one issued token without rewriting its frozen authority. */
    revoke(token) {
        if (!this.get(token)) return false;
        try {
            const descriptor = fs.openSync(`${this.recordPath(token)}.revoked`, 'wx', 0o600);
            try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        return true;
    }

    delete(token) {
        try {
            fs.rmSync(this.recordPath(token));
            fs.rmSync(`${this.recordPath(token)}.revoked`, { force: true });
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    }

    clear() {
        this.close();
        if (!fs.existsSync(this.directory)) return;
        for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
            if (entry.isFile() && /^token-[a-f0-9]{64}\.json(?:\.revoked)?$/.test(entry.name)) {
                fs.rmSync(path.join(this.directory, entry.name), { force: true });
            }
        }
    }

    get size() {
        if (!fs.existsSync(this.directory)) return 0;
        return fs.readdirSync(this.directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^token-[a-f0-9]{64}\.json$/.test(entry.name)).length;
    }
}

module.exports = {
    EXPIRED_TOKEN_RETENTION_SECONDS,
    EXPIRY_BATCH_SIZE,
    FileTokenStore,
    TOKEN_KINDS,
    defaultOpaqueTokenGenerator,
    tokenFileName
};
