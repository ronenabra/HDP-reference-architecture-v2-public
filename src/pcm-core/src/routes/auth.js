/**
 * PCM OAuth2 endpoints (token issuance and introspection).
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { sourceControls } = require('../source-policy');
const router = express.Router({ caseSensitive: true, strict: true });
const { findClientById, tokenStore } = require('../store');
const fhirStore = require('../fhir/store');
const logger = require('../logger');
const { getEffectiveConformancePolicy, loadTeamConfig } = require('../team-config');
const { getAuthorizationServerMetadata, getIssuer } = require('../oauth-metadata');
const { CANONICAL_BASE } = require('../../../shared/pcm-contract');
const { createPublicMtlsMiddleware } = require('../public-mtls');
const { createClientAssertionVerifier } = require('../client-assertion');
const { createConfiguredExpiryStore, createConfiguredFirstUseStore } = require('../state-store');
const { createTokenService } = require('../token-service');
const { createIntrospectionService } = require('../introspection-service');
const { getSystemFlowStore } = require('../system-flow-store');

/**
 * Enforce mTLS client authentication on incoming requests.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireMtls = createPublicMtlsMiddleware({ kind: 'oauth' });

/**
 * Validate OAuth2 private_key_jwt client authentication.
 * @param {import('express').Request} req
 * @param {string} endpointPath
 * @returns {{client: object, decodedAssertion: object}|{errorStatus: number, errorBody: object}}
 */
let assertionVerifier = null;

function getAssertionVerifier() {
    if (assertionVerifier) return assertionVerifier;
    const config = loadTeamConfig();
    assertionVerifier = createClientAssertionVerifier({
        findClient: findClientById,
        getPolicy: getEffectiveConformancePolicy,
        replayStore: createConfiguredExpiryStore('assertion-replay', config),
        resolveLegacyClientId: issuer => {
            const organization = Object.values(loadTeamConfig().organizations || {})
                .find(candidate => candidate?.id && `${CANONICAL_BASE}/Organization/${candidate.id}` === issuer);
            return organization?.clientId || null;
        },
        logger
    });
    return assertionVerifier;
}

function authenticateClientAssertion(req, endpointPath, compatibilityPaths = [], options = {}) {
    const issuer = getIssuer(req);
    const ownInspection = endpointPath === '/introspect' && findClientById(jwt.decode(req.body.client_assertion)?.iss)?.role === 'service-provider';
    return getAssertionVerifier()({
        deferReplay: options.deferReplay === true,
        assertion: req.body.client_assertion,
        assertionType: req.body.client_assertion_type,
        // Assertions identify the stable logical OAuth endpoint published in
        // discovery, even when Compose routes the HTTP request over an
        // internal back-channel hostname.
        exactAudience: `${issuer}${endpointPath}`,
        compatibilityAudiences: ownInspection ? [] : compatibilityPaths.map(candidate => `${issuer}${candidate}`),
        tlsIdentity: req.mtls || null,
        controls: ownInspection ? {} : sourceControls(fhirStore, getEffectiveConformancePolicy(), loadTeamConfig(), { resource: req.body.resource, clientId: jwt.decode(req.body.client_assertion)?.iss })
    });
}

/**
 * Issue an OAuth2 access token using private_key_jwt + mTLS.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
const firstUseStore = createConfiguredFirstUseStore('first-use-windows', loadTeamConfig());
const tokenService = createTokenService({
    firstUseStore,
    tokenStore,
    fhirStore,
    resolveInvocation: (clientId, jti) => getSystemFlowStore(loadTeamConfig()).peekAssertion(clientId, jti),
    consumeInvocation: (clientId, jti) => getSystemFlowStore(loadTeamConfig()).consumeAssertion(clientId, jti),
    authenticate: (req, options) => authenticateClientAssertion(req, '/token', [], options),
    getIssuer,
    getPolicy: getEffectiveConformancePolicy,
    logger
});

const issueToken = (req, res) => {
    const result = tokenService(req);
    return res.status(result.status).json(result.body);
};

router.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json(getAuthorizationServerMetadata(req));
});

router.post('/token', requireMtls, issueToken);

const introspectionService = createIntrospectionService({
    tokenStore,
    getPolicy: getEffectiveConformancePolicy,
    getConfig: loadTeamConfig,
    store: fhirStore,
    resolveInvocation: (id, clientId) => getSystemFlowStore(loadTeamConfig()).invocation(id, clientId),
    findClient: findClientById,
    authenticateAssertion: (req, options) => authenticateClientAssertion(req, '/introspect', ['/token'], options),
    getAudience: req => `${getIssuer(req)}/introspect`,
    firstUseStore,
    logger
});

const introspectToken = (req, res) => {
    const result = introspectionService(req);
    return res.status(result.status).json(result.body);
};

router.post('/introspect', requireMtls, introspectToken);

module.exports = router;
