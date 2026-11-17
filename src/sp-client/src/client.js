
const { environmentEndpoints, pcmTransportUrl, PCM_PATH, tokenMaximumSeconds } = require('../../shared/pcm-environment');
/**
 * Service Provider client helpers for interacting with PCM and data sources.
 */
const axios = require('axios');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = crypto;

function loadOutboundGuard() {
    for (const candidate of [path.join(__dirname, '..', '..', 'shared', 'outbound-destination'), '/shared/outbound-destination']) {
        try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    throw new Error('shared outbound destination guard is unavailable');
}
const { guardedAxiosConfig, parseOutboundUrl } = loadOutboundGuard();

const logger = require('./logger');
const { createTraceContext, propagationHeaders, readHeader } = require('../../shared/trace-context');
const { certificateRolePath, loadEffectivePolicy, loadTeamConfig: readTeamConfig } = require('./team-config');
const {
    ExpiringTokenCache,
    buildTokenForm,
    clientConformanceInfo,
    createClientAssertion,
    effectiveManagementScope,
    validateTokenResponse
} = require('./oauth');
const {
    buildCatalogUpdateParameters,
    buildConsentDeactivate,
    buildConsentSubmit,
    buildEndpointWrite,
    buildExistingServiceRegistration,
    buildNewServiceRegistration,
    buildOrganizationCreate,
    buildServiceStatusUpdate,
    projectUpdate,
    validateAuthoritativeResource,
    validateCatalogUpdateResponse
} = require('./fhir-builders');
const {
    consentRecoverySearch,
    parseConsentSourceBundle,
    recoverConsentCandidates
} = require('./discovery');
const { planSourceAccess } = require('./data-source-access');
const { consumeAuthorizationCallback, createAuthorizationTransaction, validateSmartConfiguration } = require('./smart-authorization');

const {
    IDENTIFIER_SYSTEMS,
    OPERATIONAL,
    SCOPES
} = require('./constants');
const CERTS_DIR = process.env.CERTS_DIR || path.join(process.cwd(), 'certs');
const DEFAULT_OUTBOUND_TIMEOUT_MS = 15000;
const DEFAULT_DATA_SOURCE_TIMEOUT_MS = 12000;

function loadIdentityMappingHelpers() {
    const candidates = [
        ...(process.env.SHARED_IDENTITY_MAPPING_DIR ? [path.join(process.env.SHARED_IDENTITY_MAPPING_DIR, 'identity-mapping')] : []),
        path.join(__dirname, '..', '..', 'shared', 'identity-mapping'),
        '/shared/identity-mapping'
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch (err) { /* try next layout */ }
    }
    throw new Error('Unable to load shared identity mapping helpers');
}

const { parseBusinessIdentifier } = loadIdentityMappingHelpers();

function positiveIntEnv(name, fallback) {
    const configured = Number(process.env[name] || fallback);
    return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function outboundTimeoutMs() {
    return positiveIntEnv('SP_OUTBOUND_TIMEOUT_MS', DEFAULT_OUTBOUND_TIMEOUT_MS);
}

function dataSourceTimeoutMs() {
    return positiveIntEnv('SP_DATA_SOURCE_TIMEOUT_MS', DEFAULT_DATA_SOURCE_TIMEOUT_MS);
}

/**
 * Load an HTTPS agent for a specific identity based on local certs.
 * @param {string} identity
 * @param {boolean} rejectUnauthorized
 * @returns {import('https').Agent|null}
 */
function loadAgent(identity, rejectUnauthorized = loadEffectivePolicy().transport.serviceProviderToDataSource.verifyServerCertificate) {
    const participant = identity === 'untrusted' ? 'untrustedClient'
        : identity === 'hospital-b' ? 'hospitalBServiceProvider' : 'serviceProvider';
    const config = getTeamConfig();
    return new https.Agent({
        cert: fs.readFileSync(certificateRolePath(participant, 'mtls', 'cert', config)),
        key: fs.readFileSync(certificateRolePath(participant, 'mtls', 'key', config)),
        ca: fs.readFileSync(path.join(CERTS_DIR, config.certificates.rootCaCert)), rejectUnauthorized
    });
}

/**
 * Resolve the HTTPS agent for a given identity.
 * @param {string} identity
 * @returns {import('https').Agent}
 */
/** Reject caller typos instead of silently selecting a different participant. */
function assertKnownIdentity(identity) {
    if (!['hospital-a', 'hospital-b', 'untrusted', 'untrusted-assertion'].includes(identity)) throw new TypeError('Unknown Doctor identity');
}

function agentFor(identity) {
    assertKnownIdentity(identity);
    return loadAgent(identity);
}

function getTeamConfig() {
    return readTeamConfig() || {};
}

/** Apply the selected environment and sandbox identity gate to every token grant. */
function tokenValidationOptions(config = getTeamConfig()) {
    return { maximumLifetime: tokenMaximumSeconds(config),
        ...require('../../shared/identity-mapping').sandboxIdentityOptions(config) };
}

/** Keep logical OAuth URLs in metadata/assertions while using Compose transport internally. */
function backchannelEndpoint(logicalUrl) {
    return pcmTransportUrl(logicalUrl, getTeamConfig());
}

/** Resolve PCM's stable public FHIR identifier independently of transport. */
function logicalPcmFhirAudience(audience) {
    const config = getTeamConfig();
    if (audience === config.internalBaseUrls.pcmFhir) return environmentEndpoints(config.contract.environment).fhirBase;
    return audience;
}

function shouldVerifyDataSourceServer(sourceId) {
    const policy = loadEffectivePolicy();
    const managed = getTeamConfig().healthOrganizations.find(ho => ho.dataSourceOrganization?.id === sourceId);
    const policySourceId = managed?.id || sourceId;
    return policy.simulation.perSource[policySourceId]?.serverCertificateVerification
        ?? policy.transport.serviceProviderToDataSource.verifyServerCertificate;
}

function getConfiguredDataSources() {
    const config = getTeamConfig();
    const sources = config.healthOrganizations.map(ho => ({
        id: ho.dataSourceOrganization?.id,
        name: ho.name,
        endpoint: ho.endpoint,
        clientId: ho.clientId,
        businessIdentifier: ho.dataSourceOrganization?.businessIdentifier,
        pcmClientAuth: {
            clientId: ho.clientId,
            cert: ho.certificates?.gatewayAssertionCert,
            key: ho.certificates?.gatewayAssertionKey,
            mtlsCert: ho.certificates?.gatewayMtlsCert,
            mtlsKey: ho.certificates?.gatewayMtlsKey,
            assertionCertificates: { ES256: ho.certificates?.gatewayAssertionCert }
        },
        serverTrust: { mode: 'team-root-ca' }
    }));
    if (config.legacyDataSource?.enabled && config.organizations?.referenceDataSource) {
        sources.push({
            ...config.organizations.referenceDataSource,
            id: config.legacyDataSource.id,
            name: `${config.organizations.referenceDataSource.name || 'Legacy Node Data Source'} (compatibility)`,
            endpoint: config.legacyDataSource.internalFhirBaseUrl,
            serverTrust: { mode: 'team-root-ca' },
            compatibilityOnly: true
        });
    }
    // Custom sources coexist with the three managed HOs in current v3 teams.
    sources.push(...(config.organizations.dataSources || []));
    return sources.filter(source => source?.endpoint);
}

function findDataSourceByUrl(targetUrl) {
    const normalize = value => String(value || '').replace(/\/+$/, '');
    return getConfiguredDataSources().find(source => normalize(source.endpoint) === normalize(targetUrl)) || null;
}

function normalizeBaseUrl(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getPublicReferenceDataSourceUrl() {
    return getTeamConfig()?.publicBaseUrls?.referenceDataSource || '';
}

function resolveDataSourceRequestTarget(targetUrl) {
    const audienceUrl = String(targetUrl || getDsGatewayUrl());
    const publicReferenceUrl = normalizeBaseUrl(getPublicReferenceDataSourceUrl());
    const internalReferenceUrl = normalizeBaseUrl(getDsGatewayUrl());
    const shouldUseInternalReference =
        publicReferenceUrl &&
        internalReferenceUrl &&
        normalizeBaseUrl(audienceUrl) === publicReferenceUrl &&
        internalReferenceUrl !== publicReferenceUrl;

    return {
        audienceUrl,
        requestUrl: shouldUseInternalReference ? internalReferenceUrl : audienceUrl,
        usedInternalRoute: shouldUseInternalReference
    };
}

function certNameForIdentity(identity) {
    const role = identity === 'untrusted' ? 'untrustedClient' : identity === 'hospital-b' ? 'hospitalBServiceProvider' : 'serviceProvider';
    return getTeamConfig().certificateRoles[role].mtls.cert.replace(/\.(crt|pem)$/, '');
}

function tokenCacheKey(identity, audience, basis, requestedScope) {
    const config = getTeamConfig();
    return JSON.stringify([config.runtime?.revision || 0, require('../../shared/sandbox-grant-policy').clinicalGrantPolicy(config).grantFullClinicalAccess, config.conformance?.preset, config.contract.environment, getClientId(identity || 'hospital-a'),
        audience || config.contract.operational.fhirBase, basis || '', requestedScope || SCOPES.management]);
}

function isTokenExpiryResponse(errData = {}) {
    const failureIssue = errData.issue ? errData.issue[0]?.diagnostics : '';
    const errorText = `${errData.error || ''} ${errData.error_description || ''} ${failureIssue}`.toLowerCase();
    return errorText.includes('expired');
}

function isTimeoutError(err) {
    return err?.code === 'ECONNABORTED' || /\btimeout\b|timed out/i.test(err?.message || '');
}

function classifyOutboundError(err, options = {}) {
    const stage = options.stage || 'outbound request';
    const url = options.url || err?.config?.url || 'unknown URL';
    const timeout = options.timeout || err?.config?.timeout;
    const elapsed = err?.config?.metadata?.durationMs;
    const elapsedText = elapsed ? ` after ${elapsed}ms` : '';
    const timeoutText = timeout ? ` within ${timeout}ms` : '';

    if (err?.classification) return { code: err.classification, message: err.message };
    if (err instanceof TypeError && !err.response) {
        return { code: 'local_validation_error', message: `${stage} validation failed: ${err.message}` };
    }

    if (isTimeoutError(err)) {
        return {
            code: 'timeout',
            message: `${stage} timed out${elapsedText}${timeoutText}: ${url}`
        };
    }

    const status = err?.response?.status;
    if (status === 504) {
        return {
            code: 'gateway_timeout',
            message: `${stage} reached the data-source gateway but timed out upstream (HTTP 504): ${url}`
        };
    }
    if (status === 401 || status === 403) {
        return {
            code: 'authorization_failed',
            message: `${stage} was rejected by the target service (HTTP ${status}): ${url}`
        };
    }
    if (status) {
        return {
            code: 'http_error',
            message: `${stage} failed with HTTP ${status}: ${url}`
        };
    }

    return {
        code: 'network_error',
        message: `${stage} failed before receiving a response: ${err?.message || 'unknown error'}`
    };
}

function previewResponseBody(data) {
    try {
        return JSON.stringify(data).slice(0, 1000);
    } catch (err) {
        return String(data).slice(0, 1000);
    }
}

function validateObservationResponse(response, context = {}) {
    const data = response?.data;
    const resourceType = data?.resourceType;
    if (resourceType === 'Bundle' || resourceType === 'Observation'
        || context.requestOverride && typeof resourceType === 'string' && /^[A-Z][A-Za-z0-9]+$/.test(resourceType)) return data;

    const contentType = response?.headers?.['content-type'] || response?.headers?.['Content-Type'];
    const err = new Error(`Data Source ${context.requestOverride ? 'FHIR GET' : 'Observation'} fetch returned an unexpected successful response: ${resourceType || 'missing FHIR resourceType'}`);
    err.classification = 'unexpected_response';
    err.response = response;

    logger.warn('Data Fetch Unexpected Response', {
        type: 'DATA_FETCH_UNEXPECTED_RESPONSE',
        classification: err.classification,
        targetUrl: context.targetUrl,
        requestUrl: context.requestUrl,
        consentId: context.consentId,
        identity: context.identity,
        status: response?.status,
        contentType,
        resourceType,
        bodyPreview: previewResponseBody(data)
    });
    throw err;
}

/**
 * Build transport options for a data source URL. HTTP endpoints use plain HTTP;
 * HTTPS endpoints make the SP certificate available if the server requests mTLS.
 * @param {string} identity
 * @param {string} targetUrl
 * @returns {object}
 */
function dataSourceTransportOptions(identity, targetUrl, lookupUrl = targetUrl) {
    if (!targetUrl || !targetUrl.startsWith('https:')) return {};
    const source = findDataSourceByUrl(lookupUrl);
    const verifyServer = shouldVerifyDataSourceServer(source?.id);
    const trust = source?.serverTrust || {};
    const mode = trust.mode || 'team-root-ca';
    const agent = loadDataSourceAgent(identity, verifyServer, mode, trust);
    return agent ? { httpsAgent: agent } : {};
}

function loadDataSourceAgent(identity, rejectUnauthorized, trustMode, trust = {}) {
    try {
        const transport = agentFor(identity).options;
        const options = { cert: transport.cert, key: transport.key,
            ...require('../../shared/source-server-trust').sourceServerTls({ trust: { ...trust, mode: trustMode }, certsDir: CERTS_DIR,
                rootCaCert: getTeamConfig().certificates.rootCaCert, verify: rejectUnauthorized }) };
        return new https.Agent(options);
    } catch (e) {
        console.error(`Failed to load data source agent for ${identity}:`, e.message);
        return null;
    }
}

/**
 * Resolve the OAuth2 client id for a given identity.
 * @param {string} identity
 * @returns {string}
 */
function getClientId(identity) {
    assertKnownIdentity(identity);
    const config = getTeamConfig();
    const clientIds = {
        'hospital-a': config?.organizations?.serviceProvider?.clientId || 'pcm-sp-local-0001',
        'hospital-b': config?.organizations?.hospitalBServiceProvider?.clientId || 'pcm-sp-local-0002',
        'untrusted': config?.organizations?.untrustedClient?.clientId || 'pcm-negative-client-0001'
    };
    return clientIds[identity === 'untrusted-assertion' ? 'hospital-a' : identity];
}

function getOrganizationId(identity) {
    assertKnownIdentity(identity);
    const config = getTeamConfig();
    const organizationIds = {
        'hospital-a': config?.organizations?.serviceProvider?.id || 'org-sp',
        'hospital-b': config?.organizations?.hospitalBServiceProvider?.id || 'org-hospital-b-sp',
        'untrusted': config?.organizations?.untrustedClient?.organizationId || 'untrusted-client'
    };
    return organizationIds[identity === 'untrusted-assertion' ? 'hospital-a' : identity];
}

/** Resolve the stable requester business identifier for diagnostics. */
function getOrganizationBusinessIdentifier(identity) {
    const config = readTeamConfig();
    const organization = identity === 'hospital-b'
        ? config?.organizations?.hospitalBServiceProvider
        : config?.organizations?.serviceProvider;
    return organization?.businessIdentifier || {
        system: IDENTIFIER_SYSTEMS.organization,
        value: identity === 'hospital-b' ? 'PCM-ORG-SP-0002' : 'PCM-ORG-SP-0001'
    };
}

/**
 * Load the private key used to sign client_assertion JWTs.
 * @param {string} identity
 * @returns {Buffer}
 */
function getPrivateKey(identity) {
    assertKnownIdentity(identity);
    if (identity === 'untrusted' || identity === 'untrusted-assertion') {
        const filename = getTeamConfig().certificateRoles.untrustedClient.assertion?.key || 'untrusted-client-assertion.key';
        const keyPath = path.join(CERTS_DIR, filename);
        if (!fs.existsSync(keyPath)) throw new Error('Negative-test P-256 assertion key is missing. Run generate-team-certs.js explicitly for this team; existing certificate pairs are preserved.');
        const key = fs.readFileSync(keyPath);
        const parsed = crypto.createPrivateKey(key);
        if (parsed.asymmetricKeyType !== 'ec' || parsed.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Negative-test assertion key must be P-256; transport keys cannot sign ES256 assertions.');
        return key;
    }
    const participant = identity === 'hospital-b' ? 'hospitalBServiceProvider' : 'serviceProvider';
    return fs.readFileSync(certificateRolePath(participant, 'assertion', 'key', getTeamConfig()));
}


// --- Logic ---

// PCM API is HTTPS. Data source URLs keep their configured scheme from PCM.
function getPcmFhirUrl() {
    return (process.env.PCM_FHIR_URL || getTeamConfig()?.internalBaseUrls?.pcmFhir || `https://pcm-core:3000${PCM_PATH}`).replace('http:', 'https:');
}

function getDsGatewayUrl() {
    return process.env.DS_GATEWAY_URL || getTeamConfig()?.internalBaseUrls?.referenceDataSource || 'https://ds-gateway:8080/fhir';
}

// Add request logging
axios.interceptors.request.use(async request => {
    const target = new URL(request.url, request.baseURL).toString();
    parseOutboundUrl(target);
    Object.assign(request, guardedAxiosConfig(request));
    request.maxRedirects = 0;
    request.metadata = request.metadata || {};
    request.metadata.correlationId = request.metadata.correlationId
        || request.headers?.['x-correlation-id']
        || request.headers?.['X-Correlation-Id']
        || uuidv4();
    request.metadata.flowId = request.metadata.flowId
        || request.headers?.['x-flow-id']
        || request.headers?.['X-Flow-Id']
        || logger.getFlowId();
    request.metadata.startedAt = Date.now();
    // Only an attempted HTTP call creates a client span; cached preparation does not.
    request.metadata.trace = createTraceContext(readHeader(request.headers, 'traceparent') || logger.getPropagationHeaders().traceparent);
    for (const [name, value] of Object.entries(propagationHeaders(request.metadata.trace))) {
        if (typeof request.headers?.set === 'function') request.headers.set(name, value);
        else {
            request.headers ||= {};
            for (const key of Object.keys(request.headers)) if (key.toLowerCase() === name) delete request.headers[key];
            request.headers[name] = value;
        }
    }
    if (!request.timeout) request.timeout = outboundTimeoutMs();
    request.headers = request.headers || {};
    if (!request.headers['x-correlation-id'] && !request.headers['X-Correlation-Id']) {
        request.headers['x-correlation-id'] = request.metadata.correlationId;
    }
    if (request.metadata.flowId && !request.headers['x-flow-id'] && !request.headers['X-Flow-Id']) {
        request.headers['x-flow-id'] = request.metadata.flowId;
    }
    logger.info(`Request Sent: ${request.method.toUpperCase()} ${request.url}`, {
        type: 'OUTGOING_REQUEST',
        ...request.metadata.trace,
        correlationId: request.metadata.correlationId,
        ...(request.metadata.flowId ? { flowId: request.metadata.flowId } : {}),
        category: 'system',
        visibility: 'default',
        causesSystemFlow: true,
        method: request.method,
        url: request.url,
        timeoutMs: request.timeout,
        headers: request.headers,
        data: request.data
    });
    return request;
});

axios.interceptors.response.use(response => {
    const method = response.config.method?.toUpperCase() || 'GET';
    const durationMs = Date.now() - (response.config.metadata?.startedAt || Date.now());
    response.config.metadata.durationMs = durationMs;
    logger.info(`Response Received: ${response.status} ${method} ${response.config.url}`, {
        type: 'OUTGOING_RESPONSE',
        ...response.config.metadata?.trace,
        correlationId: response.config.metadata?.correlationId,
        ...(response.config.metadata?.flowId ? { flowId: response.config.metadata.flowId } : {}),
        category: 'system',
        visibility: 'default',
        causesSystemFlow: true,
        method: response.config.method,
        status: response.status,
        url: response.config.url,
        durationMs,
        data: response.data
    });
    return response;
}, error => {
    const durationMs = error.config?.metadata?.startedAt ? Date.now() - error.config.metadata.startedAt : undefined;
    if (error.config?.metadata && durationMs !== undefined) error.config.metadata.durationMs = durationMs;
    if (error.response) {
        const method = error.config?.method?.toUpperCase() || '';
        logger.error(`Response Error: ${error.response.status} ${method} ${error.config?.url}`, {
            type: 'OUTGOING_ERROR',
            ...error.config?.metadata?.trace,
            correlationId: error.config?.metadata?.correlationId,
            ...(error.config?.metadata?.flowId ? { flowId: error.config.metadata.flowId } : {}),
            category: 'system',
            visibility: 'default',
            causesSystemFlow: true,
            method: error.config?.method,
            status: error.response.status,
            url: error.config?.url,
            durationMs,
            data: error.response.data
        });

        // Token Refresh Logic
        // If 401 and not already retried
        if (error.response.status === 401 && !error.config._retry) {
            const errData = error.response.data || {};
            const failureIssue = errData.issue ? errData.issue[0]?.diagnostics : '';
            const isExpired = isTokenExpiryResponse(errData);

            if (!isExpired) {
                console.warn('[Client] 401 is not token expiry:', failureIssue || errData.error_description || errData.error || 'unauthorized');
            } else {
                console.log('[Client] 401 status detected. Assuming Token Expired. Retrying...');
                resetCache();

                // Throw specific error for wrapper to catch
                const err = new Error('Token Expired');
                err.isTokenExpired = true;
                throw err;
            }
        }
    } else {
        const method = error.config?.method?.toUpperCase() || '';
        logger.error(`Request Failed: ${method} ${error.config?.url || ''} ${error.message}`.trim(), {
            type: 'OUTGOING_ERROR',
            ...error.config?.metadata?.trace,
            correlationId: error.config?.metadata?.correlationId,
            ...(error.config?.metadata?.flowId ? { flowId: error.config.metadata.flowId } : {}),
            category: 'system',
            visibility: 'default',
            causesSystemFlow: true,
            method: error.config?.method,
            url: error.config?.url,
            durationMs,
            message: error.message
        });
    }
    return Promise.reject(error);
});


/**
 * Create a private_key_jwt client_assertion for PCM /token.
 * @param {string} identity
 * @param {string|undefined|null} consentId
 * @param {string} audience
 * @returns {string}
 */
function generateClientAssertion(identity, consentId, audience) {
    const clientId = getClientId(identity);
    const key = getPrivateKey(identity);
    return createClientAssertion({
        clientId,
        privateKey: key,
        audience,
        cnfThumbprint: require('../../shared/assertion-keys').certificateConfirmation(agentFor(identity).options.cert)['x5t#S256']
    });
}

// Token Cache
const tokens = new ExpiringTokenCache();
const smartConfigByBase = new Map();

/**
 * Discover SMART configuration from PCM FHIR base (cached).
 * @param {string} fhirBaseUrl
 * @returns {Promise<object>}
 */
async function getSmartConfiguration(fhirBaseUrl) {
    const expectedIssuer = environmentEndpoints(getTeamConfig().contract.environment).oauthBase;
    const cached = smartConfigByBase.get(fhirBaseUrl);
    if (cached?.issuer === expectedIssuer) return cached;
    smartConfigByBase.delete(fhirBaseUrl);
    let discoveryResponse;
    try {
        console.log(`[Client] Discovering SMART Config at ${fhirBaseUrl}/.well-known/smart-configuration`);
        // We use the same agent/identity context? Generally ID-agnostic public endpoint.
        const agent = agentFor('hospital-a'); // Just need mTLS connectivity
        discoveryResponse = await axios.get(`${fhirBaseUrl}/.well-known/smart-configuration`, {
            httpsAgent: agent
        });
        const validated = validateSmartConfiguration(discoveryResponse.data, { expectedIssuer });
        smartConfigByBase.set(fhirBaseUrl, validated);
        console.log('[Client] Discovery Successful:', validated);
        return validated;
    } catch (err) {
        console.warn('[Client] Discovery Failed:', err.message);
        if (discoveryResponse) err.classification = 'invalid_discovery_response';
        err.message = `SMART discovery failed closed: ${err.message}`;
        throw err;
    }
}

/**
 * Get an access token for a target resource server, cached by identity/audience.
 * @param {string} audience
 * @param {string} identity
 * @param {string|undefined|null} consentId
 * @param {string|undefined|null} requestedScope
 * @param {string|undefined} contractIdentifier Sampling Contract business identifier.
 * @param {object|null} clinicalRequest Opt in to detached validated grant/receipt metadata.
 * @returns {Promise<string|object>} Opaque token, or token plus validated clinical grant.
 */
async function getToken(audience, identity, consentId, requestedScope, contractIdentifier, clinicalRequest = null) {
    if (consentId && contractIdentifier) throw new TypeError('Exactly one authorization basis is required');
    const aud = audience || getPcmFhirUrl(); // Assume Default pcm-core
    const tokenResource = logicalPcmFhirAudience(aud);
    const currentIdentity = identity || 'hospital-a';

    const approvedConsent = consentId ? await checkConsentStatus(consentId, currentIdentity) : null;
    let service;
    if (consentId) {
        const reference = approvedConsent?.extension?.find(value => value.url === require('./constants').EXTENSIONS.pcmService)?.valueReference?.reference;
        const serviceId = /^HealthcareService\/([A-Za-z0-9.-]{1,64})$/.exec(reference || '')?.[1];
        if (approvedConsent?.status !== 'active' || !serviceId) throw new TypeError('An active public Consent with an exact service association is required.');
        if (clinicalRequest?.expectedContext && (clinicalRequest.expectedContext !== require('./consent-refresh').permissionSignature(approvedConsent)
            || clinicalRequest.expectedSources !== require('./consent-refresh').sourceSignature(approvedConsent))) throw new TypeError('Public Consent/Patient/service/source context changed during token preparation; Check / Discover before fetching.');
        require('./permission-plan').validateSelection(requestedScope);
        service = await readOwnedService(serviceId, currentIdentity);
        if (!service.available) throw new TypeError(service.readiness + '; clinical access is unavailable.');
    }
    const authorizationDetails = contractIdentifier
        ? require('../../shared/data-authorization-details').contractAuthorizationDetails(contractIdentifier)
        : consentId
        ? require('../../shared/data-authorization-details').consentAuthorizationDetails(approvedConsent)
        : undefined;
    const basis = authorizationDetails?.[0].fhirContext[0].identifier;
    const cacheKey = tokenCacheKey(currentIdentity, tokenResource, basis ? `${basis.system}|${basis.value}` + (consentId ? JSON.stringify([require('./consent-refresh').permissionSignature(approvedConsent), require('./consent-refresh').sourceSignature(approvedConsent), service.signature]) : '') : null, requestedScope);

    const result = (token, response) => {
        const cachedRecord = tokens.records.get(cacheKey);
        if (cachedRecord && consentId) cachedRecord.publicBinding ||= { context: require('./consent-refresh').permissionSignature(approvedConsent), sources: require('./consent-refresh').sourceSignature(approvedConsent), service: service.signature, consentId, consent: structuredClone(approvedConsent), instance: structuredClone(service.instance) };
        const grant = consentId ? { ...require('./permission-plan').validateClinicalGrant(response, approvedConsent, service.instance, tokenValidationOptions()),
            ...tokens.metadata(cacheKey), audience: tokenResource, clientId: getClientId(currentIdentity), consentId,
            context: require('./consent-refresh').permissionSignature(approvedConsent), sourceContext: require('./consent-refresh').sourceSignature(approvedConsent), serviceSignature: service.signature } : null;
        return clinicalRequest ? { token, grant, isInvalidated: () => cachedRecord?.invalid === true } : token;
    };
    const cached = tokens.get(cacheKey);
    if (cached) return result(cached, tokens.details(cacheKey));

    let tokenResponse, receivedAt;
    try {
        const config = await getSmartConfiguration(getPcmFhirUrl());
        const tokenEndpoint = config.token_endpoint;
        const assertion = generateClientAssertion(currentIdentity, consentId, tokenEndpoint);
        const agent = agentFor(currentIdentity);
        const requested = requestedScope || SCOPES.management;
        const scope = requested === SCOPES.management || requested === SCOPES.legacyManagement
            ? effectiveManagementScope(loadEffectivePolicy(), requested)
            : requested;
        const body = buildTokenForm({ assertion, scope, resource: tokenResource, authorizationDetails }).toString();

        tokenResponse = await axios.post(backchannelEndpoint(tokenEndpoint), body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: agent,
            timeout: outboundTimeoutMs()
        });

        receivedAt = Date.now();
        if ((consentId || contractIdentifier) && !tokenResponse.data?.authorization_details) throw new TypeError('PCM data token omitted its effective authorization details');
        if (contractIdentifier) {
            const effective = require('../../shared/data-authorization-details').validateDataAuthorizationDetails(tokenResponse.data.authorization_details, tokenValidationOptions());
            const definition = require('../../shared/service-catalog').loadServiceCatalog(getTeamConfig(), { validateClinicalDefinitions: false }).sandboxSampling;
            if (effective.scenario !== 'sandbox-patient-sample' || effective.basis.identifier.value !== contractIdentifier
                || effective.service.identifier.value !== definition.serviceIdentifier || tokenResponse.data.scope !== 'system/Patient.s') {
                throw new TypeError('Unexpected effective sampling grant');
            }
        }
        // Validate the complete response before cache admission; never decode the opaque token.
        validateTokenResponse(tokenResponse.data, tokenValidationOptions());
        // Check public grant binding before admitting a credential to the cache.
        if (consentId) require('./permission-plan').validateClinicalGrant(tokenResponse.data, approvedConsent, service.instance, tokenValidationOptions());
        tokens.put(cacheKey, tokenResponse.data, tokenValidationOptions(), receivedAt);
        // Bind opaque credentials to discovery validated at acquisition, not later configuration.
        tokens.records.get(cacheKey).issuer = config.issuer;
        return result(tokenResponse.data.access_token, tokenResponse.data);
    } catch (err) {
        console.error(`Failed to get token for ${aud} as ${currentIdentity}`, err.response?.data || err.message);
        if (tokenResponse) {
            err.classification = 'invalid_token_response';
            err.message = `PCM token response validation failed (HTTP ${tokenResponse.status}): ${err.message}`;
        } else if (err.response?.data?.error_description) {
            err.message = err.response.data.error_description;
            err.classification = classifyOutboundError(err).code;
        } else if (err.response?.data?.error) {
            err.message = err.response.data.error;
            err.classification = classifyOutboundError(err).code;
        } else {
            const classified = classifyOutboundError(err, { stage: 'PCM token request', url: err.config?.url || aud });
            err.message = classified.message;
            err.classification = classified.code;
        }
        throw err;
    }
}

async function beginSmartAuthorization({ identity = 'hospital-a', redirectUri, scope = 'patient/*.rs', browserRequest } = {}) {
    const organization = identity === 'hospital-b'
        ? getTeamConfig()?.organizations?.hospitalBServiceProvider
        : getTeamConfig()?.organizations?.serviceProvider;
    const exactRedirect = require('../../shared/doctor-browser-address').selectDoctorCallback(getTeamConfig(), organization, browserRequest);
    if (redirectUri && redirectUri !== exactRedirect) throw new Error('Requested callback does not match this browser’s exact registered callback');
    if (!exactRedirect) throw new Error('No registered SMART redirect URI is configured');
    const smart = await getSmartConfiguration(getPcmFhirUrl());
    if (!smart.authorization_endpoint) throw new Error('SMART discovery has no authorization_endpoint');
    return createAuthorizationTransaction({
        authorizationEndpoint: require('../../shared/browser-navigation').browserDestination(pcmTransportUrl(smart.authorization_endpoint, getTeamConfig(), { browser: true }), browserRequest),
        clientId: getClientId(identity),
        redirectUri: exactRedirect,
        audience: smart.issuer,
        scope
    });
}

async function exchangeSmartAuthorization(transaction, query, identity = 'hospital-a') {
    const config = getTeamConfig();
    const organization = config.organizations[identity === 'hospital-b' ? 'hospitalBServiceProvider' : 'serviceProvider'];
    if (transaction?.clientId !== getClientId(identity) || !require('../../shared/doctor-browser-address').registeredCallbacks(organization).includes(transaction?.redirectUri)) throw new Error('SMART registration changed. Restart this test at the configured Doctor address.');
    const callback = consumeAuthorizationCallback(transaction, query);
    const smart = await getSmartConfiguration(getPcmFhirUrl());
    if (callback.audience !== smart.issuer) throw new Error('SMART audience changed. Restart this test.');
    const assertion = generateClientAssertion(identity, null, smart.token_endpoint);
    const form = buildTokenForm({
        grantType: 'authorization_code',
        assertion,
        code: callback.code,
        redirectUri: callback.redirectUri,
        codeVerifier: callback.verifier
    });
    const response = await axios.post(backchannelEndpoint(smart.token_endpoint), form.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        httpsAgent: agentFor(identity),
        timeout: outboundTimeoutMs()
    });
    return validateTokenResponse(response.data, tokenValidationOptions());
}

/**
 * Wrap calls to automatically retry on token-expired errors.
 * @param {Function} fn
 * @returns {Promise<any>}
 */
async function withRetry(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err.isTokenExpired) {
            console.log('Token expired error caught. Retrying...');
            // Cache is already reset by interceptor
            return await fn();
        }
        throw err;
    }
}

