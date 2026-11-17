'use strict';

/** Bounded, observation-based connectathon smoke diagnostic for participant sources. */

const crypto = require('crypto');
const dns = require('dns').promises;
const { assertSafeOutboundUrl, guardedFetch } = require('../../shared/outbound-destination');

const DEFAULT_TIMEOUT_MS = 5000;

function classifyDiagnosticError(error, phase = '') {
    const code = String(error?.code || '');
    const message = String(error?.message || error || '').toLowerCase();
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'connectivity';
    if (code === 'ETIMEDOUT' || code === 'ABORT_ERR' || /timed? ?out|timeout/.test(message)) return 'timeout';
    if (/certificate required|alert certificate|required client certificate/.test(message)) return 'missing-client-certificate';
    if (/certificate|self.signed|unable to verify|tls|ssl/.test(message)) return 'tls-trust';
    if (/audience|resource indicator/.test(message) || phase === 'token-acquisition') return 'token-resource-audience';
    if (/inactive|introspection|unauthorized token/.test(message) || phase === 'introspection') return 'introspection-rejected';
    if (/malformed|json|content-type/.test(message)) return 'malformed-response';
    if (phase === 'fhir') return 'fhir-error';
    return 'unexpected';
}

function remediation(classification) {
    return ({
        dns: 'Verify the hostname is resolvable from the PCM container/network.',
        connectivity: 'Verify the participant service is running and its port/firewall permits this team.',
        timeout: 'Check participant latency and network routing, then retry; the diagnostic timeout is intentionally bounded.',
        'tls-trust': 'Install the correct participant CA/server certificate or select the documented local trust mode.',
        'missing-client-certificate': 'Configure the registered client certificate and key required by the participant endpoint.',
        'token-resource-audience': 'Make the token resource byte-for-byte equal to the registered FHIR Endpoint audience.',
        'introspection-rejected': 'Verify the source client, certificate binding, Endpoint state, and PCM introspection configuration.',
        'malformed-response': 'Return the documented JSON/FHIR response and content type from the participant endpoint.',
        'fhir-error': 'Inspect the participant FHIR OperationOutcome and gateway correlation ID.'
    })[classification] || 'Inspect the correlation ID in PCM and participant logs.';
}

async function bounded(label, action, timeoutMs) {
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
        }, timeoutMs);
    });
    try {
        const detail = await Promise.race([Promise.resolve().then(() => action(controller.signal)), timeout]);
        return { phase: label, status: 'pass', durationMilliseconds: Date.now() - started, ...(detail || {}) };
    } catch (error) {
        const classification = classifyDiagnosticError(error, label);
        return {
            phase: label,
            status: 'fail',
            durationMilliseconds: Date.now() - started,
            classification,
            remediation: remediation(classification)
        };
    } finally {
        clearTimeout(timer);
    }
}

