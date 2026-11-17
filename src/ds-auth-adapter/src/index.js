'use strict';

const { readTeamConfig: readValidatedTeamConfig, assertValidTeamConfig } = require('../../shared/team-config-validator');

/** Private Data Source policy-enforcement adapter. */

const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');
const logger = require('./logger');
const { mapIdentity } = require('./mapper');
const { classifyRequestBinding } = require('./request-binding');
const { getAuthorizationServerMetadata, getAudience, getIssuer, getJwks } = require('./local-jwt');
const { PcmIntrospectionClient } = require('./pcm-introspection-client');
const { thumbprintFromEscapedPem } = require('./mtls');
const { createOpaqueClientId } = require('../../shared/pcm-contract');
const { applyModeWarningHeaders, buildEffectivePolicy, logPolicyBanner } = require('../../shared/conformance-policy');
const { simulationPolicyStamp } = require('../../shared/conformance-policy');
const { guardedAxiosConfig, parseOutboundUrl } = require('../../shared/outbound-destination');
const { createTraceContext, propagationHeaders, readHeader } = require('../../shared/trace-context');

const DEFAULT_OUTBOUND_TIMEOUT_MS = 10000;
const OUTBOUND_LOGGING_MARK = Symbol.for('pcm.dsAdapter.outboundLogging');

/** Set one canonical propagation header without duplicate mixed-case keys. */
function setPropagationHeader(headers, name, value) {
    if (typeof headers.set === 'function') return headers.set(name, value);
    for (const key of Object.keys(headers)) if (key.toLowerCase() === name) delete headers[key];
    headers[name] = value;
}

/** Recover the emitted client span for both completion and failure records. */
function outboundContext(config) {
    const metadata = config?.metadata || {};
    return {
        correlationId: metadata.correlationId,
        flowId: metadata.flowId,
        traceId: metadata.traceId,
        spanId: metadata.spanId,
        parentSpanId: metadata.parentSpanId,
        traceFlags: metadata.traceFlags
    };
}

/** Instrument outbound calls with full non-AWS sandbox request/response values. */
function installOutboundLogging(http) {
    if (!http?.interceptors || http[OUTBOUND_LOGGING_MARK]) return;
    http[OUTBOUND_LOGGING_MARK] = true;
    http.interceptors.request.use(request => {
        request.headers = request.headers || {};
        const inherited = logger.getPropagationHeaders();
        const trace = createTraceContext(readHeader(request.headers, 'traceparent') || inherited.traceparent);
        const correlationId = readHeader(request.headers, 'x-correlation-id') || inherited['x-correlation-id'] || cryptoRandomId();
        const flowId = readHeader(request.headers, 'x-flow-id') || inherited['x-flow-id'];
        // This interceptor runs only when HTTP is attempted. A cache hit never
        // invents a token/introspection hop or a corresponding child span.
        request.metadata = { ...request.metadata, startedAt: Date.now(), correlationId, flowId, ...trace, parentSpanId: trace.parentSpanId };
        for (const [name, value] of Object.entries(propagationHeaders(request.metadata))) {
            setPropagationHeader(request.headers, name, value);
        }
        logger.info(`Request Sent: ${String(request.method || 'get').toUpperCase()} ${request.url}`, {
            type: 'OUTGOING_REQUEST',
            ...outboundContext(request),
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.data
        });
        return request;
    });
    http.interceptors.response.use(response => {
        logger.info(`Response Received: ${response.status} ${String(response.config?.method || 'get').toUpperCase()} ${response.config?.url}`, {
            type: 'OUTGOING_RESPONSE',
            ...outboundContext(response.config),
            status: response.status,
            durationMs: Date.now() - (response.config?.metadata?.startedAt || Date.now()),
            url: response.config?.url,
            headers: response.headers,
            body: response.data
        });
        return response;
    }, error => {
        logger.warn(`Response Error: ${error.response?.status || 'network'} ${String(error.config?.method || '').toUpperCase()} ${error.config?.url || ''}`.trim(), {
            type: 'OUTGOING_ERROR',
            ...outboundContext(error.config),
            status: error.response?.status,
            durationMs: Date.now() - (error.config?.metadata?.startedAt || Date.now()),
            url: error.config?.url,
            requestHeaders: error.config?.headers,
            requestBody: error.config?.data,
            responseHeaders: error.response?.headers,
            responseBody: error.response?.data
        });
        return Promise.reject(error);
    });
}

