/**
 * PCM FHIR REST endpoints with mTLS and OAuth2 protection.
 */
const express = require('express');
const router = express.Router({ caseSensitive: true, strict: true });
const store = require('../fhir/store');
const { FHIRStoreError } = require('../fhir/store');
const { tokens } = require('../store');
const logger = require('../logger');
const fs = require('fs');
const path = require('path');
const { createPublicMtlsMiddleware } = require('../public-mtls');
const { getIssuer, getSmartConfiguration } = require('../oauth-metadata');
const { FHIRSearchError, executeSearch } = require('../fhir/search');
const {
    ParticipantLifecycleError,
    createEndpoint,
    createServiceProviderChild,
    localReference,
    organizationRole,
    replaceEndpoint,
    replaceOrganization
} = require('../fhir/participant-lifecycle');
const {
    HealthcareServiceLifecycleError,
    businessStatus: serviceBusinessStatus,
    ownerId: serviceOwnerId,
    registerHealthcareService,
    requestCatalogUpdate: submitCatalogUpdate,
    serviceKind,
    transitionHealthcareService
} = require('../fhir/healthcare-service-lifecycle');
const {
    ConsentLifecycleError,
    cancelConsent,
    consentIsActive,
    createConsent,
    reconcileExpiredConsents,
    reconcileConsentsForService
} = require('../fhir/consent-lifecycle');
const {
    FHIRContractError,
    FHIR_ROUTE_DEFINITIONS,
    assertNoModifierExtensions,
    handleContractError,
    operationOutcome,
    sendOutcome,
    sendResource,
    validateWriteRequest
} = require('../fhir/contract');
const PCM_ORG_TYPE_CODE = 'pcm';
const { loadTeamConfig } = require('../team-config');
const { canReadPolicy, isSystemService } = require('../fhir/system-policy');

/**
 * Normalize a value into an array.
 * @param {any} value
 * @returns {any[]}
 */
const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

/**
 * Extract the logical id from a FHIR reference string.
 * @param {string|null|undefined} ref
 * @returns {string|null}
 */
const getRefId = ref => localReference(ref)?.id || null;

const isOwnedInstance = (service, orgId) => Boolean(orgId)
    && serviceKind(service) === 'instance'
    && serviceOwnerId(service) === orgId;

const canReadHealthcareService = (req, service) => {
    if (isSystemService(service)) return store.getAll('Contract').some(contract =>
        contract.topicReference?.reference === `HealthcareService/${service.id}`
        && canReadPolicy(store, loadTeamConfig(), contract, req.user));
    if (isPcmAdmin(req)) return true;
    if (serviceKind(service) && service.active === true && serviceBusinessStatus(service) === 'active') return true;
    return isOwnedInstance(service, req.user?.organization_id);
};

