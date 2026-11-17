'use strict';

/**
 * Atomic expiring-record stores used by OAuth one-time state.
 *
 * The file implementation uses exclusive creation in a shared runtime
 * directory. This gives every PCM process the same create-if-absent boundary
 * when the directory is backed by the configured shared volume (local bind
 * mount or the sandbox EFS volume).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function recordName(key) {
    return `${crypto.createHash('sha256').update(String(key)).digest('hex')}.json`;
}

function lockPathFor(filePath) {
    return filePath.replace(/\.json$/, '.lock');
}

/**
 * Shared, filesystem-backed create-if-absent store for expiring claims.
 */
class FileExpiryClaimStore {
    constructor(directory, options = {}) {
        if (!directory) throw new Error('A shared state-store directory is required');
        this.directory = directory;
        this.maxCorruptRecordAgeSeconds = options.maxCorruptRecordAgeSeconds || 600;
        fs.mkdirSync(directory, { recursive: true });
    }

    /** Acquire a per-record lock, reclaiming only locks old enough to be abandoned. */
    acquireLock(lockPath) {
        for (;;) {
            try {
                const descriptor = fs.openSync(lockPath, 'wx', 0o600);
                fs.closeSync(descriptor);
                return true;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                try {
                    const ageSeconds = Math.floor(Date.now() / 1000)
                        - Math.floor(fs.statSync(lockPath).mtimeMs / 1000);
                    if (ageSeconds < this.maxCorruptRecordAgeSeconds) return false;
                    const stalePath = `${lockPath}.abandoned-${process.pid}-${crypto.randomUUID()}`;
                    fs.renameSync(lockPath, stalePath);
                    fs.rmSync(stalePath, { force: true });
                } catch (statError) {
                    if (statError.code !== 'ENOENT') throw statError;
                }
            }
        }
    }

    /** Remove expired records while retaining recent corrupt records fail-closed. */
    cleanup(nowSeconds) {
        for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const filePath = path.join(this.directory, entry.name);
            const lockPath = lockPathFor(filePath);
            if (!this.acquireLock(lockPath)) continue;
            try {
                const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (Number.isSafeInteger(record.expiresAt) && record.expiresAt <= nowSeconds) {
                    fs.rmSync(filePath, { force: true });
                }
            } catch (error) {
                try {
                    const ageSeconds = nowSeconds - Math.floor(fs.statSync(filePath).mtimeMs / 1000);
                    if (ageSeconds >= this.maxCorruptRecordAgeSeconds) fs.rmSync(filePath, { force: true });
                } catch (statError) {
                    if (statError.code !== 'ENOENT') throw statError;
                }
            } finally {
                fs.rmSync(lockPath, { force: true });
            }
        }
    }

    /** Observe an existing claim without consuming or extending its lifetime. */
    isClaimed(key, nowSeconds) {
        try {
            const record = JSON.parse(fs.readFileSync(path.join(this.directory, recordName(key)), 'utf8'));
            return !Number.isSafeInteger(record.expiresAt) || record.expiresAt > nowSeconds;
        } catch (error) { return error.code !== 'ENOENT'; }
    }

    /** Atomically claim a key until its absolute NumericDate expiry. */
    tryClaim(key, expiresAt, nowSeconds) {
        if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nowSeconds) || expiresAt <= nowSeconds) {
            throw new Error('State-store expiry must be a future integer NumericDate');
        }
        fs.mkdirSync(this.directory, { recursive: true });
        this.cleanup(nowSeconds);
        const filePath = path.join(this.directory, recordName(key));
        const lockPath = lockPathFor(filePath);
        if (!this.acquireLock(lockPath)) return false;
        let temporaryPath = null;
        try {
            let existing = null;
            try {
                existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (readError) {
                if (readError.code !== 'ENOENT') return false;
            }
            if (existing && (!Number.isSafeInteger(existing.expiresAt) || existing.expiresAt > nowSeconds)) {
                return false;
            }

            temporaryPath = `${filePath}.pending-${process.pid}-${crypto.randomUUID()}`;
            const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
            try {
                fs.writeFileSync(descriptor, `${JSON.stringify({ expiresAt })}\n`);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            fs.renameSync(temporaryPath, filePath);
            temporaryPath = null;
            return true;
        } finally {
            if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
            fs.rmSync(lockPath, { force: true });
        }
    }
}