function buildConsentRequestBody(patientId, serviceId, identityOptions = {}) {
    const patientIdentifier = parseBusinessIdentifier(patientId);
    if (!patientIdentifier) {
        throw new Error('Patient business identifier is required');
    }
    return buildConsentSubmit(patientIdentifier, serviceId, identityOptions);
}

/**
 * Create a new Consent request for a patient and service.
 * @param {string} patientId
 * @param {string} serviceId
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function createConsentRequest(patientId, serviceId, identity) {
    const patientIdentifier = parseBusinessIdentifier(patientId);
    const request = buildConsentSubmit(patientIdentifier, serviceId, require('../../shared/identity-mapping').sandboxIdentityOptions(getTeamConfig()));
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const pcmResource = getPcmFhirUrl();
        const token = await getToken(pcmResource, currentIdentity);
        try {
            const res = await axios.post(`${pcmResource}/Consent`, request, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/fhir+json',
                    'Accept': 'application/fhir+json'
                },
                httpsAgent: agentFor(currentIdentity)
            });
            const consent = validateAuthoritativeResource(res.data, 'Consent');
            logger.info(`Consent Created: ${consent.id}`, { identity: currentIdentity });
            return consent;
        } catch (error) {
            if (error.response || error.isTokenExpired) throw error;
            const query = consentRecoverySearch({ patientIdentifier, serviceId });
            let recovery;
            let recoveryToken = token;
            const search = () => axios.get(`${pcmResource}/Consent?${query}`, {
                headers: { 'Authorization': `Bearer ${recoveryToken}`, 'Accept': 'application/fhir+json' },
                httpsAgent: agentFor(currentIdentity)
            });
            try {
                try {
                    recovery = await search();
                } catch (searchError) {
                    if (!searchError.isTokenExpired) throw searchError;
                    // Refresh only the idempotent search. Re-entering the outer
                    // wrapper here could repeat the uncertain Consent POST.
                    recoveryToken = await getToken(pcmResource, currentIdentity);
                    recovery = await search();
                }
            } catch (searchError) {
                const uncertain = new Error('Consent create outcome is uncertain and exact recovery search failed; no blind retry was attempted');
                uncertain.cause = error;
                uncertain.recoveryCause = searchError;
                uncertain.classification = 'uncertain_create';
                uncertain.candidates = [];
                throw uncertain;
            }
            const candidates = recoverConsentCandidates(recovery.data, { patientIdentifier, serviceId });
            if (candidates.length === 1) return validateAuthoritativeResource(candidates[0], 'Consent');
            const uncertain = new Error(candidates.length
                ? 'Consent create outcome is ambiguous; multiple matching resources require reconciliation'
                : 'Consent create outcome is uncertain and recovery search found no match; no blind retry was attempted');
            uncertain.cause = error;
            uncertain.classification = 'uncertain_create';
            uncertain.candidates = candidates;
            throw uncertain;
        }
    });
}

/**
 * Fetch a consent by id and expand related actors/endpoints.
 * @param {string} consentId
 * @param {string} identity
 * @returns {Promise<object|null>}
 */