function cryptoRandomId() {
    return crypto.randomUUID();
}

function readTeamConfig(env = process.env) {
    return readValidatedTeamConfig(env.TEAM_CONFIG_PATH || '/runtime/team-config.json', { env });
}

function positiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Validate the gateway-supplied original request before signing it for HAPI. */
function resolveRequestBinding(req) {
    const method = String(req.get('x-original-method') || '').toUpperCase();
    const uri = req.get('x-original-uri') || '';
    classifyRequestBinding({ method, uri });
    return Object.freeze({ method, uri });
}

function resolveBindings(config, env = process.env) {
    const certsDir = env.CERTS_DIR || '/app/certs';
    const configuredOrganizations = config.organizations || {};
    const healthOrganization = (config.healthOrganizations || []).find(item => item.id === env.HO_ID);
    const participantKey = env.DS_PARTICIPANT_KEY
        || (env.HO_ID && configuredOrganizations[env.HO_ID] ? env.HO_ID : 'referenceDataSource');
    const participant = healthOrganization || configuredOrganizations[participantKey]
        || (configuredOrganizations.dataSources || []).find(item => item.id === env.HO_ID)
        || {};
    const authBase = String(env.PCM_AUTH_URL || config.internalBaseUrls?.pcmAuth || 'https://pcm-core:3000').replace(/\/+$/, '');
    const fhirBase = String(env.PCM_FHIR_URL || config.internalBaseUrls?.pcmFhir || authBase).replace(/\/+$/, '');
    const expectedIssuer = config.contract.operational.oauthBase;
    if (env.PCM_EXPECTED_ISSUER && env.PCM_EXPECTED_ISSUER !== expectedIssuer) throw new Error('PCM_EXPECTED_ISSUER contradicts the selected contract environment');
    const discoveryIssuer = expectedIssuer;
    const hoId = env.HO_ID || participant.id || 'reference';
    const assertionKey = healthOrganization?.certificates?.gatewayAssertionKey
        || config.certificateRoles?.referenceDataSource?.assertion?.key || 'ds-gateway-assertion.key';
    const expectedAudience = env.DS_EXPECTED_AUDIENCE || participant.endpoint || config.internalBaseUrls?.referenceDataSource;
    if (!expectedAudience) throw new Error('This adapter requires one configured Data Source audience');
    const authMode = env.PCM_INTROSPECTION_AUTH_MODE || 'bearer';
    if (!['bearer', 'direct'].includes(authMode)) throw new Error('PCM_INTROSPECTION_AUTH_MODE must be bearer or direct');
    for (const [name, value] of [['PCM issuer', expectedIssuer], ['PCM FHIR base', fhirBase], ['Data Source audience', expectedAudience]]) {
        if (new URL(value).protocol !== 'https:') throw new Error(`${name} must be an HTTPS URL`);
    }
    const certPath = (explicit, filename) => explicit || path.join(certsDir, filename);
    return Object.freeze({
        hoId,
        certsDir,
        clientId: env.DS_CLIENT_ID || participant.clientId || createOpaqueClientId('pcm-ds', hoId),
        expectedAudience,
        expectedIssuer,
        discoveryIssuer,
        authBase,
        fhirBase,
        authMode,
        localIssuer: env.LOCAL_JWT_ISSUER || healthOrganization?.adapterIssuer || `https://ds-auth-adapter.internal/${encodeURIComponent(hoId)}`,
        localAudience: env.LOCAL_JWT_AUDIENCE || healthOrganization?.adapterAudience || `urn:pcm:ho:${hoId}:fhir-server`,
        assertionKeyPath: certPath(env.DS_ASSERTION_KEY_PATH, assertionKey),
        mtlsCertPath: certPath(env.DS_MTLS_CERT_PATH, healthOrganization?.certificates?.gatewayMtlsCert || config.certificateRoles?.referenceDataSource?.mtls?.cert || 'ds-gateway.crt'),
        mtlsKeyPath: certPath(env.DS_MTLS_KEY_PATH, healthOrganization?.certificates?.gatewayMtlsKey || config.certificateRoles?.referenceDataSource?.mtls?.key || 'ds-gateway.key'),
        rootCaPath: certPath(env.DS_ROOT_CA_PATH, config.certificates?.rootCaCert || 'rootCA.crt'),
        timeout: positiveInt(env.DS_AUTH_OUTBOUND_TIMEOUT_MS, DEFAULT_OUTBOUND_TIMEOUT_MS),
        enforceResourceCertificateCorrelation: env.DS_ENFORCE_RESOURCE_CERT_CORRELATION === 'true'
    });
}