async function diagnoseDataSource(source, options = {}) {
    const timeoutMs = Math.max(100, Math.min(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), 30000));
    const correlationId = options.correlationId || crypto.randomUUID();
    const fetcher = options.fetch;
    const lookup = options.lookup || dns.lookup;
    const url = new URL(source.endpoint);
    const actions = options.actions || {};
    const phases = [];
    const controls = options.controls || {};
    const probe = options.probe || {};
    let accessToken = probe.accessToken;
    const missing = (reason, status = 'not-tested') => ({ status, reason, observed: false });
    const execute = async (label, fallback) => {
        const result = await bounded(label, signal => (actions[label] || fallback)(signal), timeoutMs);
        phases.push(result);
        return result.status === 'pass';
    };
    if (!await execute('dns', async () => { await assertSafeOutboundUrl(source.endpoint, { lookup }); return { endpoint: url.origin }; })) return result();
    if (!await execute('connectivity-tls', async signal => {
        const response = await guardedFetch(source.endpoint, { signal, headers: { Accept: 'application/fhir+json', 'x-correlation-id': correlationId } }, { fetchImpl: fetcher, lookup, tls: options.tls });
        if (response.status >= 500) throw Object.assign(new Error(`FHIR ${response.status}`), { code: 'FHIR_HTTP' });
        return { endpoint: source.endpoint, httpStatus: response.status };
    })) return result();
    const metadataOk = await execute('metadata', async signal => {
        const response = await guardedFetch(new URL('metadata', `${source.endpoint.replace(/\/$/, '')}/`).toString(), { signal, headers: { Accept: 'application/fhir+json', 'x-correlation-id': correlationId } }, { fetchImpl: fetcher, lookup, tls: options.tls });
        if ([401, 403].includes(response.status)) return { ...missing('Metadata requires authorization; no CapabilityStatement was observed.'), endpoint: source.endpoint, httpStatus: response.status };
        if (!response.ok) throw new Error(`metadata endpoint returned ${response.status}`);
        const body = await response.json();
        if (body.resourceType !== 'CapabilityStatement') throw new Error('malformed metadata CapabilityStatement response');
        return { endpoint: source.endpoint, httpStatus: response.status, resourceType: body.resourceType, observed: true };
    });
    if (!metadataOk && phases.at(-1).status === 'fail') return result();
    if (!await execute('unauthenticated-access', async signal => {
        const response = await guardedFetch(`${source.endpoint.replace(/\/$/, '')}/Patient?_count=1`, { signal, headers: { Accept: 'application/fhir+json', 'x-correlation-id': correlationId } }, { fetchImpl: fetcher, lookup, tls: options.tls });
        const expected = [401, 403];
        if (!expected.includes(response.status)) throw new Error(`expected ${expected.join('/')}, received ${response.status}`);
        return { endpoint: source.endpoint, httpStatus: response.status, observed: true, expectation: 'bearer-required' };
    })) return result();
    const tokenOk = await execute('token-acquisition', async signal => {
        if (!probe.acquireToken || !probe.patient || !probe.consent) return missing('Supply an existing probe Patient, Consent and registered-client token exchange; readiness does not create authorization state.');
        const acquired = await probe.acquireToken({ signal, resource: source.endpoint });
        if (!acquired?.access_token || acquired.token_type !== 'Bearer') throw new Error('malformed token exchange response');
        accessToken = acquired.access_token;
        return { observed: true, outcome: 'token-exchange-completed' };
    });
    if (!tokenOk && phases.at(-1).status === 'fail') return result();
    const introspectionOk = await execute('introspection', async signal => {
        if (!accessToken || !probe.observeIntrospection) return missing('No authorized introspection observation is available from this source.');
        const decision = await probe.observeIntrospection({ signal, accessToken });
        if (decision?.active !== true) throw new Error('inactive introspection result');
        return { observed: true, outcome: 'active-introspection-observed' };
    });
    if (!introspectionOk && phases.at(-1).status === 'fail') return result();
    await execute('fhir', async signal => {
        if (controls.oauthBearer !== false && (!accessToken || !probe.patient)) return missing('An authorized probe token and explicit synthetic Patient are required.');
        const probeUrl = new URL(probe.path || 'Observation?_count=1', `${source.endpoint.replace(/\/$/, '')}/`);
        const sourceUrl = new URL(source.endpoint);
        if (probeUrl.origin !== sourceUrl.origin || !probeUrl.pathname.startsWith(`${sourceUrl.pathname.replace(/\/$/, '')}/`)) throw new Error('probe resource audience differs from the configured source');
        const response = await guardedFetch(probeUrl.toString(), {
            signal, headers: { Accept: 'application/fhir+json', 'x-correlation-id': correlationId,
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }
        }, { fetchImpl: fetcher, lookup, tls: options.tls });
        if (!response.ok) throw new Error(`FHIR ${response.status}`);
        const body = await response.json();
        if (!['Bundle', 'Observation', 'Patient'].includes(body.resourceType)) throw new Error('malformed clinical FHIR response');
        return { observed: true, httpStatus: response.status, resourceType: body.resourceType,
            outcome: accessToken ? 'authenticated-clinical-response' : 'anonymous-synthetic-response' };
    });
    return result();

    function result() {
        return {
            schemaVersion: 'pcm-source-readiness/2',
            label: 'CONNECTATHON SMOKE DIAGNOSTIC — NOT A CONFORMANCE VERDICT',
            correlationId,
            sourceId: source.id,
            endpoint: source.endpoint,
            status: phases.some(phase => phase.status === 'fail') ? 'fail' : phases.some(phase => phase.status === 'not-tested') ? 'partial' : 'pass',
            coverage: {
                observedPhases: phases.filter(phase => phase.status === 'pass').length,
                untestedPhases: phases.filter(phase => phase.status === 'not-tested').map(phase => phase.phase),
                authenticatedClinical: phases.some(phase => phase.outcome === 'authenticated-clinical-response')
            },
            effectiveControls: controls,
            durationMilliseconds: phases.reduce((sum, phase) => sum + phase.durationMilliseconds, 0),
            phases
        };
    }
}

module.exports = { classifyDiagnosticError, diagnoseDataSource, remediation };
