/**
 * Local JWT issuer metadata and signing helpers for the data-source zone.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';
const DEFAULT_SIGNING_KEY = path.join(CERTS_DIR, 'ds-gateway.key');

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getIssuer() {
    const hoId = process.env.HO_ID || 'reference';
    return trimTrailingSlash(
        process.env.LOCAL_JWT_ISSUER ||
        `https://ds-auth-adapter.internal/${encodeURIComponent(hoId)}`
    );
}

function getAudience() {
    const hoId = process.env.HO_ID || 'reference';
    return process.env.LOCAL_JWT_AUDIENCE || `urn:pcm:ho:${hoId}:fhir-server`;
}

function getSigningKeyPath() {
    return process.env.LOCAL_JWT_SIGNING_KEY_PATH || DEFAULT_SIGNING_KEY;
}

function readSigningKey() {
    return fs.readFileSync(getSigningKeyPath(), 'utf8');
}

function getKeyId() {
    if (process.env.LOCAL_JWT_KEY_ID) return process.env.LOCAL_JWT_KEY_ID;
    const publicDer = crypto.createPublicKey(readSigningKey()).export({ type: 'spki', format: 'der' });
    return `local-jwt-${crypto.createHash('sha256').update(publicDer).digest('base64url').slice(0, 16)}`;
}

function getPublicJwk() {
    const jwk = crypto.createPublicKey(readSigningKey()).export({ format: 'jwk' });
    return {
        ...jwk,
        kid: getKeyId(),
        use: 'sig',
        alg: 'RS256'
    };
}

function getJwks() {
    return { keys: [getPublicJwk()] };
}

function getAuthorizationServerMetadata() {
    const issuer = getIssuer();
    return {
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: [],
        grant_types_supported: [],
        token_endpoint_auth_methods_supported: [],
        token_endpoint_auth_signing_alg_values_supported: ['RS256']
    };
}

function signLocalJwt(payload, options = {}) {
    if (!payload || payload.schema !== 'pcm-ds-local-token/5') throw new Error('Invalid local JWT claim schema');
    const issuer = options.issuer || getIssuer();
    const audience = options.audience || getAudience();
    if (!issuer || !audience) throw new Error('Local JWT issuer and audience are required');
    const now = options.clock?.() ?? Math.floor(Date.now() / 1000);
    const sourceExpiresAt = options.sourceExpiresAt;
    if (!Number.isSafeInteger(sourceExpiresAt) || sourceExpiresAt <= now) throw new Error('Source authorization has expired');
    const expiresAt = Math.min(sourceExpiresAt, now + 30);
    const tokenPayload = { ...payload };
    delete tokenPayload.iss;
    delete tokenPayload.aud;
    delete tokenPayload.iat;
    delete tokenPayload.exp;
    delete tokenPayload.jti;
    tokenPayload.iat = now;
    tokenPayload.exp = expiresAt;
    const compact = jwt.sign(tokenPayload, readSigningKey(), {
        algorithm: 'RS256',
        keyid: getKeyId(),
        issuer,
        audience,
        jwtid: crypto.randomUUID(),
        mutatePayload: false,
        header: { alg: 'RS256', typ: 'JWT', kid: getKeyId() }
    });
    // Both NGINX auth_request and private Node/Tomcat ingress use a finite 64 KiB
    // header envelope. Reject before publishing a token that the next hop cannot parse.
    const limit = options.maxPrivateAuthorizationBytes ?? 57344;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 57344) throw new TypeError('Invalid maxPrivateAuthorizationBytes');
    const observed = Buffer.byteLength(compact);
    if (observed > limit) {
        const error = new Error(`Private authorization exceeds maxPrivateAuthorizationBytes=${limit}; observed=${observed}`);
        // This module owns the measured serialized private token, never the upstream HAPI request.
        error.budgetFailure = Object.freeze({ setting: 'maxPrivateAuthorizationBytes', threshold: limit, observed, unit: 'bytes' });
        throw error;
    }
    return compact;
}

module.exports = {
    getAuthorizationServerMetadata,
    getAudience,
    getIssuer,
    getJwks,
    getKeyId,
    getPublicJwk,
    getSigningKeyPath,
    signLocalJwt
};
