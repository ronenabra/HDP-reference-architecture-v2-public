'use strict';

/** Stateful standalone SMART authorization-code + PKCE helpers. */
const crypto = require('crypto');
const { pkceChallenge } = require('./oauth');
const { ENVIRONMENTS, AUTHORIZATION_DETAILS_TYPE } = require('../../shared/pcm-environment');
const { isOpaqueClientId } = require('./constants');

function randomBase64Url(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/** Validate the SMART discovery capabilities required by this client. */
function validateSmartConfiguration(value, { expectedIssuer = null } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('SMART discovery response must be an object');
    }
    for (const name of ['issuer', 'authorization_endpoint', 'token_endpoint', 'introspection_endpoint']) {
        try {
            const url = new URL(value[name]);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid');
        } catch (_error) {
            throw new TypeError(`SMART discovery ${name} must be an absolute HTTP(S) URL`);
        }
    }
    if (!Object.values(ENVIRONMENTS).some(environment => environment.base === value.issuer)
        || (expectedIssuer && value.issuer !== expectedIssuer)
        || value.authorization_endpoint !== `${value.issuer}/authorize`
        || value.token_endpoint !== `${value.issuer}/token`
        || value.introspection_endpoint !== `${value.issuer}/introspect`) {
        throw new TypeError('SMART endpoints do not match the exact contract environment');
    }
    const includes = (field, item) => Array.isArray(value[field]) && value[field].includes(item);
    const requiredCapabilities = ['launch-standalone', 'client-confidential-asymmetric', 'permission-patient', 'permission-v2'];
    if (!includes('authorization_details_types_supported', AUTHORIZATION_DETAILS_TYPE)
        || !includes('grant_types_supported', 'authorization_code')
        || !includes('grant_types_supported', 'client_credentials')
        || !includes('response_types_supported', 'code')
        || !includes('code_challenge_methods_supported', 'S256')
        || !includes('token_endpoint_auth_methods_supported', 'private_key_jwt')
        || !includes('token_endpoint_auth_signing_alg_values_supported', 'ES256')
        || value.tls_client_certificate_bound_access_tokens !== false
        || requiredCapabilities.some(capability => !includes('capabilities', capability))) {
        throw new TypeError('SMART discovery response lacks a required confidential asymmetric capability');
    }
    return JSON.parse(JSON.stringify(value));
}

function createAuthorizationTransaction({
    authorizationEndpoint,
    clientId,
    redirectUri,
    audience,
    scope,
    clock = () => Date.now(),
    random = randomBase64Url
}) {
    const scopes = typeof scope === 'string' ? scope.trim().split(/\s+/) : [];
    const supportedContext = new Set(['openid', 'fhirUser', 'launch', 'launch/patient', 'offline_access', 'online_access']);
    if (!scopes.length || !scopes.some(value => /^patient\/[A-Za-z*]+\.(?:r|s|rs)$/.test(value))
        || scopes.some(value => !supportedContext.has(value) && !/^patient\/[A-Za-z*]+\.(?:r|s|rs)$/.test(value))) {
        throw new TypeError('SMART scope must be a supported patient-level scope');
    }
    if (!isOpaqueClientId(clientId)) throw new TypeError('SMART client_id must be an opaque identifier');
    for (const [name, value] of Object.entries({ authorizationEndpoint, redirectUri, audience })) {
        let parsed;
        try { parsed = new URL(value); } catch (_error) { throw new TypeError(`${name} must be an absolute HTTP(S) URL`); }
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
            throw new TypeError(`${name} must be an absolute HTTP(S) URL without credentials or fragment`);
        }
    }
    const state = random(24);
    const verifier = random(48);
    if (typeof state !== 'string' || !state || typeof verifier !== 'string'
        || verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) {
        throw new TypeError('SMART random source returned invalid state or PKCE verifier material');
    }
    const url = new URL(authorizationEndpoint);
    const params = {
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
        scope, state, code_challenge: pkceChallenge(verifier),
        code_challenge_method: 'S256', aud: audience
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return {
        state, verifier, clientId, redirectUri, audience, requestedScope: scope,
        authorizationUrl: url.toString(), expiresAt: clock() + 5 * 60 * 1000,
        consumed: false
    };
}

function consumeAuthorizationCallback(transaction, query, { clock = () => Date.now() } = {}) {
    if (!transaction || transaction.consumed || transaction.expiresAt <= clock()) {
        throw new Error('SMART authorization transaction is unknown, consumed, or expired');
    }
    if (typeof query?.state !== 'string' || query.state !== transaction.state) {
        throw new Error('SMART authorization state mismatch');
    }
    transaction.consumed = true;
    if (query.error) {
        const error = new Error(query.error_description || query.error);
        error.oauthError = query.error;
        throw error;
    }
    if (typeof query.code !== 'string' || !query.code) throw new Error('SMART callback has no authorization code');
    return { code: query.code, verifier: transaction.verifier, ...transaction };
}

/** Read only the existing Doctor browser's opaque binding; it is never identity evidence. */
function smartBrowserBinding(req) {
    const value = String(req?.headers?.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('pcmDoctorSmartBrowser='))?.slice('pcmDoctorSmartBrowser='.length);
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
/** Bind server-private state to the browser without storing the raw cookie in the transaction. */
function smartBrowserHash(value) { return value ? crypto.createHash('sha256').update(value).digest('hex') : null; }

module.exports = {
    smartBrowserBinding, smartBrowserHash,
    consumeAuthorizationCallback,
    createAuthorizationTransaction,
    randomBase64Url,
    validateSmartConfiguration
};
