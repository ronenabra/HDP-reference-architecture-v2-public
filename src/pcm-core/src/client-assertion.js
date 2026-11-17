'use strict';

/**
 * Reusable private_key_jwt verification pipeline for PCM OAuth endpoints.
 */

const fs = require('fs');
const jwt = require('jsonwebtoken');
const { X509Certificate } = require('crypto');
const { jwkThumbprint, publicKey, signingAlgorithm } = require('../../shared/assertion-keys');

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const MAX_ASSERTION_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;
const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COMPATIBILITY_WARNING_CODES = Object.freeze({
    'legacy-rs256-assertion': 'PCM-COMPAT-AUTHN-RS256',
    'legacy-es384-assertion': 'PCM-COMPAT-AUTHN-ES384',
    'legacy-jose-kid': 'PCM-COMPAT-AUTHN-KID',
    'legacy-introspection-token-audience': 'PCM-COMPAT-AUTHN-AUDIENCE',
    'legacy-organization-url-client-id': 'PCM-COMPAT-AUTHN-CLIENT-ID'
});

/** Return the stable internal error shape consumed by OAuth routes. */
function invalidClient(description) {
    return {
        errorStatus: 401,
        errorBody: { error: 'invalid_client', error_description: description }
    };
}

/** Derive an endpoint audience from the directly observed request origin. */
function endpointAudience(req, endpointPath) {
    const host = req?.get?.('host');
    const protocol = req?.protocol;
    if (!host || !protocol || !endpointPath.startsWith('/')) return '';
    return `${protocol}://${host}${endpointPath}`;
}

/** Load a client's registered assertion verification key for one algorithm. */
function defaultVerificationKey(client, algorithm) {
    const registered = client?.assertionKeyPaths?.[algorithm]
        || client?.assertionKeys?.[algorithm]
        || (algorithm === 'ES256' ? client?.certPath : null);
    if (!registered) throw new Error(`No registered ${algorithm} assertion key`);
    const read = value => {
        if (Buffer.isBuffer(value) || (typeof value === 'object' && value.type)
            || String(value).includes('-----BEGIN')) return value;
        return fs.readFileSync(value);
    };
    return Array.isArray(registered) ? registered.map(read) : read(registered);
}

/** Determine whether a named, versioned compatibility adapter is active. */
function compatibilityEnabled(policy, adapter) {
    return policy?.compatibility?.enabledAdapters?.includes(adapter) === true;
}

/**
 * Check retained issuance evidence against current role registrations.
 * @param {object} client Current authenticated-client registration.
 * @param {object} context Frozen certificate evidence from token issuance.
 * @returns {boolean} Whether both certificate roles remain registered.
 */
function registeredAuthenticationContext(client, context) {
    if (context.token_endpoint_mtls !== null && !(client.mtlsThumbprints || [client.mtlsThumbprint]).includes(context?.token_endpoint_mtls?.['x5t#S256'])) return false;
    if (context.client_assertion_signing === null) return true; // Validated skipped signature carries no certificate claim.
    const registrations = client.assertionKeyPaths || client.assertionKeys;
    if (!registrations) return client.assertionThumbprint === context?.client_assertion_signing?.['x5t#S256'];
    const approved = new Set();
    for (const algorithm of Object.keys(registrations)) {
        try {
            const material = defaultVerificationKey(client, algorithm);
            for (const key of Array.isArray(material) ? material : [material]) {
                try { approved.add(require('./crypto').certToX5tS256(new X509Certificate(key).raw)); }
                catch (_) { /* Bare public keys cannot establish certificate evidence. */ }
            }
        } catch (_) { /* Missing registrations cannot preserve old certificate authority. */ }
    }
    return approved.has(context?.client_assertion_signing?.['x5t#S256']);
}

/**
 * Create a verifier shared by token and introspection endpoints.
 *
 * The returned function enforces the strict JOSE/claim profile, registered-key
 * signature validation, optional certificate binding, and atomic replay use.
 */
