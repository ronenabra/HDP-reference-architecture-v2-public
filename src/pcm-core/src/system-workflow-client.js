'use strict';

/** Actual mTLS transport for the three registered PCM system applications. */
const { resolveHmoSource, sourceFingerprint } = require('./hmo-sources');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require('../../shared/assertion-keys');
const { safeLookup, parseOutboundUrl } = require('../../shared/outbound-destination');
const { environmentEndpoints, pcmTransportUrl, tokenMaximumSeconds, LOGGING_EXCEPTION } = require('../../shared/pcm-environment');
const { validateDataAuthorizationDetails } = require('../../shared/data-authorization-details');
const { certPath } = require('./team-config');
const { getConfiguredDataSources } = require('./data-sources');
const { presenceLimits } = require('../../shared/presence-limits');
const { TYPE, ROLE_BASE, BASIS_SYSTEMS } = require('./rar-request');
const CLIENTS = Object.freeze({
    'presence-check': { key: 'presenceOrchestrator', policy: 'PRESENCE', scope: 'system/Patient.s' },
    'patient-authentication': { key: 'authenticationOrchestrator', policy: 'PATIENT-AUTHENTICATION', scope: 'patient/Patient.s' },
    'dependent-discovery': { key: 'discoveryOrchestrator', policy: 'DEPENDENT-DISCOVERY', scope: 'system/Patient.s system/RelatedPerson.s' }
});

/** Read a bounded HTTPS JSON response with absolute timeout, no redirects and guarded DNS. */
function requestJson(url, { method, headers, body, tls, timeoutMilliseconds, maxBytes = 2 * 1024 * 1024,
    schedule = setTimeout, unschedule = clearTimeout, signal, onResponseBytes, acceptedStatuses = [200] }) {
    const target = parseOutboundUrl(url);
    if (target.protocol !== 'https:') throw new TypeError('System workflows require HTTPS transport');
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) return Promise.reject(new Error('Workflow deadline exceeded'));
    return new Promise((resolve, reject) => {
        let response, timer, settled = false;
        const chunks = [];
        let bytes = 0;
        const encoded = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
        // Every terminal path releases our timer and listeners, including truncated responses.
        const cleanup = () => {
            unschedule(timer);
            signal?.removeEventListener('abort', onCancel);
            if (response) {
                response.removeListener('data', onData);
                response.removeListener('end', onEnd);
                response.removeListener('aborted', onAborted);
            }
        };
        const finish = (error, data) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve(data);
        };
        const onError = error => finish(error);
        const onAborted = () => finish(new Error('Workflow response aborted'));
        const onClose = () => {
            if (!settled) finish(new Error('Workflow request closed'));
            request.removeListener('error', onError);
            request.removeListener('close', onClose);
        };
        const onData = chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) { abort(new Error('Workflow response exceeds its byte limit')); return; }
            chunks.push(chunk);
        };
        const abort = error => {
            finish(error);
            // Reject once, then destroy without injecting another asynchronous error.
            response?.destroy();
            request.destroy();
        };
        const onEnd = () => {
            let data;
            try {
                if (!/^application\/(?:fhir\+)?json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) throw new Error('Unsupported media type');
                onResponseBytes?.(bytes);
                data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (_) { finish(new Error('Workflow response is not JSON')); return; }
            if (!acceptedStatuses.includes(response.statusCode)) {
                finish(Object.assign(new Error(`Workflow HTTP ${response.statusCode}`), { status: response.statusCode, body: data }));
            } else finish(null, data);
        };
        const onCancel = () => abort(new Error('Workflow request cancelled'));
        const request = https.request(target, { ...tls, lookup: safeLookup(), method, headers: { ...headers,
            ...(encoded === undefined ? {} : { 'Content-Length': Buffer.byteLength(encoded) }) } }, incoming => {
            response = incoming;
            response.on('data', onData);
            response.on('error', onError);
            response.on('end', onEnd);
            response.on('aborted', onAborted);
            // destroy(error) can emit an error after abort/end; consume it through close.
            response.once('close', () => response.removeListener('error', onError));
        });
        timer = schedule(() => abort(Object.assign(new Error('Workflow request timed out'), { code: 'ETIMEDOUT' })), timeoutMilliseconds);
        request.on('error', onError);
        request.on('close', onClose);
        if (signal?.aborted) onCancel(); else { signal?.addEventListener('abort', onCancel, { once: true }); request.end(encoded); }
    });
}