/**
 * Determine whether the caller is a PCM admin organization.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const isPcmAdmin = req => {
    const orgId = req.user?.organization_id;
    if (!orgId) return false;
    return organizationRole(store.get('Organization', orgId)) === PCM_ORG_TYPE_CODE;
};

const isSourceOrg = org => organizationRole(org) === 'source';

const isCallerConsentParty = (consent, callerOrgId) => {
    const actors = consent.provision?.actor || [];
    return actors.some(a => a.reference && (a.reference.reference === `Organization/${callerOrgId}` || a.reference.reference === callerOrgId));
};

const getCallerApprovedSourceAccess = callerOrgId => {
    reconcileExpiredConsents({ store });
    const allowedOrgIds = new Set();
    const allowedEndpointIds = new Set();

    store.getAll('Consent')
        .filter(consent => consentIsActive(consent) && isCallerConsentParty(consent, callerOrgId))
        .forEach(consent => {
            (consent.provision?.actor || [])
                .filter(actor => actor.role?.coding?.some(c => c.code === 'CST'))
                .forEach(actor => {
                    const orgId = getRefId(actor.reference?.reference);
                    if (!orgId) return;
                    allowedOrgIds.add(orgId);
                    const org = store.get('Organization', orgId);
                    (org?.endpoint || []).forEach(ep => {
                        const epId = getRefId(ep.reference);
                        if (epId) allowedEndpointIds.add(epId);
                    });
                });
        });

    return { allowedOrgIds, allowedEndpointIds };
};

const canReadOrganization = (req, org) => {
    if (isPcmAdmin(req)) return true;
    const callerOrgId = req.user?.organization_id;
    if (!callerOrgId) return false;
    if (org.id === callerOrgId) return true;
    if (!isSourceOrg(org)) return true;
    return getCallerApprovedSourceAccess(callerOrgId).allowedOrgIds.has(org.id);
};

const canReadEndpoint = (req, endpoint) => {
    if (isPcmAdmin(req)) return true;
    const callerOrgId = req.user?.organization_id;
    if (!callerOrgId) return false;
    const managingOrgId = getRefId(endpoint.managingOrganization?.reference);
    if (managingOrgId === callerOrgId) return true;
    const managingOrg = managingOrgId ? store.get('Organization', managingOrgId) : null;
    if (!isSourceOrg(managingOrg)) return true;
    return getCallerApprovedSourceAccess(callerOrgId).allowedEndpointIds.has(endpoint.id);
};

const canReadConsent = (req, consent) => {
    if (isPcmAdmin(req)) return true;
    const callerOrgId = req.user?.organization_id;
    return Boolean(callerOrgId) && isCallerConsentParty(consent, callerOrgId);
};

const canReadSearchResource = (req, resource) => {
    if (resource.resourceType === 'Contract') return canReadPolicy(store, loadTeamConfig(), resource, req.user);
    if (resource.resourceType === 'Organization') return canReadOrganization(req, resource);
    if (resource.resourceType === 'Endpoint') return canReadEndpoint(req, resource);
    if (resource.resourceType === 'HealthcareService') return canReadHealthcareService(req, resource);
    if (resource.resourceType === 'Consent') return canReadConsent(req, resource);
    return false;
};

/**
 * Enforce mTLS client authentication on FHIR endpoints.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireMtls = createPublicMtlsMiddleware({ kind: 'fhir' });

const isPcmFhirToken = (tokenData, audience, now = Math.floor(Date.now() / 1000)) => Boolean(
    tokenData
    && tokenData.kind === 'management'
    && tokenData.active !== false
    && tokenData.exp >= now
    && tokenData.aud === audience
);

/**
 * Validate bearer token and populate req.user.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
const requireBearer = (req, res, next) => {
    res.type('application/fhir+json');

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Missing Authorization Header' }] });
    }

    const token = authHeader.split(' ')[1];
    const tokenData = tokens.get(token);
    // Tokens are bound to the public logical FHIR endpoint. The request may
    // arrive through the private Compose hostname, which is transport only.
    const audience = getIssuer(req);

    if (!isPcmFhirToken(tokenData, audience)
        || !require('../grant-authority-state').sourceClientCredentialStillAllowed(tokenData, store, loadTeamConfig())) {
        return res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Invalid or Expired Token' }] });
    }

    req.user = tokenData;
    next();
};

router.use(requireMtls);

/**
 * SMART on FHIR Discovery Endpoint
 * GET /.well-known/smart-configuration
 */
router.get('/.well-known/smart-configuration', (req, res) => {
    res.json(getSmartConfiguration(req));
});

/**
 * CapabilityStatement Endpoint
 * GET /metadata
 */
let cachedCapabilityStatement = null;

/**
 * Load the CapabilityStatement example from docs (cached).
 * @returns {object|null}
 */
const loadCapabilityStatement = () => {
    if (cachedCapabilityStatement) return cachedCapabilityStatement;
    const candidates = [
        process.env.PCM_CAPABILITY_STATEMENT_PATH,
        path.join('/workspace', 'docs', 'FHIR-examples', 'CapabilityStatement-pcm-capabilitystatement.json'),
        path.join(path.resolve(__dirname, '..', '..', '..', '..'), 'docs', 'FHIR-examples', 'CapabilityStatement-pcm-capabilitystatement.json')
    ].filter(Boolean);
    for (const filePath of candidates) {
        try {
            cachedCapabilityStatement = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return cachedCapabilityStatement;
        } catch (err) { /* Try the next supported repository/container layout. */ }
    }
    logger.warn('Failed to load CapabilityStatement example, falling back to minimal statement', { candidates });
    return null;
};