function createHttpsAgent(bindings) {
    return new https.Agent({
        cert: fs.readFileSync(bindings.mtlsCertPath),
        key: fs.readFileSync(bindings.mtlsKeyPath),
        ca: fs.readFileSync(bindings.rootCaPath),
        rejectUnauthorized: bindings.verifyServerCertificate !== false
    });
}

/** All requests require an active grant; presets affect transport/authentication only. */
function simulationStage(_controls) { return 'enforced'; }

function validateSmartConfiguration(value, bindings) {

    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.issuer !== bindings.discoveryIssuer
        || typeof value.token_endpoint !== 'string'
        || typeof value.introspection_endpoint !== 'string') {
        throw new Error('PCM SMART configuration is malformed');
    }
    const expectedTokenEndpoint = `${bindings.discoveryIssuer.replace(/\/+$/, '')}/token`;
    const expectedIntrospectionEndpoint = `${bindings.discoveryIssuer.replace(/\/+$/, '')}/introspect`;
    if (!value.authorization_details_types_supported?.includes('https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access')
        || value.token_endpoint !== expectedTokenEndpoint
        || value.introspection_endpoint !== expectedIntrospectionEndpoint
        || !value.token_endpoint_auth_methods_supported?.includes('private_key_jwt')
        || !value.introspection_endpoint_auth_methods_supported?.includes('private_key_jwt')
        || !value.token_endpoint_auth_signing_alg_values_supported?.includes('ES256')
        || !value.introspection_endpoint_auth_signing_alg_values_supported?.includes('ES256')
        || value.tls_client_certificate_bound_access_tokens !== false) {
        throw new Error('PCM SMART endpoints do not match the configured issuer');
    }
    return Object.freeze({ tokenEndpoint: value.token_endpoint, introspectionEndpoint: value.introspection_endpoint });
}

async function discoverPcm(http, httpsAgent, bindings) {
    const response = await http.get(`${bindings.fhirBase}/.well-known/smart-configuration`, guardedAxiosConfig({
        url: `${bindings.fhirBase}/.well-known/smart-configuration`,
        headers: logger.getPropagationHeaders(),
        httpsAgent,
        timeout: bindings.timeout
    }));
    return validateSmartConfiguration(response.data, bindings);
}

/** Snapshot every input that changes response normalization, even without a runtime revision. */
function normalizationConfiguration(config, hoId, policy = buildEffectivePolicy(config)) {
    return {
        authenticationSimulation: require('../../shared/authentication-evidence').simulationOptions(policy,
            policy.simulation.perSource[hoId] || policy.simulation.controls),
        workflowIdentities: require('../../shared/workflow-identities').workflowIdentities(config),
        syntheticWorkflowFixtures: require('../../shared/system-authorization-config').syntheticWorkflowFixtureIdentities(config),
        presenceLimits: require('../../shared/presence-limits').presenceLimits(config, { id: hoId }),
        allowSandboxGuid: require('../../shared/identity-mapping').sandboxIdentityOptions(config).allowSandboxGuid === true
    };
}