async function checkConsentStatus(consentId, identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const pcmResource = getPcmFhirUrl();
        const token = await getToken(pcmResource, currentIdentity);

        const query = `_id=${consentId}&_include=Consent:actor&_include:iterate=Organization:endpoint&_include:iterate=Organization:partof`;
        const res = await axios.get(`${pcmResource}/Consent?${query}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });

        const bundle = res.data;
        if (!bundle || bundle.resourceType !== 'Bundle') {
            return null;
        }

        const parsed = parseConsentSourceBundle(bundle, consentId);
        if (!parsed) return null;
        const consent = validateAuthoritativeResource(parsed.consent, 'Consent');
        consent.discoveredEndpoints = parsed.discoveredEndpoints;
        if (parsed.discoveredEndpoints.length) consent.discoveredEndpoint = parsed.discoveredEndpoints[0].url;
        return consent;
    });
}

/** Bind ordinary service reads to one explicit registered provider and configuration. */
async function serviceReader(identity, signal) {
    const directory = require('./service-directory'), config = readTeamConfig(), role = directory.providerRole(identity);
    if (!role || !config.organizations[role]) throw new Error('Services unavailable: this diagnostic identity is not a registered provider');
    const stamp = JSON.stringify(config), token = await getToken(getPcmFhirUrl(), identity);
    if (signal?.aborted || JSON.stringify(readTeamConfig()) !== stamp) throw new Error('Service load superseded');
    const base = getPcmFhirUrl(), agent = agentFor(identity);
    return { providerId: config.organizations[role].id, logicalBase: config.contract.operational.fhirBase,
        client: async ({ type, id, page, signal: requestSignal, maxBytes }) => {
            const suffix = id ? `/${encodeURIComponent(id)}` : page ? new URL(page).search : '';
            const result = await axios.get(`${base}/${type}${suffix}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
                httpsAgent: agent, signal: requestSignal, timeout: Math.min(outboundTimeoutMs(), 10000), maxContentLength: maxBytes, maxRedirects: 0 });
            if (JSON.stringify(readTeamConfig()) !== stamp) throw new Error('Service load superseded by configuration change');
            return result.data;
        } };
}
/** Load one ordinary service page, without scanning hidden pages or changing caller/query identity. */
async function searchServices(identity = 'hospital-a', options = {}) {
    return require('./service-directory').loadServicesPage({ ...await serviceReader(identity, options.signal), ...options });
}
/** Revalidate the actual owned instance and visible definition before any new action. */
async function readOwnedService(id, identity = 'hospital-a', options = {}) {
    return require('./service-directory').readOwnedService({ ...await serviceReader(identity, options.signal), id, ...options });
}
const { projectOwnedServices } = require('./service-directory');