router.get('/metadata', (req, res) => {
    const baseUrl = getIssuer(req);

    res.type('application/fhir+json');
    const statement = loadCapabilityStatement();

    if (statement) {
        const response = {
            ...statement,
            date: new Date().toISOString(),
            implementation: {
                ...statement.implementation,
                url: baseUrl
            }
        };
        return res.json(require('../public-fhir').publicDto(response));
    }

    return res.json({
        resourceType: 'CapabilityStatement',
        status: 'active',
        date: new Date().toISOString(),
        kind: 'instance',
        fhirVersion: '4.0.1',
        format: ['application/fhir+json'],
        software: {
            name: 'PCM Core Stub'
        },
        implementation: {
            description: 'PCM FHIR API (POC)',
            url: baseUrl
        },
        rest: [
            {
                mode: 'server',
                security: {
                    description: 'mTLS + OAuth2 bearer token (opaque)'
                },
                resource: [
                    { type: 'Organization' },
                    { type: 'Endpoint' },
                    { type: 'HealthcareService' },
                    { type: 'Consent' }
                ]
            }
        ]
    });
});

router.use(requireBearer);

/**
 * Enforce shared write-envelope rules before resource-specific authorization
 * and state rules. Both conformance profiles use the same closed DTO validator,
 * which returns a clone for downstream mutation isolation.
 */
const validateWrite = (resourceType, interaction) => (req, res, next) => {
    if (req.headers?.['if-match'] !== undefined) {
        return sendOutcome(res, 400, 'If-Match/version-aware updates are not supported', 'not-supported');
    }
    try {
        req.body = validateWriteRequest(req.body, {
            resourceType,
            interaction,
            id: req.params.id
        });
        return next();
    } catch (error) {
        return handleContractError(res, error);
    }
};

/** Ensure every FHIR-layer failure has a FHIR OperationOutcome body. */
router.use((req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = body => {
        try { body = require('../public-fhir').publicDto(body); } catch {
            res.status(503);
            return sendJson(operationOutcome('Public FHIR projection is unavailable; complete coordinated metadata migration.', 'processing'));
        }
        if (res.statusCode >= 400 && body?.resourceType !== 'OperationOutcome') {
            const diagnostics = body?.error || body?.message || `FHIR request failed with HTTP ${res.statusCode}`;
            return sendJson(operationOutcome(diagnostics, res.statusCode === 404 ? 'not-found' : 'processing'));
        }
        return sendJson(body);
    };
    next();
});

const runSearch = (req, res, resourceType) => {
    const raw = req.method === 'POST' ? req.body : req.query;
    const protocol = req.protocol || 'https';
    const host = req.get?.('host') || req.headers?.host || 'pcm.local';
    try {
        const bundle = executeSearch({
            store,
            type: resourceType,
            raw: raw || {},
            authorize: resource => canReadSearchResource(req, resource),
            baseUrl: getIssuer(req),
            callerKey: `${req.user?.client_id || ''}|${req.user?.organization_id || ''}`
        });
        return res.json(bundle);
    } catch (error) {
        if (error instanceof FHIRSearchError) return sendOutcome(res, 400, error.message, error.code);
        throw error;
    }
};

const handleParticipantError = (res, error) => {
    if (error instanceof ParticipantLifecycleError
        || error instanceof HealthcareServiceLifecycleError
        || error instanceof ConsentLifecycleError
        || error instanceof FHIRStoreError) {
        return sendOutcome(res, error.status, error.message, error.code);
    }
    throw error;
};

// --- Organization ---
const searchOrganizations = (req, res) => runSearch(req, res, 'Organization');

router.get('/Organization', searchOrganizations);
router.post('/Organization/_search', searchOrganizations);