/** Local/test-only expiring claim store with no cross-process guarantees. */
class MemoryExpiryClaimStore {
    constructor(options = {}) {
        if (options.localOnly !== true) {
            throw new Error('The in-memory state store is permitted only for explicit local/test use');
        }
        this.records = new Map();
    }

    /** Observe a local claim without changing its expiry. */
    isClaimed(key, nowSeconds) { return this.records.get(key) > nowSeconds; }

    /** Claim a key in the current process until its absolute NumericDate expiry. */
    tryClaim(key, expiresAt, nowSeconds) {
        const existing = this.records.get(key);
        if (existing > nowSeconds) return false;
        this.records.set(key, expiresAt);
        for (const [recordKey, expiry] of this.records) {
            if (expiry <= nowSeconds) this.records.delete(recordKey);
        }
        return true;
    }
}

/** Shared immutable first-use window repository keyed by authorization/source. */
class FileFirstUseWindowStore {
    constructor(directory) {
        if (!directory) throw new Error('A first-use state directory is required');
        this.directory = directory;
        fs.mkdirSync(directory, { recursive: true });
    }

    /** Read a first-use window without creating or changing its immutable deadline.
     * @param {string} key Consent/source key.
     * @returns {object|null} Validated record, failure, or null before first use.
     */
    get(key) {
        try {
            const record = JSON.parse(fs.readFileSync(path.join(this.directory, recordName(key)), 'utf8'));
            if (!Number.isSafeInteger(record.startedAt) || !Number.isSafeInteger(record.expiresAt)
                || record.expiresAt <= record.startedAt) return { ok: false };
            return { ...record, ok: true };
        } catch (error) {
            return error.code === 'ENOENT' ? null : { ok: false };
        }
    }

    /** Atomically return an existing window or establish its first-use time. */
    getOrStart(key, lifetimeSeconds, nowSeconds) {
        if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0 || !Number.isSafeInteger(nowSeconds)) {
            throw new Error('First-use window requires positive integer lifetime and integer time');
        }
        const filePath = path.join(this.directory, recordName(key));
        const lockPath = lockPathFor(filePath);
        const claimStore = new FileExpiryClaimStore(this.directory);
        let acquired = false;
        for (let attempt = 0; attempt < 100 && !acquired; attempt += 1) {
            acquired = claimStore.acquireLock(lockPath);
            if (!acquired) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        if (!acquired) return { ok: false };
        let temporaryPath = null;
        try {
            try {
                const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (Number.isSafeInteger(existing.startedAt) && Number.isSafeInteger(existing.expiresAt)
                    && existing.expiresAt === existing.startedAt + lifetimeSeconds) {
                    return { ok: true, started: false, ...existing };
                }
                return { ok: false };
            } catch (error) {
                if (error.code !== 'ENOENT') return { ok: false };
            }
            const record = { startedAt: nowSeconds, expiresAt: nowSeconds + lifetimeSeconds };
            temporaryPath = `${filePath}.pending-${process.pid}-${crypto.randomUUID()}`;
            const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
            try {
                fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
                fs.fsyncSync(descriptor);
            } finally {
                fs.closeSync(descriptor);
            }
            fs.renameSync(temporaryPath, filePath);
            temporaryPath = null;
            return { ok: true, started: true, ...record };
        } finally {
            if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
            fs.rmSync(lockPath, { force: true });
        }
    }
}

/** Build a shared claim store inside the configured runtime state directory. */
function createConfiguredExpiryStore(namespace, config = {}) {
    if (!/^[a-z0-9-]+$/.test(namespace)) throw new Error('Invalid state-store namespace');
    const stateDir = process.env.STATE_DIR || config.runtime?.stateDir;
    if (!stateDir) throw new Error('STATE_DIR or runtime.stateDir is required for shared OAuth state');
    return new FileExpiryClaimStore(path.join(stateDir, namespace));
}

function createConfiguredFirstUseStore(namespace, config = {}) {
    if (!/^[a-z0-9-]+$/.test(namespace)) throw new Error('Invalid state-store namespace');
    const stateDir = process.env.STATE_DIR || config.runtime?.stateDir;
    if (!stateDir) throw new Error('STATE_DIR or runtime.stateDir is required for shared OAuth state');
    return new FileFirstUseWindowStore(path.join(stateDir, namespace));
}

module.exports = {
    FileExpiryClaimStore,
    FileFirstUseWindowStore,
    MemoryExpiryClaimStore,
    createConfiguredExpiryStore,
    createConfiguredFirstUseStore,
    recordName
};