/**
 * Search for consents visible to the current identity.
 * @param {string} identity
 * @returns {Promise<object[]>}
 */
async function searchConsents(identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const pcmResource = getPcmFhirUrl();
        const token = await getToken(pcmResource, currentIdentity);

        // Server-side FHIR authorization limits this search to consents visible
        // to the caller, so the client intentionally uses a plain search.
        const res = await axios.get(`${pcmResource}/Consent`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });

        const bundle = res.data;
        if (!bundle || bundle.resourceType !== 'Bundle') return [];
        return bundle.entry ? bundle.entry.map(e => e.resource).filter(r => r.resourceType === 'Consent') : [];
    });
}

/**
 * Fetch generated first-page searches or one exact GET using a validated public token grant.
 * @param {string} consentId
 * @param {string} dataSourceUrl
 * @param {string} identity Registered requesting application.
 * @param {string} requestedScope Explicit query resource/action subset.
 * @param {string} fhirGetRequest Optional exact slash-prefixed path/query instead of generated searches.
 * @returns {Promise<object>} FHIR response or first-page evidence with actual actions and grant metadata.
 */
async function fetchData(consentId, dataSourceUrl, identity, requestedScope, fhirGetRequest = '') {
    const requestOverride = require('./clinical-fetch-query').validateGetRequestOverride(fhirGetRequest);
    if (typeof requestedScope !== 'string' || !requestedScope.trim()) throw new Error('Explicit FHIR query actions are required; unresolved services have no Observation fallback');
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const targetUrl = dataSourceUrl || getDsGatewayUrl();
        const route = resolveDataSourceRequestTarget(targetUrl);

        const audience = route.audienceUrl;
        const observationUrl = normalizeBaseUrl(route.requestUrl);

        let stage = 'PCM token request', clinicalGrant, invalidated = () => false;
        try {
            // Preparation failures must be visible even when no source request can be sent.
            const consent = await checkConsentStatus(consentId, currentIdentity);
            if (consent?.status !== 'active') throw new Error('An active Consent is required; refresh its recorded status in PCM.');
            require('./permission-plan').validateSelection(requestedScope);
            const consentPatient = consent.patient?.identifier;
            const identityOptions = require('../../shared/identity-mapping').sandboxIdentityOptions(getTeamConfig());
            const { token, grant, isInvalidated } = await getToken(audience, currentIdentity, consentId, requestedScope, undefined, { expectedContext: require('./consent-refresh').permissionSignature(consent), expectedSources: require('./consent-refresh').sourceSignature(consent) });
            clinicalGrant = grant; invalidated = isInvalidated;
            // Custom requests retain the validated grant; the source decides path/query authority.
            const plan = requestOverride ? { searches: [{ type: 'FHIR', method: 'GET', path: requestOverride }], skipped: [] }
                : require('./permission-plan').planQueries(grant.summary, requestedScope);
            if (!plan.searches.length) throw Object.assign(new Error(plan.skipped.map(value => value.message).join(' ')), { classification: plan.skipped.some(value => value.outcome === 'skipped-read-only') ? 'read_only_limitation' : 'query_not_granted', grant });
            const types = plan.searches.map(value => value.type);
            stage = 'Data Source fetch';
            const startedAt = Date.now();
            const pages = [], failures = [];
            for (const type of types) {
                if (invalidated()) throw Object.assign(new Error('This token was authoritatively invalidated during retrieval.'), { classification: 'invalid_token_state' });
                if (grant.expiresAt <= Date.now()) throw Object.assign(new Error('Token expired during retrieval; current authority and results were cleared.'), { classification: 'expired_token' });
                try {
                    const path = requestOverride || '/' + require('./clinical-fetch-query').clinicalFetchQuery(type, consentPatient, identityOptions);
                    const res = await axios.get(`${normalizeBaseUrl(route.requestUrl)}${path}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/fhir+json'
                        },
                        timeout: dataSourceTimeoutMs(),
                        ...(requestOverride ? { maxRedirects: 0 } : {}),
                        ...dataSourceTransportOptions(currentIdentity, route.requestUrl, route.audienceUrl)
                    });
                    const data = validateObservationResponse(res, {
                        requestOverride,
                        targetUrl: route.audienceUrl,
                        requestUrl: route.requestUrl,
                        consentId,
                        identity: currentIdentity
                    });
                    pages.push({ type, bundle: data });
                } catch (error) {
                    failures.push(require('./clinical-preview').failureEvidence(type, error));
                    if (types.length === 1) throw error;
                }
            }
            if (invalidated()) throw Object.assign(new Error('This token was authoritatively invalidated during retrieval.'), { classification: 'invalid_token_state' });
            if (grant.expiresAt <= Date.now()) throw Object.assign(new Error('Token expired during retrieval; current authority and results were cleared.'), { classification: 'expired_token' });
            if (!pages.length) throw Object.assign(new Error('No resource query succeeded; review authorization and source availability, then retry.'), { classification: failures.every(failure => failure.outcome === 'denied') ? 'denied' : 'unavailable' });
            // Preserve count Bundles, direct reads and other FHIR responses without preview filtering.
            const data = requestOverride ? { ...pages[0].bundle, preview: { source: audience, requestOverride } }
                : require('./clinical-preview').combinePreview(pages, audience, failures);
            data.preview.skipped = plan.skipped;
            data.preview.actions = plan.searches.map(action => ({ ...action, source: audience, path: requestOverride || require('./clinical-fetch-query').clinicalFetchQuery(action.type, consentPatient, identityOptions) }));
            data.preview.effectiveGrant = grant;
            logger.info('Data Fetch Completed', {
                type: 'DATA_FETCH_COMPLETED',
                category: 'harness',
                visibility: 'diagnostic',
                targetUrl: route.audienceUrl,
                requestUrl: route.requestUrl,
                usedInternalRoute: route.usedInternalRoute,
                consentId,
                identity: currentIdentity,
                resourceType: data.resourceType,
                durationMs: Date.now() - startedAt
            });
            return data;
        } catch (err) {
            if (!invalidated() && clinicalGrant?.expiresAt > Date.now() && !['invalid_token_response', 'expired_token'].includes(err.classification)) err.grant = clinicalGrant;
            const classified = err.classification
                ? { code: err.classification, message: err.message }
                : classifyOutboundError(err, {
                    stage,
                    url: observationUrl,
                    timeout: dataSourceTimeoutMs()
                });
            logger.error('Data Fetch Failed', {
                type: 'DATA_FETCH_FAILED',
                category: 'system',
                visibility: 'default',
                stage,
                targetUrl: route.audienceUrl,
                requestUrl: route.requestUrl,
                usedInternalRoute: route.usedInternalRoute,
                consentId,
                identity: currentIdentity,
                classification: classified.code,
                message: classified.message,
                status: err.response?.status,
                data: err.response?.data
            });
            console.error('Failed to fetch data', err.response?.data || classified.message);
            err.message = classified.message;
            err.classification = classified.code;
            throw err;
        }
    });
}


/** Read only this Doctor application's capability; backend enforcement belongs to PCM.
 * @param {object} config Local application configuration (fixture-injectable for09 handoff).
 * @param {object} policy Effective local preset policy.
 * @returns {object} Enabled state and honest optional-capability label.
 */
function ownTokenInspectionCapability(config = getTeamConfig(), policy = loadEffectivePolicy()) {
    const capability = require('../../shared/conformance-policy').serviceProviderOwnTokenIntrospection(config, policy);
    return { ...capability, message: capability.origin === 'Strict lock' ? 'Introspection disabled in Strict' : !capability.enabled ? 'Introspection disabled' : 'Optional own-token introspection; PCM may refuse this capability' };
}

/** Explicit, side-effect-free standard introspection using only this SP's credentials.
 * A credential is located by an opaque local generation; this function never obtains a token.
 * @param {string} consentId Exact requesting card Consent logical ID.
 * @param {string} audience Original requested source audience.
 * @param {string} identity Registered Doctor application identity.
 * @param {string} generation Original local token generation.
 * @returns {Promise<object>} Dated observation, graceful optional failure or authoritative denial.
 */
async function checkTokenStatus(consentId, audience, identity, generation) {
    const capability = ownTokenInspectionCapability();
    if (!capability.enabled) return { state: 'disabled', message: capability.message };
    const pair = [...tokens.records].find(([key, record]) => record.generation === generation && JSON.parse(key)[4] === getClientId(identity) && JSON.parse(key)[5] === audience);
    if (!pair) return { state: 'unavailable', message: 'Not independently checked: this token is no longer available in the application cache.' };
    const [key, record] = pair;
    const invalidate = message => {
        record.invalid = true;
        // A delayed response invalidates its exact credential, never a replacement generation.
        if (tokens.records.get(key) === record) tokens.records.delete(key);
        return { state: 'invalid', authoritative: true, message };
    };
    if (record.expiresAt <= Date.now()) return invalidate('Token expired locally');
    try {
        const consent = record.publicBinding?.consent;
        if (record.publicBinding?.consentId !== consentId || !consent) return invalidate('Contradictory local token context');
        const config = await getSmartConfiguration(getPcmFhirUrl());
        if (config.issuer !== record.issuer) return invalidate('Token issuer changed since acquisition');
        if (!config.introspection_endpoint) return { state: 'unsupported', message: 'Not independently checked: PCM does not advertise introspection.' };
        const endpoint = config.introspection_endpoint;
        const form = new URLSearchParams({ token: record.token, token_type_hint: 'access_token',
            client_assertion_type: require('./oauth').CLIENT_ASSERTION_TYPE, client_assertion: generateClientAssertion(identity, null, endpoint) });
        let response;
        try { response = await axios.post(backchannelEndpoint(endpoint), form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: agentFor(identity), timeout: outboundTimeoutMs() }); }
        catch (error) {
            const status = error.response?.status;
            return { state: [401, 403].includes(status) ? 'refused' : [404, 405, 501].includes(status) ? 'unsupported' : 'unavailable',
                message: `Not independently checked: optional introspection ${[401, 403].includes(status) ? 'refused' : [404, 405, 501].includes(status) ? 'unsupported' : 'unavailable'}.` };
        }
        const value = response.data;
        if (value?.active === false) return invalidate('PCM reports token inactive');
        const grant = require('./permission-plan').validateClinicalGrant(value, consent, record.publicBinding.instance, tokenValidationOptions());
        const audiences = Array.isArray(value.aud) ? value.aud : [value.aud];
        if (value.active !== true || value.scope !== record.response.scope
            || value.client_id !== getClientId(identity) || !audiences.includes(audience)
            || (Object.hasOwn(value, 'iss') && value.iss !== record.issuer)
            || !Number.isInteger(value.exp) || value.exp * 1000 <= Date.now() || value.exp * 1000 > record.expiresAt + 1000) return invalidate('Contradictory or invalid active introspection response');
        if (record.expiresAt <= Date.now()) return invalidate('Token expired while checking status');
        return { state: 'active', message: 'Active when checked', checkedAt: new Date().toISOString(), scope: grant.scope,
            authorization_details: grant.authorization_details, observedExpiry: new Date(value.exp * 1000).toISOString() };
    } catch (error) {
        if (error instanceof TypeError) return invalidate('Invalid token status/context: ' + error.message);
        return { state: 'unavailable', message: 'Not independently checked: optional status/context check unavailable.' };
    }
}

/**
 * Fetch the Organization and Endpoint details for the current identity.
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function fetchMyOrganization(identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const pcmResource = getPcmFhirUrl();
        const token = await getToken(pcmResource, currentIdentity);

        // Fetch Organizations and their Endpoints generically
        // Relying on server-side hardening to only return the caller's organization.
        const res = await axios.get(`${pcmResource}/Organization?_include=Organization:endpoint`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });

        return res.data;
    });
}

/**
 * Update a FHIR resource by type/id.
 * @param {string} resourceType
 * @param {string} id
 * @param {object} data
 * @param {string} identity
 * @returns {Promise<object>}
 */
async function updateResource(resourceType, id, data, identity) {
    return withRetry(async () => {
        const currentIdentity = identity || 'hospital-a';
        const pcmResource = getPcmFhirUrl();
        const token = await getToken(pcmResource, currentIdentity);
        const request = projectUpdate(resourceType, { ...data, id });
        const res = await axios.put(`${pcmResource}/${resourceType}/${id}`, request, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/fhir+json',
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });
        return validateAuthoritativeResource(res.data, resourceType);
    });
}

async function sendFhirWrite({ method, path: resourcePath, body, identity, responseType, responseValidator }) {
    const currentIdentity = identity || 'hospital-a';
    return withRetry(async () => {
        const pcmResource = getPcmFhirUrl();
        const token = await getToken(pcmResource, currentIdentity);
        const response = await axios.request({
            method,
            url: `${pcmResource}/${resourcePath}`,
            data: body,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/fhir+json',
                'Accept': 'application/fhir+json'
            },
            httpsAgent: agentFor(currentIdentity)
        });
        return responseValidator
            ? responseValidator(response.data)
            : validateAuthoritativeResource(response.data, responseType);
    });
}

function createServiceProvider(input, identity) {
    return sendFhirWrite({ method: 'POST', path: 'Organization', body: buildOrganizationCreate(input), identity, responseType: 'Organization' });
}

function createEndpoint(input, identity) {
    return sendFhirWrite({ method: 'POST', path: 'Endpoint', body: buildEndpointWrite(input, 'create'), identity, responseType: 'Endpoint' });
}

function registerExistingService(canonicalId, identity) {
    return sendFhirWrite({ method: 'POST', path: 'HealthcareService', body: buildExistingServiceRegistration(canonicalId), identity, responseType: 'HealthcareService' });
}

function registerNewService(definition, identity) {
    return sendFhirWrite({ method: 'POST', path: 'HealthcareService', body: buildNewServiceRegistration(definition), identity, responseType: 'HealthcareService' });
}

function updateServiceStatus(serviceId, status, identity) {
    return sendFhirWrite({ method: 'PUT', path: `HealthcareService/${serviceId}`, body: buildServiceStatusUpdate(serviceId, status), identity, responseType: 'HealthcareService' });
}

function requestCatalogUpdate(catalog, reason, identity) {
    const body = buildCatalogUpdateParameters(catalog, reason);
    return sendFhirWrite({
        method: 'POST', path: `HealthcareService/${catalog.id}/$request-catalog-update`, body, identity,
        responseValidator: validateCatalogUpdateResponse
    });
}

function deactivateConsent(consentId, identity) {
    return sendFhirWrite({ method: 'PUT', path: `Consent/${consentId}`, body: buildConsentDeactivate(consentId), identity, responseType: 'Consent' });
}

async function fetchAllSources(consent, identity, scope) {
    const endpoints = consent?.discoveredEndpoints || [];
    const plans = planSourceAccess(consent?.id, endpoints, scope);
    return Promise.all(plans.map(async plan => ({
        ...plan,
        data: await fetchData(plan.consentId, plan.audience, identity, plan.scope)
    })));
}

/**
 * Clear cached access tokens.
 * @returns {void}
 */
function resetCache(identity) {
    if (identity) {
        const clientId = getClientId(identity);
        for (const key of tokens.records.keys()) if (JSON.parse(key)[4] === clientId) tokens.records.delete(key);
    } else tokens.clear();
    console.log('Token cache cleared.');
}

function getConformanceInfo() {
    return clientConformanceInfo(loadEffectivePolicy());
}

/** Load one bounded first page directly from an explicitly eligible HO as the requesting app. */
async function loadSandboxPatientSample(sourceId, identity = 'hospital-a', signal) {
    const { sampleSources, QUERY, SCENARIO, projectSample, samplingConfigurationStamp } = require('../../shared/sandbox-patients');
    const config = getTeamConfig(), source = sampleSources(config).find(ho => ho.id === sourceId);
    if (!source || !config.systemAuthorization.clientEntitlements[getClientId(identity)]?.includes(SCENARIO)) {
        throw new Error('Application is not entitled to this sandbox sampling source');
    }
    const stamp = samplingConfigurationStamp(config);
    const definition = require('../../shared/service-catalog').loadServiceCatalog(config, { validateClinicalDefinitions: false }).sandboxSampling;
    const token = await getToken(source.endpoint, identity, null, 'system/Patient.s', definition.policyIdentifier);
    if (signal?.aborted) throw new Error('Sampling cancelled');
    const startedAt = Date.now(), requestUrl = `${source.endpoint.replace(/\/$/, '')}/Patient?${QUERY}`;
    // No withRetry or continuation: a failed load is an explicit UI result.
    const sourceTransport = dataSourceTransportOptions(identity, requestUrl, source.endpoint);
    if (!sourceTransport.httpsAgent) throw new Error('Application source credentials unavailable');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const deadline = setTimeout(cancel, 10000);
    signal?.addEventListener('abort', cancel, { once: true });
    let response;
    try {
        response = await axios.get(requestUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/fhir+json' },
            ...guardedAxiosConfig({ ...sourceTransport, timeout: 10000, maxContentLength: 128 * 1024, signal: controller.signal })
        });
    } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
    }
    const current = getTeamConfig();
    if (signal?.aborted || stamp !== samplingConfigurationStamp(current)) {
        throw new Error('Sampling result superseded by configuration change');
    }
    return { ...projectSample(response.data), sourceId, sourceName: source.name, refreshedAt: new Date().toISOString(), requests: 1, diagnostics: { responseBytes: Buffer.byteLength(JSON.stringify(response.data)), durationMs: Date.now() - startedAt } };
}

module.exports = {
    loadSandboxPatientSample,
    ownTokenInspectionCapability,
    checkTokenStatus,
    beginSmartAuthorization,
    createEndpoint,
    createServiceProvider,
    createConsentRequest,
    deactivateConsent,
    exchangeSmartAuthorization,
    checkConsentStatus,
    fetchAllSources,
    searchConsents,
    searchServices,
    projectOwnedServices,
    readOwnedService,
    fetchData,
    fetchMyOrganization,
    getConformanceInfo,
    updateResource,
    registerExistingService,
    registerNewService,
    requestCatalogUpdate,
    updateServiceStatus,
    resetCache,
    withRetry,
    _test: {
        getPcmFhirUrl,
        backchannelEndpoint,
        logicalPcmFhirAudience,
        getDsGatewayUrl,
        shouldVerifyDataSourceServer,
        findDataSourceByUrl,
        dataSourceTransportOptions,
        resolveDataSourceRequestTarget,
        certNameForIdentity,
        tokenCacheKey,
        isTokenExpiryResponse,
        classifyOutboundError,
        validateObservationResponse,
        outboundTimeoutMs,
        dataSourceTimeoutMs,
        buildConsentRequestBody,
        generateClientAssertion,
        getSmartConfiguration,
        getToken,
        resetCache
    }
};
