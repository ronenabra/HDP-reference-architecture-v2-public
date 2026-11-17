'use strict';

/**
 * Persistent, one-time authorization request and code repository.
 *
 * Grant records are immutable files keyed by a digest of an unpredictable
 * handle. Atomic first-use claims reuse the shared expiry store, so all PCM
 * processes observe the same consume boundary.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { FileExpiryClaimStore } = require('./state-store');

const AUTHORIZATION_REQUEST_LIFETIME_SECONDS = 300;
const AUTHORIZATION_CODE_LIFETIME_SECONDS = 120;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function defaultTokenGenerator(kind) {
    return `pcm-${kind}-${crypto.randomBytes(32).toString('base64url')}`;
}

function pkceS256(verifier) {
    return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function normalizeScopeInput(scope) {
    if (Array.isArray(scope)) return scope;
    if (typeof scope !== 'string') return [];
    return scope.split(' ').filter(Boolean);
}

function requestedScopeDoesNotExpand(grantedScopes, requestedScopes) {
    const granted = new Set(normalizeScopeInput(grantedScopes));
    return normalizeScopeInput(requestedScopes).every(scope => granted.has(scope));
}

/** Immutable file repository for authorization protocol records. */
class FileAuthorizationRecordRepository {
    constructor(directory, options = {}) {
        this.directory = directory;
        this.tokenGenerator = options.tokenGenerator || defaultTokenGenerator;
        this.clock = options.clock || (() => Math.floor(Date.now() / 1000));
        this.requestLifetimeSeconds = options.requestLifetimeSeconds || AUTHORIZATION_REQUEST_LIFETIME_SECONDS;
        this.codeLifetimeSeconds = options.codeLifetimeSeconds || AUTHORIZATION_CODE_LIFETIME_SECONDS;
        fs.mkdirSync(directory, { recursive: true });
        this.claims = options.claimStore || new FileExpiryClaimStore(path.join(directory, 'consumed'));
    }

    /** Return the record path without putting the bearer handle in the filename. */
    recordPath(kind, handle) {
        return path.join(this.directory, `${kind}-${digest(handle)}.json`);
    }

    /** Remove expired immutable records; active records are never replaced. */
    cleanup(now = this.clock()) {
        for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            const filePath = path.join(this.directory, entry.name);
            try {
                const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (Number.isSafeInteger(record.expiresAt) && record.expiresAt <= now) {
                    fs.rmSync(filePath, { force: true });
                }
            } catch (error) {
                // Corrupt authorization state remains fail-closed. Operators can
                // remove it with the disposable runtime directory.
            }
        }
    }

    /** Write one immutable record under a newly generated opaque handle. */
    issue(kind, record, lifetimeSeconds) {
        const now = this.clock();
        if (!Number.isSafeInteger(now)) throw new Error('Authorization-store clock must return integer seconds');
        this.cleanup(now);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const handle = this.tokenGenerator(kind);
            const filePath = this.recordPath(kind, handle);
            try {
                const descriptor = fs.openSync(filePath, 'wx', 0o600);
                try {
                    const stored = { ...record, issuedAt: now, expiresAt: now + lifetimeSeconds };
                    fs.writeFileSync(descriptor, `${JSON.stringify(stored)}\n`);
                    fs.fsyncSync(descriptor);
                } finally {
                    fs.closeSync(descriptor);
                }
                return handle;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
            }
        }
        throw new Error(`Unable to allocate unique ${kind} handle`);
    }

    /** Read an immutable record, returning null for unknown or malformed state. */
    read(kind, handle) {
        if (typeof handle !== 'string' || !handle) return null;
        try {
            const record = JSON.parse(fs.readFileSync(this.recordPath(kind, handle), 'utf8'));
            return record && typeof record === 'object' ? record : null;
        } catch (error) {
            return null;
        }
    }

    /** Atomically claim a previously issued handle for its first successful use. */
    claim(kind, handle, record, now = this.clock()) {
        return this.claims.tryClaim(`${kind}\u0000${handle}`, record.expiresAt, now);
    }

    /** Begin one interactive authorization decision transaction. */
    beginAuthorization(request) {
        return this.issue('auth-request', request, this.requestLifetimeSeconds);
    }

    /** Read a pending decision without consuming it or renewing its original deadline. */
    peekAuthorization(transactionId) {
        const request = this.read('auth-request', transactionId), now = this.clock();
        return request && Number.isSafeInteger(request.expiresAt) && request.expiresAt > now
            && !this.claims.isClaimed(`auth-request\u0000${transactionId}`, now) ? request : null;
    }

    /** Pin verified self once per immutable request; another tab cannot substitute identity. */
    bindAuthorizationSelf(transactionId, patient) {
        const request = this.peekAuthorization(transactionId);
        if (!request) return false;
        const record = { patient, expiresAt: request.expiresAt };
        try { fs.writeFileSync(this.recordPath('auth-self', transactionId), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const bound = this.read('auth-self', transactionId);
        return bound?.patient?.system === patient.system && bound?.patient?.value === patient.value;
    }

    /** Consume one interactive authorization transaction. */
    consumeAuthorization(transactionId) {
        const now = this.clock();
        const request = this.read('auth-request', transactionId);
        if (!request || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now) return null;
        return this.claim('auth-request', transactionId, request, now) ? request : null;
    }

    /** Issue one short-lived authorization code bound to its complete grant. */
    issueCode(grant) {
        return this.issue('auth-code', grant, this.codeLifetimeSeconds);
    }

    /**
     * Validate and atomically consume an authorization code.
     *
     * This is the exchange boundary used by Sprint 06's token endpoint.
     */
    consumeCode({ code, clientId, redirectUri, codeVerifier, requestedScopes }) {
        const now = this.clock();
        const grant = this.read('auth-code', code);
        const invalid = description => ({ ok: false, error: 'invalid_grant', description });
        if (!grant || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now) {
            return invalid('Authorization code is unknown, expired, or already used');
        }
        if (grant.clientId !== clientId) return invalid('Authorization code client does not match');
        if (grant.redirectUri !== redirectUri) return invalid('Authorization code redirect URI does not match');
        if (!PKCE_VERIFIER_PATTERN.test(codeVerifier || '') || pkceS256(codeVerifier) !== grant.codeChallenge) {
            return invalid('Authorization code PKCE verifier does not match');
        }
        if (requestedScopes !== undefined && !requestedScopeDoesNotExpand(grant.scope, requestedScopes)) {
            return invalid('Authorization code scope cannot be expanded');
        }
        if (!this.claim('auth-code', code, grant, now)) {
            return invalid('Authorization code is unknown, expired, or already used');
        }
        return { ok: true, grant };
    }
}

let configuredStore = null;

/** Return the process singleton backed by the configured shared runtime volume. */
function getConfiguredAuthorizationStore(config = {}) {
    if (configuredStore) return configuredStore;
    const stateDir = process.env.STATE_DIR || config.runtime?.stateDir;
    if (!stateDir) throw new Error('STATE_DIR or runtime.stateDir is required for authorization state');
    configuredStore = new FileAuthorizationRecordRepository(path.join(stateDir, 'oauth-authorization'));
    return configuredStore;
}

module.exports = {
    AUTHORIZATION_CODE_LIFETIME_SECONDS,
    AUTHORIZATION_REQUEST_LIFETIME_SECONDS,
    FileAuthorizationRecordRepository,
    PKCE_VERIFIER_PATTERN,
    getConfiguredAuthorizationStore,
    normalizeScopeInput,
    pkceS256,
    requestedScopeDoesNotExpand
};
