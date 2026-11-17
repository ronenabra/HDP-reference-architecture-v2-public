'use strict';

/** Strict OAuth request/response primitives used by one Data Source adapter. */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require('../../shared/assertion-keys');
const { isOpaqueClientId } = require('../../shared/pcm-contract');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const INTROSPECTION_SCOPE = 'system/*.crus';

function assertion(clientId, audience, privateKey, clock = () => Math.floor(Date.now() / 1000), transportCertificate) {
    if (!isOpaqueClientId(clientId)) throw new Error('Data Source client_id must be opaque');
    const now = clock();
    return jwt.sign({ iss: clientId, sub: clientId, aud: audience, iat: now, exp: now + 300, jti: crypto.randomUUID(), ...(transportCertificate ? { cnf: certificateConfirmation(transportCertificate) } : {}) }, privateKey, {
        algorithm: signingAlgorithm(privateKey),
        header: { typ: 'JWT', kid: jwkThumbprint(privateKey) }
    });
}

function bearerTokenForm(clientAssertion, introspectionEndpoint) {
    return new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: clientAssertion,
        scope: INTROSPECTION_SCOPE,
        resource: introspectionEndpoint
    });
}

function directIntrospectionForm(token, clientAssertion) {
    return new URLSearchParams({
        token,
        token_type_hint: 'access_token',
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: clientAssertion
    });
}

function bearerIntrospectionForm(token) {
    return new URLSearchParams({ token, token_type_hint: 'access_token' });
}

/** Validate the closed caller response against its configured logical environment maximum. */
function validateBearerResponse(value, maximumSeconds = 30) {
    const required = ['access_token', 'token_type', 'expires_in', 'scope'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !required.includes(key))
        || required.some(key => !Object.hasOwn(value, key))
        || typeof value.access_token !== 'string' || !value.access_token
        || value.token_type !== 'Bearer' || !Number.isSafeInteger(value.expires_in)
        || value.expires_in < 1 || value.expires_in > maximumSeconds || value.scope !== INTROSPECTION_SCOPE) {
        const error = new Error('Invalid closed introspection bearer token response');
        error.reasonCode = 'MALFORMED_PCM_RESPONSE';
        throw error;
    }
    return value;
}

class IntrospectionCredentialCache {
    constructor({ clock = () => Date.now(), maximumSeconds = 30 } = {}) {
        this.clock = clock;
        this.maximumSeconds = maximumSeconds;
        this.entry = null;
    }

    get(observer = () => {}) {
        const entry = this.entry;
        const outcome = !entry ? 'miss' : entry.expiresAtMs <= this.clock() ? 'expired' : 'hit';
        try { observer({ cache: 'introspection-credential', outcome, reasonCode: `CACHE_${outcome.toUpperCase()}`,
            ...(entry ? { ageMs: Math.max(0, this.clock() - entry.createdAtMs), remainingMs: Math.max(0, entry.expiresAtMs - this.clock()) } : {}) }); } catch (_) { /* Diagnostic only. */ }
        if (!this.entry || this.entry.expiresAtMs <= this.clock()) {
            this.entry = null;
            return null;
        }
        return this.entry.token;
    }

    put(response) {
        validateBearerResponse(response, this.maximumSeconds);
        const receivedAt = this.clock();
        this.entry = { token: response.access_token, expiresAtMs: receivedAt + response.expires_in * 1000, createdAtMs: receivedAt };
        return response.access_token;
    }

    clear(observer = () => {}) {
        this.entry = null;
        try { observer({ cache: 'introspection-credential', outcome: 'invalidated', reasonCode: 'CACHE_INVALIDATED' }); } catch (_) { /* Diagnostic only. */ }
    }
}

module.exports = {
    ASSERTION_TYPE,
    INTROSPECTION_SCOPE,
    IntrospectionCredentialCache,
    assertion,
    bearerIntrospectionForm,
    bearerTokenForm,
    directIntrospectionForm,
    validateBearerResponse
};