function createClientAssertionVerifier(options) {
    const {
        findClient,
        getPolicy,
        replayStore,
        resolveLegacyClientId = () => null,
        getVerificationKey = defaultVerificationKey,
        clock = () => Math.floor(Date.now() / 1000),
        logger = console,
        clockSkewSeconds = CLOCK_SKEW_SECONDS
    } = options || {};
    if (typeof findClient !== 'function' || typeof getPolicy !== 'function' || !replayStore?.tryClaim) {
        throw new Error('Client assertion verifier requires client lookup, policy, and replay store');
    }

    function warn(policy, adapter, clientId) {
        const message = policy.compatibility.warnings.find(value => value.includes(adapter))
            || `connectathon adapter ${adapter} normalized a client assertion`;
        logger.warn?.(message, {
            type: 'COMPATIBILITY_ADAPTER',
            code: COMPATIBILITY_WARNING_CODES[adapter],
            adapter,
            clientId
        });
    }

    return ({ assertion, assertionType, exactAudience, compatibilityAudiences = [], tlsIdentity = null, controls = {}, deferReplay = false }) => {
        if (assertionType !== CLIENT_ASSERTION_TYPE || typeof assertion !== 'string' || !assertion) {
            return invalidClient('Missing or invalid client_assertion');
        }

        const decoded = jwt.decode(assertion, { complete: true });
        const claims = decoded?.payload;
        const header = decoded?.header;
        if (!claims || typeof claims !== 'object' || !header || typeof header !== 'object') {
            return invalidClient('Invalid JWT structure');
        }

        const allowedClaims = new Set(['iss', 'sub', 'aud', 'jti', 'iat', 'exp', 'cnf']);
        if (Object.keys(claims).some(name => !allowedClaims.has(name))) {
            return invalidClient('Assertion contains unsupported authentication claims');
        }

        const requiredStringClaims = ['iss', 'sub', 'aud', 'jti'];
        if (requiredStringClaims.some(name => typeof claims[name] !== 'string' || !claims[name])) {
            return invalidClient('Assertion requires non-empty iss, sub, aud, and jti claims');
        }
        if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
            return invalidClient('Assertion requires integer iat and exp claims');
        }
        if (claims.sub !== claims.iss) return invalidClient('Assertion iss and sub must match');

        const policy = getPolicy();
        let client = findClient(claims.iss);
        let normalizedLegacyClient = false;
        if (!client && compatibilityEnabled(policy, 'legacy-organization-url-client-id')) {
            const mappedClientId = resolveLegacyClientId(claims.iss);
            client = mappedClientId ? findClient(mappedClientId) : null;
            normalizedLegacyClient = Boolean(client);
        }
        if (!client) return invalidClient('Client not registered');

        if (header.typ !== 'JWT') return invalidClient('JWT typ must be JWT');
        const allowedHeaders = new Set(['alg', 'typ', 'kid']);
        const unexpectedHeader = Object.keys(header).find(name => !allowedHeaders.has(name));
        if (unexpectedHeader || (header.kid !== undefined && !allowedHeaders.has('kid'))) {
            return invalidClient('Forbidden JWT key-selection header');
        }
        if (!policy.assertion.algorithms.includes(header.alg)) {
            return invalidClient('JWT signing algorithm is not allowed');
        }

        const algorithmAdapter = header.alg === 'RS256' ? 'legacy-rs256-assertion' : null;
        if (algorithmAdapter && !compatibilityEnabled(policy, algorithmAdapter)) {
            return invalidClient('JWT signing algorithm is not allowed');
        }

        const acceptedCompatibilityAudience = compatibilityAudiences.includes(claims.aud)
            && compatibilityEnabled(policy, 'legacy-introspection-token-audience');
        if (controls.clientAssertionAudience !== false && claims.aud !== exactAudience && !acceptedCompatibilityAudience) {
            return invalidClient('Invalid JWT audience');
        }

        const now = clock();
        if (!Number.isSafeInteger(now)) throw new Error('Assertion verifier clock must return integer seconds');
        if (controls.clientAssertionExpiry !== false && (claims.exp <= claims.iat || claims.exp > claims.iat + MAX_ASSERTION_LIFETIME_SECONDS)) {
            return invalidClient('Assertion lifetime must be greater than zero and no more than 300 seconds');
        }
        if (controls.clientAssertionExpiry !== false && claims.iat > now + clockSkewSeconds) return invalidClient('Assertion iat is in the future');
        if (controls.clientAssertionExpiry !== false && claims.exp <= now - clockSkewSeconds) return invalidClient('Assertion has expired');

        if (claims.cnf !== undefined) {
            const keys = claims.cnf && typeof claims.cnf === 'object' && !Array.isArray(claims.cnf)
                ? Object.keys(claims.cnf)
                : [];
            if (keys.length !== 1 || keys[0] !== 'x5t#S256' || !THUMBPRINT_PATTERN.test(claims.cnf['x5t#S256'])) {
                return invalidClient('Invalid assertion cnf certificate thumbprint');
            }
            if (!tlsIdentity?.thumbprint || claims.cnf['x5t#S256'] !== tlsIdentity.thumbprint) {
                return invalidClient('Assertion cnf does not match the mTLS client certificate');
            }
        }

        // CA trust proves the socket's chain, not this application's ownership.
        // Even an omitted cnf must not allow another client's transport role.
        const registeredTransport = new Set(client.mtlsThumbprints || [client.mtlsThumbprint]);
        const transportVerified = Boolean(tlsIdentity?.thumbprint
            && registeredTransport.has(tlsIdentity.thumbprint));
        if ((tlsIdentity && !transportVerified)
            || (!tlsIdentity && policy.transport?.pcmPublic?.clientAuth === 'mtls')) {
            logger.warn?.('Client transport certificate role rejected', {
                type: 'AUTHENTICATION_ROLE_DENIED', clientId: client.clientId,
                category: 'security', visibility: 'default', decision: 'denied',
                role: 'mtls', observedThumbprint: tlsIdentity?.thumbprint || null,
                reason: tlsIdentity ? 'certificate-not-registered-for-client' : 'trusted-socket-identity-missing'
            });
            return invalidClient('Observed mTLS certificate is not registered for this client transport role');
        }

        const suppliedKid = header.kid !== undefined;
        const normativeKid = typeof header.kid === 'string' && THUMBPRINT_PATTERN.test(header.kid)
            && Buffer.from(header.kid, 'base64url').toString('base64url') === header.kid;
        const legacyKid = suppliedKid && !normativeKid && typeof header.kid === 'string' && header.kid.length > 0
            && compatibilityEnabled(policy, 'legacy-jose-kid');
        if (suppliedKid && !normativeKid && !legacyKid) return invalidClient('Invalid assertion kid thumbprint');
        if (client.authorizationCodeGrant === true && !suppliedKid) return invalidClient('SMART assertions require kid');
        let selectedThumbprint = null;
        let selectedCertificateThumbprint = null;
        try {
            if (controls.clientAssertionSignature !== false) {
                const material = getVerificationKey(client, header.alg);
                // Deduplicate identical approved keys: certificate renewal alone is not rollover.
                const approved = new Map((Array.isArray(material) ? material : [material]).map(key => {
                    let certificateThumbprint = null;
                    let certificate;
                    try { certificate = new X509Certificate(key); }
                    catch (_) { /* Bare registered public keys have no certificate identity. */ }
                    if (certificate && (Date.parse(certificate.validFrom) > now * 1000 || Date.parse(certificate.validTo) <= now * 1000)) return null;
                    const parsed = certificate?.publicKey || publicKey(key);
                    if (header.alg.startsWith('ES') && signingAlgorithm(parsed) !== header.alg) throw new Error('Wrong curve');
                    if (certificate) certificateThumbprint = require('./crypto').certToX5tS256(certificate.raw);
                    return [jwkThumbprint(parsed), { key: parsed, certificateThumbprint }];
                }).filter(Boolean));
                let key;
                if (normativeKid) {
                    key = approved.get(header.kid);
                    selectedThumbprint = header.kid;
                } else if (approved.size === 1) {
                    [selectedThumbprint, key] = approved.entries().next().value;
                }
                if (!key) return invalidClient('Assertion registered key selection is unknown or ambiguous');
                // Exactly one selected key is verified; signature failure never triggers fallback.
                selectedCertificateThumbprint = key.certificateThumbprint;
                jwt.verify(assertion, key.key, {
                    algorithms: [header.alg], clockTimestamp: now, clockTolerance: clockSkewSeconds,
                    ignoreExpiration: controls.clientAssertionExpiry === false,
                    ignoreNotBefore: controls.clientAssertionExpiry === false
                });
            }
        } catch (error) {
            return invalidClient('Assertion signature or registered key validation failed');
        }

        const replayKey = `${client.clientId}\u0000${claims.jti}`;
        const commitReplay = () => controls.clientAssertionReplay === false
            || replayStore.tryClaim(replayKey, Math.max(claims.exp + clockSkewSeconds, now + MAX_ASSERTION_LIFETIME_SECONDS), now);
        if (!deferReplay && !commitReplay()) return invalidClient('Assertion jti has already been used');

        if (normalizedLegacyClient) warn(policy, 'legacy-organization-url-client-id', client.clientId);
        if (legacyKid) warn(policy, 'legacy-jose-kid', client.clientId);
        if (algorithmAdapter) warn(policy, algorithmAdapter, client.clientId);
        if (acceptedCompatibilityAudience) warn(policy, 'legacy-introspection-token-audience', client.clientId);

        if (!transportVerified || controls.clientAssertionSignature === false) logger.warn?.('Client authentication uses explicit sandbox simulation', {
            type: 'AUTHENTICATION_SIMULATION', category: 'security', visibility: 'default', clientId: client.clientId,
            correlationVerified: false, skippedChecks: [...(!transportVerified ? ['token-endpoint-mtls'] : []),
                ...(controls.clientAssertionSignature === false ? ['client-assertion-signature'] : [])]
        });

        return {
            client,
            ...(deferReplay ? { commitReplay } : {}),
            assertionSigningThumbprint: selectedCertificateThumbprint,
            assertionKeyThumbprint: selectedThumbprint,
            transportVerified,
            signatureVerified: controls.clientAssertionSignature !== false,
            decodedAssertion: normalizedLegacyClient
                ? { ...claims, iss: client.clientId, sub: client.clientId }
                : claims
        };
    };
}

module.exports = {
    CLIENT_ASSERTION_TYPE,
    CLOCK_SKEW_SECONDS,
    COMPATIBILITY_WARNING_CODES,
    MAX_ASSERTION_LIFETIME_SECONDS,
    THUMBPRINT_PATTERN,
    createClientAssertionVerifier,
    defaultVerificationKey,
    endpointAudience,
    invalidClient,
    registeredAuthenticationContext
};