router.post('/Organization', validateWrite('Organization', 'create'), (req, res) => {
    const caller = store.get('Organization', req.user?.organization_id);
    try {
        const created = createServiceProviderChild({ store, callerOrganization: caller, request: req.body });
        return sendResource(req, res, created, { status: 201, created: true });
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

const readOrganization = (req, res, head = false) => {
    const org = store.get('Organization', req.params.id);
    if (!org || !canReadOrganization(req, org)) return sendOutcome(res, 404, 'Organization not found', 'not-found');
    return sendResource(req, res, org, { head });
};

router.get('/Organization/:id', (req, res) => readOrganization(req, res));
router.head('/Organization/:id', (req, res) => readOrganization(req, res, true));

router.put('/Organization/:id', validateWrite('Organization', 'update'), (req, res) => {
    if (!isPcmAdmin(req) && (!req.user || req.user.organization_id !== req.params.id)) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Access denied' }] });
    }

    const existing = store.get('Organization', req.params.id);
    if (!existing) return sendOutcome(res, 404, 'Organization not found', 'not-found');

    try {
        const committed = replaceOrganization({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            existing,
            request: req.body,
            pcmAdmin: isPcmAdmin(req)
        });
        return sendResource(req, res, committed);
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

// --- Endpoint ---
const searchEndpoints = (req, res) => runSearch(req, res, 'Endpoint');

router.get('/Endpoint', searchEndpoints);
router.post('/Endpoint/_search', searchEndpoints);

router.post('/Endpoint', validateWrite('Endpoint', 'create'), (req, res) => {
    try {
        const created = createEndpoint({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            request: req.body, config: loadTeamConfig()
        });
        return sendResource(req, res, created, { status: 201, created: true });
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

const readEndpoint = (req, res, head = false) => {
    const ep = store.get('Endpoint', req.params.id);
    if (!ep || !canReadEndpoint(req, ep)) return sendOutcome(res, 404, 'Endpoint not found', 'not-found');
    return sendResource(req, res, ep, { head });
};

router.get('/Endpoint/:id', (req, res) => readEndpoint(req, res));
router.head('/Endpoint/:id', (req, res) => readEndpoint(req, res, true));

router.put('/Endpoint/:id', validateWrite('Endpoint', 'update'), (req, res) => {
    const existing = store.get('Endpoint', req.params.id);
    if (!existing) return sendOutcome(res, 404, 'Endpoint not found', 'not-found');

    try {
        const committed = replaceEndpoint({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            existing,
            request: req.body,
            pcmAdmin: isPcmAdmin(req)
        });
        return sendResource(req, res, committed);
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

/** Read-only Contract interactions share authorization-first opaque paging. */
router.get('/Contract', (req, res) => runSearch(req, res, 'Contract'));
router.post('/Contract/_search', (req, res) => runSearch(req, res, 'Contract'));
const readContract = (req, res, head = false) => {
    const contract = store.get('Contract', req.params.id);
    if (!contract || !canReadPolicy(store, loadTeamConfig(), contract, req.user)) return sendOutcome(res, 404, 'Contract not found', 'not-found');
    return sendResource(req, res, contract, { head });
};
router.get('/Contract/:id', (req, res) => readContract(req, res));
router.head('/Contract/:id', (req, res) => readContract(req, res, true));

// --- HealthcareService ---
const searchHealthcareServices = (req, res) => runSearch(req, res, 'HealthcareService');

router.get('/HealthcareService', searchHealthcareServices);
router.post('/HealthcareService/_search', searchHealthcareServices);

router.post('/HealthcareService', validateWrite('HealthcareService', 'create'), (req, res) => {
    try {
        const { instance } = registerHealthcareService({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            request: req.body, config: loadTeamConfig()
        });
        return sendResource(req, res, instance, { status: 201, created: true });
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

// Register the literal operation before the generic instance route.
// Express route strings treat "$" as a path-pattern metacharacter, so escape
// the literal FHIR operation name to keep it from falling through.
router.post('/HealthcareService/:id/\\$request-catalog-update', requestCatalogUpdate);

const readHealthcareService = (req, res, head = false) => {
    const svc = store.get('HealthcareService', req.params.id);
    if (!svc || !canReadHealthcareService(req, svc)) return sendOutcome(res, 404, 'HealthcareService not found', 'not-found');
    return sendResource(req, res, svc, { head });
};

router.get('/HealthcareService/:id', (req, res) => readHealthcareService(req, res));
router.head('/HealthcareService/:id', (req, res) => readHealthcareService(req, res, true));

function requestCatalogUpdate(req, res) {
    try {
        assertNoModifierExtensions(req.body, 'Parameters');
        const { receipt } = submitCatalogUpdate({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            targetId: req.params.id,
            body: req.body
        });
        res.type?.('application/fhir+json');
        return res.status(200).json(receipt);
    } catch (error) {
        if (error instanceof FHIRContractError) return handleContractError(res, error);
        return handleParticipantError(res, error);
    }
}

router.put('/HealthcareService/:id', validateWrite('HealthcareService', 'update'), (req, res) => {
    const existing = store.get('HealthcareService', req.params.id);
    if (!existing) return sendOutcome(res, 404, 'HealthcareService not found', 'not-found');
    try {
        const committed = transitionHealthcareService({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            existing,
            request: req.body,
            afterTransition: ({ service, nextStatus }) => reconcileConsentsForService({
                store,
                serviceId: service.id,
                serviceState: nextStatus
            })
        });
        return sendResource(req, res, committed);
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

// --- Consent ---
router.post('/Consent', validateWrite('Consent', 'create'), (req, res) => {
    try {
        const created = createConsent({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            request: req.body, config: loadTeamConfig()
        });
        return sendResource(req, res, created, { status: 201, created: true });
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

const searchConsents = (req, res) => {
    reconcileExpiredConsents({ store });
    return runSearch(req, res, 'Consent');
};

const readConsent = (req, res, head = false) => {
    reconcileExpiredConsents({ store });
    const consent = store.get('Consent', req.params.id);
    if (!consent) {
        return sendOutcome(res, 404, 'Consent not found', 'not-found');
    }

    if (isPcmAdmin(req)) {
        return sendResource(req, res, consent, { head });
    }

    const caller = req.user;
    if (!caller || !caller.organization_id) {
        return res.status(403).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: 'Unidentified Caller' }] });
    }
    const callerOrgId = caller.organization_id;

    const actors = consent.provision?.actor || [];
    const isParty = actors.some(a => a.reference && (a.reference.reference === `Organization/${callerOrgId}` || a.reference.reference === callerOrgId));

    if (!isParty) {
        console.warn(`[FHIR] Access Denied to Consent ${req.params.id} for Org ${callerOrgId}. Not a party.`);
        return sendOutcome(res, 404, 'Consent not found', 'not-found');
    }

    return sendResource(req, res, consent, { head });
};

router.get('/Consent', searchConsents);
router.post('/Consent/_search', searchConsents);
router.get('/Consent/:id', (req, res) => readConsent(req, res));
router.head('/Consent/:id', (req, res) => readConsent(req, res, true));

router.put('/Consent/:id', validateWrite('Consent', 'update'), (req, res) => {
    const existing = store.get('Consent', req.params.id);
    if (!existing) {
        return sendOutcome(res, 404, 'Consent not found', 'not-found');
    }

    try {
        const committed = cancelConsent({
            store,
            callerOrganization: store.get('Organization', req.user?.organization_id),
            consent: existing,
            request: req.body, config: loadTeamConfig()
        });
        return sendResource(req, res, committed);
    } catch (error) {
        return handleParticipantError(res, error);
    }
});

// The mounted FHIR surface is closed: every unregistered resource, operation,
// or method fails as FHIR and can never fall through to an HTML/JSON 404.
router.use((req, res) => sendOutcome(
    res,
    405,
    `FHIR interaction ${req.method} ${req.path} is not supported`,
    'not-supported'
));

router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof require('../public-fhir').PublicMetadataError) return sendOutcome(res, error.status, error.message, error.code);
    logger.error('FHIR interaction failed before a response was committed', {
        method: req.method,
        path: req.path,
        error
    });
    return sendOutcome(res, 500, 'FHIR interaction failed', 'exception');
});

router.fhirRouteDefinitions = FHIR_ROUTE_DEFINITIONS;

module.exports = router;
module.exports._test = { isPcmFhirToken };