function createApp({ config, env = process.env, http = axios, client = null, bindings = null, httpsAgent = null } = {}) {
    const teamConfig = config ? assertValidTeamConfig(config, { env }) : readTeamConfig(env);
    const currentEffectivePolicy = () => buildEffectivePolicy(config || readTeamConfig(env), env);
    const effectivePolicy = currentEffectivePolicy();
    const fixedBindings = bindings || resolveBindings(teamConfig, env);
    installOutboundLogging(http);
    let introspectionClient = client;
    let introspectionClientPolicyKey = client ? 'injected' : null;
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => express.json({
        limit: env.DS_ADAPTER_BODY_LIMIT || Math.max(2 * 1024 * 1024, require('../../shared/presence-limits').presenceLimits(config || readTeamConfig(env), { id: fixedBindings.hoId }).maxPayloadBytes),
        type: ['application/json', 'application/fhir+json'],
        verify: (req, _res, buffer, encoding) => {
            if (encoding !== 'utf-8') throw Object.assign(new Error('FHIR JSON requires UTF-8'), { status: 415 });
            req.rawBody = buffer.toString('utf8');
        }
    })(req, res, next));
    // Keep form bytes intact. HAPI alone interprets/combines query predicates;
    // this verifies transport encoding so malformed escapes cannot become a broad search.
    app.use((req, res, next) => express.text({
        limit: env.DS_ADAPTER_BODY_LIMIT || Math.max(2 * 1024 * 1024, require('../../shared/presence-limits').presenceLimits(config || readTeamConfig(env), { id: fixedBindings.hoId }).maxPayloadBytes),
        type: 'application/x-www-form-urlencoded',
        verify: (req, _res, buffer, encoding) => {
            if (encoding !== 'utf-8') throw Object.assign(new Error('FHIR forms require UTF-8'), { status: 415 });
            try { decodeURIComponent(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
            catch (_error) { throw Object.assign(new Error('Malformed FHIR form encoding'), { status: 400 }); }
            req.rawBody = buffer.toString('utf8');
        }
    })(req, res, next));
    app.use((req, res, next) => { applyModeWarningHeaders(res, currentEffectivePolicy()); next(); });
    app.use(logger.requestLogger);

    async function getClient(requireClinicalTarget = false, activeConfig = config || readTeamConfig(env)) {
        if (client) return client;
        const currentPolicy = buildEffectivePolicy(activeConfig, env);
        const configuredControls = currentPolicy.simulation.perSource[fixedBindings.hoId] || currentPolicy.simulation.controls;
        // Patient operations retain genuine active/audience-bound introspection
        // even when result authorization is explicitly disabled for synthetic data.
        const sourceControls = requireClinicalTarget ? { ...configuredControls, tokenExpiry: true, tokenAudience: true, serverCertificateVerification: true } : configuredControls;
        const normalization = normalizationConfiguration(activeConfig, fixedBindings.hoId, currentPolicy);
        const policyKey = JSON.stringify({
            schema: require('./introspection-contract').NORMALIZED_SCHEMA,
            ...normalization,
            revision: ((activeConfig?.runtime?.revision || 0) - (activeConfig?.runtime?.queryLimitsRevisionOffset || 0)),
            controls: sourceControls
        });
        if (introspectionClient && introspectionClientPolicyKey === policyKey) return introspectionClient;
        const agent = httpsAgent || createHttpsAgent({
            ...fixedBindings,
            verifyServerCertificate: sourceControls.serverCertificateVerification
        });
        const endpoints = await discoverPcm(http, agent, fixedBindings);
        introspectionClient = new PcmIntrospectionClient({
            http,
            httpsAgent: agent,
            clientId: fixedBindings.clientId,
            privateKey: fs.readFileSync(fixedBindings.assertionKeyPath),
            tokenEndpoint: endpoints.tokenEndpoint,
            introspectionEndpoint: endpoints.introspectionEndpoint,
            tokenRequestEndpoint: `${fixedBindings.authBase}/token`,
            introspectionRequestEndpoint: `${fixedBindings.authBase}/introspect`,
            expectedIssuer: fixedBindings.expectedIssuer,
            acceptedIssuers: [...new Set([fixedBindings.expectedIssuer, fixedBindings.discoveryIssuer])],
            controls: sourceControls,
            policyStamp: simulationPolicyStamp(sourceControls, fixedBindings.hoId, ((activeConfig?.runtime?.revision || 0) - (activeConfig?.runtime?.queryLimitsRevisionOffset || 0))),
            ...normalization,
            expectedAudience: fixedBindings.expectedAudience,
            hoId: fixedBindings.hoId,
            authMode: fixedBindings.authMode,
            timeout: fixedBindings.timeout
        });
        introspectionClientPolicyKey = policyKey;
        return introspectionClient;
    }

    app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'ds-auth-adapter', conformanceMode: currentEffectivePolicy().mode, hoId: fixedBindings.hoId }));
    app.get('/.well-known/jwks.json', (_req, res) => res.json(getJwks()));
    app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(getAuthorizationServerMetadata()));
    app.get('/auth-check', async (req, res) => {
        let authorizationReason = 'DEFAULT_DENY';
        let authorizationObserved = false;
        let budgetFailure;
        const observeAuthorization = () => {
            if (authorizationObserved) return;
            authorizationObserved = true;
            try { logger.info(budgetFailure ? `Data Source authorization decision · QUERY_BUDGET_EXCEEDED: maxPrivateAuthorizationBytes limit=${budgetFailure.threshold} bytes observed=${budgetFailure.observed} bytes` : 'Data Source authorization decision', {
                type: 'DS_AUTHORIZATION_DECISION', visibility: 'default', hoId: fixedBindings.hoId,
                mode: fixedBindings.authMode, outcome: res.statusCode === 200 ? 'pass' : 'fail', reasonCode: authorizationReason,
                status: res.statusCode,
                ...(budgetFailure ? { budgetFailure, budgetReasonCode: 'QUERY_BUDGET_EXCEEDED' } : {})
            }); } catch (_) { /* Diagnostics cannot alter an authorization result. */ }
        };
        // Observe the decision itself even when its caller disconnected before HTTP finish.
        const deny = reasonCode => { authorizationReason = reasonCode; res.status(401); observeAuthorization(); return res.send('Unauthorized'); };
        res.once('finish', observeAuthorization);
        const activeConfig = config || readTeamConfig(env);
        const queryLimits = require('../../shared/clinical-query-limits').clinicalQueryLimits(activeConfig, { id: fixedBindings.hoId });
        const currentPolicy = buildEffectivePolicy(activeConfig, env);
        const sourceControls = currentPolicy.simulation.perSource[fixedBindings.hoId] || currentPolicy.simulation.controls;
        const policyStamp = simulationPolicyStamp(sourceControls, fixedBindings.hoId, ((activeConfig?.runtime?.revision || 0) - (activeConfig?.runtime?.queryLimitsRevisionOffset || 0)));
        if (sourceControls.publicClientMtls && !thumbprintFromEscapedPem(req.get('x-client-cert'))) return deny('CERTIFICATE_REQUIRED');
        const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
        if (!match) return deny(req.get('authorization') ? 'MALFORMED_TOKEN' : 'MISSING_TOKEN');
        if (sourceControls.publicClientMtls
            && !thumbprintFromEscapedPem(req.get('x-client-cert'))) {
            return deny('CERTIFICATE_REQUIRED');
        }
        try {
            const requestBinding = resolveRequestBinding(req);
            const classification = classifyRequestBinding(requestBinding);
            const requireClinicalTarget = classification.clinicalTarget;
            const decision = await (await getClient(requireClinicalTarget, activeConfig)).introspect(
                match[1], { fresh: requireClinicalTarget }
            );
            if (requireClinicalTarget && !(decision.kind === 'data-source-access'
                || classification.route === 'continuation' && ['patient-authentication', 'dependent-discovery'].includes(decision.kind)
                || classification.route === 'type-search' && ['patient-authentication', 'dependent-discovery', 'online-presence'].includes(decision.kind))) return deny(decision.active ? 'MAPPING_REJECTED' : 'INACTIVE_INTROSPECTION');
            if (!decision.active) return deny('INACTIVE_INTROSPECTION');
            const sampling = decision.kind === 'sandbox-patient-sample';
            if ((fixedBindings.enforceResourceCertificateCorrelation || (sampling && sourceControls.publicClientMtls))
                && thumbprintFromEscapedPem(req.get('x-client-cert')) !== decision.authentication.tokenEndpointMtlsThumbprint) {
                return deny('CERTIFICATE_MISMATCH');
            }
            if (sampling) {
                if (!require('../../shared/sandbox-patients').sampleSources(activeConfig).some(source => source.id === fixedBindings.hoId)) throw new Error('Sampling source unavailable');
                require('../../shared/sandbox-patients').assertSampleRequest(requestBinding);
            }
            const localToken = mapIdentity(decision, {
                policyStamp, hoId: fixedBindings.hoId, issuer: fixedBindings.localIssuer,
                audience: fixedBindings.localAudience, requestBinding, queryLimits
            });
            logger.info('Private Data Source authorization minted', {
                type: 'DS_LOCAL_TOKEN_MINTED',
                category: 'system',
                hoId: fixedBindings.hoId,
                kind: decision.kind
            });
            authorizationReason = 'LOCAL_TOKEN_MINTED';
            res.status(200); observeAuthorization();
            res.set('X-Local-Token', localToken);
            return res.status(200).send('OK');
        } catch (error) {
            if (error.budgetFailure?.setting === 'maxPrivateAuthorizationBytes') budgetFailure = error.budgetFailure;
            try {
                logger.warn(budgetFailure ? `Data Source authorization denied · QUERY_BUDGET_EXCEEDED: maxPrivateAuthorizationBytes limit=${budgetFailure.threshold} bytes observed=${budgetFailure.observed} bytes` : 'Data Source authorization denied', {
                    type: 'DS_AUTHORIZATION_DENIED',
                    category: 'system',
                    hoId: fixedBindings.hoId,
                    reason: error.code || error.name,
                    ...(budgetFailure ? { reasonCode: 'QUERY_BUDGET_EXCEEDED', budgetFailure } : {})
                });
            } catch (_) { /* An unavailable warning cannot change the existing denial response. */ }
            return deny(error.reasonCode || (error.code === 'PCM_INTROSPECTION_CONTRACT' ? 'MALFORMED_PCM_RESPONSE' : error.isAxiosError || error.response ? 'PCM_TRANSPORT_FAILED' : 'MAPPING_REJECTED'));
        }
    });

    /**
     * Relay a gateway-authorized FHIR request so the per-HO adapter log records
     * the complete public request and HAPI response. This route is reachable
     * only on the private Compose networks; NGINX overwrites every binding
     * header before forwarding.
     */
    app.all(/^\/fhir-proxy(?:\/.*)?$/, async (req, res, next) => {
        try {
            const requestBinding = resolveRequestBinding(req);
            const localToken = req.get('x-local-token');
            if (!localToken || /\s/.test(localToken)) return res.status(401).send('Unauthorized');
            const upstreamBase = String(req.get('x-pcm-upstream-base') || '').replace(/\/+$/, '');
            parseOutboundUrl(upstreamBase);

            if (classifyRequestBinding(requestBinding).route === 'type-search') {
                if (!req.is('application/x-www-form-urlencoded')) return res.status(415).send('Supported media type: application/x-www-form-urlencoded');
            } else if (!['GET', 'HEAD'].includes(requestBinding.method)) {
                if (!req.is(['application/json', 'application/fhir+json'])) return res.status(415).send('Supported media types: application/json, application/fhir+json');
                if (!req.rawBody?.length) return res.status(400).send('FHIR request body is required');
            }
            const suffix = requestBinding.uri.replace(/^\/fhir/, '');
            const target = `${upstreamBase}${suffix}`;
            const verifyServerCertificate = req.get('x-pcm-upstream-verify') === 'on';
            const agent = new URL(target).protocol === 'https:'
                ? new https.Agent({
                    ca: fs.readFileSync(fixedBindings.rootCaPath),
                    rejectUnauthorized: verifyServerCertificate
                })
                : undefined;
            const response = await http.request(guardedAxiosConfig({
                method: requestBinding.method,
                url: target,
                headers: {
                    Accept: req.get('accept') || 'application/fhir+json',
                    // Revalidation must use current records. HAPI cached-search
                    // hits can also emit malformed headers in native batches.
                    'Cache-Control': 'no-cache',
                    ...(req.get('content-type') ? { 'Content-Type': req.get('content-type') } : {}),
                    Authorization: `Bearer ${localToken}`,
                    'X-PCM-Request-URI': requestBinding.uri,
                    'X-PCM-Request-Method': requestBinding.method,
                    ...logger.getPropagationHeaders()
                },
                data: ['GET', 'HEAD'].includes(requestBinding.method)
                    ? undefined
                    : req.rawBody,
                httpsAgent: agent,
                timeout: fixedBindings.timeout,
                maxContentLength: 32 * 1024 * 1024,
                maxBodyLength: Buffer.byteLength(req.rawBody || ''),
                transformRequest: [value => value],
                responseType: 'text',
                transformResponse: [value => value],
                validateStatus: () => true
            }));
            if ([301, 302, 303, 307, 308].includes(response.status)) return res.status(502).send('Upstream FHIR redirects are prohibited');
            for (const header of ['content-type', 'content-location', 'etag', 'last-modified', 'link', 'location', 'retry-after']) {
                if (response.headers?.[header] !== undefined) res.set(header, response.headers[header]);
            }
            return res.status(response.status).send(requestBinding.method === 'HEAD' ? undefined : response.data);
        } catch (error) {
            return next(error);
        }
    });
    app.use(logger.errorLogger);
    return { app, bindings: fixedBindings, effectivePolicy, getClient };
}

async function start() {
    logger.initialize();
    logger.installProcessHandlers('ds-auth-adapter');
    logger.logBoot('ds-auth-adapter');
    const runtime = createApp();
    logPolicyBanner(logger, 'ds-auth-adapter', runtime.effectivePolicy);
    const port = process.env.PORT || 3000;
    const server = require('http').createServer({ maxHeaderSize: 65536 }, runtime.app).listen(port, () => logger.info(`DS Auth Adapter listening on ${port}`, {
        type: 'PROCESS_LISTENING', category: 'lifecycle', visibility: 'diagnostic', causesSystemFlow: false
    }));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    return server;
}

if (require.main === module) start().catch(error => {
    logger.error('DS Auth Adapter startup failed', { type: 'PROCESS_STARTUP_FAILED', error: error.message });
    process.exitCode = 1;
});

module.exports = {
    DEFAULT_OUTBOUND_TIMEOUT_MS,
    normalizationConfiguration,
    createApp,
    resolveRequestBinding,
    createHttpsAgent,
    discoverPcm,
    readTeamConfig,
    resolveBindings,
    start,
    validateSmartConfiguration,
    getAudience,
    getIssuer,
    installOutboundLogging,
    simulationStage
};