/** Return a source client that binds each fresh assertion to private invocation state. */
function createSystemWorkflowClient({ config, flows, store = null, getConfig = () => config, logger = { info() {} }, transport = requestJson, clock = () => Date.now(), sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
    const catalogPolicies = require('../../shared/service-catalog').loadServiceCatalog(config)?.systemPolicies;
    return async (source, operation) => {
        const definition = CLIENTS[operation.scenario];
        const currentSource = () => {
            const current = getConfig();
            const resolved = operation.scenario === 'presence-check'
                ? getConfiguredDataSources(current).find(item => item.id === source.id && item.endpoint === source.endpoint)
                : resolveHmoSource(current, source.id, { store });
            if (!definition || !resolved || sourceFingerprint(resolved) !== sourceFingerprint(source)) throw new Error('System workflow source changed or is unavailable');
            if (store && definition) {
                const policyId = catalogPolicies?.find(item => item.scenario === operation.scenario)?.policyIdentifier || `PCM-POLICY-${definition.policy}-001`;
                const active = require('./fhir/system-policy').evaluatePolicy({ store, config: current, identifier: { system: BASIS_SYSTEMS.Contract, value: policyId },
                    clientId: current.oauthClients[definition.key].clientId, targetOrganizationId: resolved.id, now: clock() / 1000 });
                if (!active) throw new Error('System workflow Contract is no longer available for this source');
            }
            return resolved;
        };
        currentSource();
        const base = source.endpoint;
        const destination = parseOutboundUrl(operation.url);
        if (destination.href !== operation.url || destination.username || destination.password || destination.hash
            || !(operation.url === base || operation.url.startsWith(`${base}/`) || operation.url.startsWith(`${base}?`))
            || destination.origin !== new URL(base).origin) throw new Error('Workflow destination escapes selected source');
        const limits = presenceLimits(config, { id: source.id });
        if ((operation.patients || []).length > limits.maxPatients) throw new Error('Presence patient limit exceeded');
        const duration = operation.scenario === 'dependent-discovery' ? config.systemAuthorization.discovery.timeoutMilliseconds
            : operation.scenario === 'presence-check' ? limits.timeoutMilliseconds : config.systemAuthorization.authentication.timeoutMilliseconds;
        const client = config.oauthClients[definition.key];
        const policyIdentifier = catalogPolicies?.find(item => item.scenario === operation.scenario)?.policyIdentifier || `PCM-POLICY-${definition.policy}-001`;
        // The orchestrator's source deadline is private operation metadata, never OAuth input.
        const deadline = Math.min(clock() + duration, operation.deadlineMilliseconds ?? Infinity);
        const remainingBudget = () => {
            currentSource();
            const invocation = operation.flowId && flows.invocation ? flows.invocation(operation.flowId, client.clientId) : null;
            if (operation.flowId && flows.invocation && !invocation) throw new Error('Workflow flow is unavailable');
            const remaining = Math.min(deadline, invocation ? invocation.expiresAt * 1000 : Infinity) - clock();
            if (remaining <= 0) throw Object.assign(new Error('Workflow deadline exceeded'), { code: 'ETIMEDOUT' });
            return remaining;
        };
        remainingBudget();
        const tls = { ca: fs.readFileSync(path.join(process.env.CERTS_DIR || config.runtime.certsDir, config.certificates.rootCaCert)),
            cert: fs.readFileSync(certPath(config, definition.key, 'cert', 'mtls')),
            key: fs.readFileSync(certPath(config, definition.key, 'key', 'mtls')), rejectUnauthorized: true };
        const policy = require('../../shared/conformance-policy').buildEffectivePolicy(config);
        const controls = store ? require('./source-policy').sourceControls(store, policy, config, { organizationId: source.id })
            : require('../../shared/conformance-policy').sourceSimulationControls(policy, config, { resource: source.endpoint, clientId: source.clientId });
        const sourceTls = { cert: tls.cert, key: tls.key,
            ...require('../../shared/source-server-trust').sourceServerTls({ trust: source.serverTrust,
                certsDir: process.env.CERTS_DIR || config.runtime.certsDir, rootCaCert: config.certificates.rootCaCert,
                verify: controls.serverCertificateVerification !== false }) };
        const tokenEndpoint = environmentEndpoints(config.contract.environment).tokenEndpoint;
        const privateKey = fs.readFileSync(certPath(config, definition.key, 'key', 'assertion'));
        const retries = operation.scenario === 'dependent-discovery' ? config.systemAuthorization.discovery.maxRetries : 1;
        for (let attempt = 0; attempt <= retries; attempt++) {
            remainingBudget();
            const jti = crypto.randomUUID();
            const iat = Math.floor(clock() / 1000);
            const assertion = jwt.sign({ iss: client.clientId, sub: client.clientId, aud: tokenEndpoint, iat, exp: iat + 300, jti, cnf: certificateConfirmation(tls.cert) }, privateKey, { algorithm: signingAlgorithm(privateKey), header: { typ: 'JWT', kid: jwkThumbprint(privateKey) } });
            if (operation.flowId) flows.bindAssertion(operation.flowId, client.clientId, jti);
            const authorizationDetails = [{ type: TYPE, fhirContext: [{ type: 'Contract', role: `${ROLE_BASE}authorization-basis`, identifier: {
                system: BASIS_SYSTEMS.Contract, value: policyIdentifier
            } }, ...(operation.patients || []).map(identifier => ({ type: 'Patient', role: `${ROLE_BASE}authorization-patient`, identifier }))] }];
            const form = new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion: assertion, scope: definition.scope, resource: base, authorization_details: JSON.stringify(authorizationDetails) }).toString();
            const flowId = operation.flowId || operation.correlationId || crypto.randomUUID();
            try {
                const token = await transport(pcmTransportUrl(tokenEndpoint, config), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Flow-Id': flowId }, body: form, tls, maxBytes: limits.maxResponseBytes, timeoutMilliseconds: remainingBudget() });
                remainingBudget();
                if (token.token_type !== 'Bearer' || typeof token.access_token !== 'string' || !token.access_token || !Number.isInteger(token.expires_in) || token.expires_in < 1 || token.expires_in > tokenMaximumSeconds(config)) throw new Error('Invalid system token response');
                if (Buffer.byteLength(JSON.stringify(token)) > limits.maxResponseBytes) throw new Error('Workflow token response limit exceeded');
                const invocation = operation.flowId && flows.invocation?.(operation.flowId, client.clientId);
                const syntheticWorkflowFixtures = invocation?.syntheticFixture === true
                    ? require('../../shared/system-authorization-config').syntheticWorkflowFixtureIdentities(config)
                        .filter(value => value.system === invocation.identifier.system && value.value === invocation.identifier.value) : [];
                const granted = validateDataAuthorizationDetails(token.authorization_details, { maxPatients: limits.maxPatients, syntheticWorkflowFixtures });
                if (granted.scenario !== operation.scenario
                    || granted.basis.identifier.value !== policyIdentifier
                    || JSON.stringify(granted.patients) !== JSON.stringify(operation.patients || [])) throw new Error('System token context mismatch');
                const headers = { Accept: 'application/fhir+json', ...operation.headers, Authorization: `Bearer ${token.access_token}`, 'X-Flow-Id': flowId,
                    ...(operation.body ? { 'Content-Type': 'application/fhir+json' } : {}) };
                logger.info('System workflow outbound request', { type: 'SYSTEM_WORKFLOW_REQUEST', conformanceException: LOGGING_EXCEPTION, flowId, scenario: operation.scenario, sourceId: source.id, attempt, url: operation.url, method: operation.method, headers, body: operation.body, assertion, token });
                const response = await transport(operation.url, { method: operation.method, headers, body: operation.body, tls: sourceTls, maxBytes: operation.scenario === 'presence-check' ? limits.maxPayloadBytes : undefined, timeoutMilliseconds: remainingBudget() });
                remainingBudget();
                logger.info('System workflow outbound response', { type: 'SYSTEM_WORKFLOW_RESPONSE', conformanceException: LOGGING_EXCEPTION, flowId, scenario: operation.scenario, sourceId: source.id, attempt, body: response });
                return response;
            } catch (error) {
                logger.info('System workflow request failed', { type: 'SYSTEM_WORKFLOW_FAILURE', flowId, scenario: operation.scenario, sourceId: source.id, attempt, status: error.status, reason: error.message });
                const retryable = [401, 429, 502, 503, 504].includes(error.status) || ['ECONNRESET', 'ETIMEDOUT'].includes(error.code);
                if (attempt === retries || !retryable) throw error;
                const backoff = Math.min(1000, 100 * (2 ** attempt));
                if (remainingBudget() <= backoff) throw error;
                await sleep(backoff);
                remainingBudget();
            }
        }
        throw new Error('Workflow retries exhausted');
    };
}

module.exports = { CLIENTS, createSystemWorkflowClient, requestJson };
