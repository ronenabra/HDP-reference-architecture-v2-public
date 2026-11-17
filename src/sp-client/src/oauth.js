'use strict';

/** Strict OAuth request construction and expiry-aware token caching. */
const { validateDataAuthorizationDetails } = require('../../shared/data-authorization-details');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { signingAlgorithm, jwkThumbprint } = require('../../shared/assertion-keys');
const { randomUUID: uuidv4 } = crypto;
const {
    SCOPES,
    isOpaqueClientId,
    isThumbprint
} = require('./constants');

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

function assertAbsoluteUrl(value, name) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be an absolute URL`);
    let parsed;
    try { parsed = new URL(value); } catch (_error) { throw new TypeError(`${name} must be an absolute URL`); }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError(`${name} must use HTTP(S)`);
    if (parsed.username || parsed.password || parsed.hash) throw new TypeError(`${name} cannot contain credentials or a fragment`);
    return value;
}

/** Sign an approved EC private_key_jwt with its registered JWK thumbprint. */
function createClientAssertion({
    clientId,
    privateKey,
    audience,
    b2b,
    cnfThumbprint,
    clock = () => Date.now(),
    jtiGenerator = uuidv4
}) {
    if (!isOpaqueClientId(clientId)) {
        throw new TypeError('client_id must be an opaque identifier');
    }
    if (cnfThumbprint !== undefined && !isThumbprint(cnfThumbprint)) {
        throw new TypeError('cnf x5t#S256 must be a base64url SHA-256 thumbprint');
    }
    if (b2b !== undefined) throw new TypeError('Legacy B2B assertions are not supported');
    const exactAudience = assertAbsoluteUrl(audience, 'assertion audience');
    const issuedAt = Math.floor(clock() / 1000);
    const payload = {
        iss: clientId,
        sub: clientId,
        aud: exactAudience,
        iat: issuedAt,
        exp: issuedAt + 300,
        jti: jtiGenerator(),
        ...(cnfThumbprint ? { cnf: { 'x5t#S256': cnfThumbprint } } : {})
    };
    if (typeof payload.jti !== 'string' || !payload.jti) throw new TypeError('jti generator returned an invalid identifier');
    return jwt.sign(payload, privateKey, {
        algorithm: signingAlgorithm(privateKey),
        header: { typ: 'JWT', kid: jwkThumbprint(privateKey) }
    });
}

/** Validate one closed PCM token response. */
function validateTokenResponse(value, { maximumLifetime = 86400, allowSandboxGuid = false } = {}) {
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    if (!value || keys.some(key => !['access_token', 'token_type', 'expires_in', 'scope', 'authorization_details'].includes(key))
        || typeof value.access_token !== 'string' || !value.access_token
        || value.token_type !== 'Bearer'
        || !Number.isInteger(value.expires_in)
        || value.expires_in < 1
        || value.expires_in > maximumLifetime
        || typeof value.scope !== 'string' || !value.scope) {
        throw new TypeError('PCM token response is not the closed Bearer-token response');
    }
    if (value.authorization_details !== undefined) validateDataAuthorizationDetails(value.authorization_details, { allowSandboxGuid });
    return value;
}

/** Build an exact single-resource token form. */
function buildTokenForm({ grantType = 'client_credentials', assertion, resource, scope, code, redirectUri, codeVerifier, authorizationDetails }) {
    const params = new URLSearchParams({ grant_type: grantType });
    if (grantType === 'client_credentials') {
        if (!assertion || !scope) throw new TypeError('Client-credentials token request requires assertion and scope');
        params.set('resource', assertAbsoluteUrl(resource, 'resource'));
    } else if (grantType === 'authorization_code') {
        if (![assertion, code, redirectUri, codeVerifier].every(value => typeof value === 'string' && value)) {
            throw new TypeError('Authorization-code exchange requires code, redirect URI, verifier, and assertion');
        }
        params.set('code', code);
        params.set('redirect_uri', assertAbsoluteUrl(redirectUri, 'redirect URI'));
        params.set('code_verifier', codeVerifier);
    } else {
        throw new TypeError('Unsupported SP token grant type');
    }
    params.set('client_assertion_type', CLIENT_ASSERTION_TYPE);
    params.set('client_assertion', assertion);
    if (scope) params.set('scope', scope);
    if (authorizationDetails !== undefined) {
        if (grantType !== 'client_credentials' || [SCOPES.management, SCOPES.legacyManagement].includes(scope)) throw new TypeError('RAR is prohibited for this grant');
        params.set('authorization_details', JSON.stringify(authorizationDetails));
    }
    return params;
}

/** Apply only an explicitly enabled compatibility vocabulary adapter. */
function effectiveManagementScope(policy, requested = SCOPES.management) {
    if (requested === SCOPES.management) return requested;
    if (requested === SCOPES.legacyManagement
        && policy?.compatibility?.enabledAdapters?.includes('legacy-management-scope-cruds')) {
        return SCOPES.management;
    }
    throw new TypeError(`Unsupported management scope: ${requested}`);
}

function clientConformanceInfo(policy) {
    if (!policy || !['strict', 'connectathon'].includes(policy.mode)) throw new TypeError('Effective conformance policy is required');
    return Object.freeze({
        version: policy.version,
        grantPolicy: policy.grantPolicy,
        mode: policy.mode,
        resultLabel: policy.resultLabel,
        warnings: Object.freeze([...(policy.compatibility?.warnings || [])])
    });
}

class ExpiringTokenCache {
    constructor({ clock = () => Date.now(), skewMs = 250 } = {}) {
        this.clock = clock;
        this.skewMs = skewMs;
        this.records = new Map();
        this.expiryCursor = null;
    }

    /** Reclaim up to 16 expired cache records during ordinary use. */
    reclaimExpired() {
        this.expiryCursor ||= this.records.entries();
        const deadline = this.clock() + this.skewMs;
        for (let visited = 0; visited < 16; visited++) {
            const next = this.expiryCursor.next();
            if (next.done) { this.expiryCursor = null; break; }
            const [key, record] = next.value;
            if (record.expiresAt <= deadline) this.records.delete(key);
        }
    }

    get(key) {
        this.reclaimExpired();
        const record = this.records.get(key);
        if (!record || record.reuseUntil <= this.clock() + this.skewMs) {
            return null;
        }
        return record.token;
    }

    /** Cache a response under the same environment and identity rules as its caller. */
    put(key, response, validationOptions = {}, acquiredAt = this.clock()) {
        this.reclaimExpired();
        const validated = validateTokenResponse(response, validationOptions);
        this.records.set(key, {
            generation: uuidv4(), acquiredAt,
            reuseUntil: acquiredAt + Math.min(validated.expires_in, 30) * 1000,
            token: validated.access_token,
            response: structuredClone(validated),
            expiresAt: acquiredAt + validated.expires_in * 1000
        });
        return validated.access_token;
    }

    /** Return a detached copy of current effective grant diagnostics without exposing mutable cache state. */
    details(key) {
        if (!this.get(key)) return null;
        return structuredClone(this.records.get(key).response);
    }

    /** Return only receipt metadata; no credential enters rendered details. */
    metadata(key) {
        const record = this.records.get(key);
        return record && { generation: record.generation, acquiredAt: record.acquiredAt, expiresAt: record.expiresAt };
    }

    clear() { this.records.clear(); this.expiryCursor = null; }
}

/** Create an S256 challenge from a high-entropy verifier. */
function pkceChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

module.exports = {
    CLIENT_ASSERTION_TYPE,
    ExpiringTokenCache,
    buildTokenForm,
    clientConformanceInfo,
    createClientAssertion,
    effectiveManagementScope,
    pkceChallenge,
    validateTokenResponse
};
