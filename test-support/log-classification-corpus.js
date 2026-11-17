'use strict';
/** Fabricated journey covering approved noise and real protocol evidence, never retained data. */
const fs = require('node:fs');
const path = require('node:path');
const FLOW = 'classification-journey';
const TRACE = '1234567890abcdef1234567890abcdef';
/** Return source-bound representative records with deliberately legacy/misclassified inputs. */
function records() {
    let index = 0;
    const row = (source, type, details = {}, level = 'INFO', message = type) => ({ source, timestamp: new Date(Date.UTC(2026, 10, 5) + index++ * 1000).toISOString(), level, message,
        details: { type, flowId: FLOW, correlationId: FLOW, traceId: TRACE, ...details } });
    return [
        row('sp-client', 'REQUEST', { url: '/selection', category: 'system', visibility: 'default', causesSystemFlow: true }),
        row('sp-client', 'RESPONSE', { url: '/selection', status: 302 }),
        row('ds-auth-adapter', undefined, {}, 'INFO', 'DS Auth Adapter listening on 3002'),
        row('ds-fhir-server', 'CONFORMANCE_MODE', {}, 'INFO', 'PCM conformance mode: connectathon (1)'),
        row('ds-fhir-server', 'PROCESS_RELOAD_FAILED', { stage: 'config', error: 'expected contract 0.4.2; received 0.4.0', payload: 'private-non-AWS-token' }, 'ERROR', 'DS FHIR config reload rejected'),
        row('ds-fhir-server', 'PROCESS_RELOAD_FAILED', { stage: 'prepare-listener' }, 'ERROR', 'DS FHIR server reload failed: key unavailable'),
        ...['REQUEST', 'RESPONSE', 'OUTGOING_REQUEST', 'OUTGOING_RESPONSE', 'OUTGOING_ERROR', 'TOKEN_ISSUED', 'DS_LOCAL_TOKEN_MINTED', 'TOKEN_MINTED', 'INTROSPECTION_PROCESSED', 'INTROSPECTION_TOKEN_REFRESH', 'INTROSPECTION_DECISION', 'IDENTITY_MAPPED', 'DS_AUTHORIZATION_DENIED', 'LOCAL_JWT_DISCOVERY', 'LOCAL_JWT_DISCOVERY_SUCCEEDED', 'LOCAL_JWT_METADATA_CACHE_HIT', 'LOCAL_JWT_JWKS_CACHE_HIT', 'LOCAL_JWT_VERIFIED'].map(type => row(type.startsWith('LOCAL_JWT') ? 'ds-fhir-server' : 'pcm-core', type,
            { url: '/api/fhir-service/r4/Patient?identifier=000000018', ...(type.endsWith('CACHE_HIT') ? { category: 'harness', visibility: 'diagnostic' } : {}) }, type.endsWith('ERROR') ? 'ERROR' : 'INFO')),
        row('ho-b-adapter', 'REQUEST', { url: '/auth-check', method: 'GET' }),
        ...['/auth', '/', '/favicon.ico', '/arbitrary-wrong-path'].flatMap(url => [
            row('ho-b-gateway', 'GATEWAY_RESPONSE', { url, method: 'GET', status: 404, requestTime: 0.01 }, 'WARN'),
            row('ho-b-gateway', 'GATEWAY_ERROR', { url, method: 'GET', headers: { 'user-agent': 'Mozilla/5.0' }, flowId: undefined, correlationId: undefined, traceId: undefined }, 'ERROR')]),
        row('sp-client', 'HARNESS_ACTION_FAILED', { error: 'synthetic local UI bookkeeping failed' }, 'ERROR'),
        row('pcm-core', 'UNKNOWN_FUTURE_EVENT', { flowId: undefined, correlationId: undefined, traceId: undefined }),
        ...['start', 'local-sso', 'fixture-start', 'verify', 'resend', 'cancel', 'local-code', 'discover', 'presence', 'presence-dependents', 'select'].flatMap(action => [
            row('pcm-core', 'REQUEST', { url: `/sandbox/authentication/${action}`, method: 'POST', visibility: 'default' }),
            row('pcm-core', 'SYSTEM_BROWSER_ACTION', { action, state: 'denied', visibility: 'default' }),
            row('pcm-core', 'RESPONSE', { url: `/sandbox/authentication/${action}`, status: 400, visibility: 'default' }, 'WARN')]),
        ...['SYSTEM_AUTHENTICATION', 'SYSTEM_OTP', 'SYSTEM_WORKFLOW_REQUEST', 'SYSTEM_WORKFLOW_RESPONSE', 'SYSTEM_WORKFLOW_FAILURE', 'SYSTEM_DISCOVERY', 'SYSTEM_PRESENCE', 'TOKEN_AUTHORIZATION_DENIED'].map(type =>
            row('pcm-core', type, { visibility: 'diagnostic', state: 'denied' }, type.endsWith('FAILURE') ? 'ERROR' : 'INFO'))
    ];
}
/** Write only into an explicitly owned temporary fixture root. */
function writeCorpus(root, { repeats = 3, padding = 0 } = {}) {
    const values = records();
    for (let i = 1; i < repeats; i++) values.push({ ...values[4], timestamp: new Date(Date.UTC(2026, 10, 5) + (100 + i) * 1000).toISOString() });
    for (let i = 0; i < padding; i++) values.push({ source: 'ds-fhir-server', timestamp: new Date(Date.UTC(2026, 10, 5) + (200 + i) * 1000).toISOString(), level: 'INFO', message: `padding ${i}`, details: { type: 'CONFORMANCE_MODE' } });
    const sources = [...new Set(values.map(row => row.source))];
    for (const source of sources) {
        const file = path.join(root, source, 'current.log'); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, values.filter(row => row.source === source).map(({ source: _, ...row }) => JSON.stringify(row)).join('\n') + '\n');
    }
    return { records: values.length, sources, flow: FLOW, trace: TRACE };
}
module.exports = { FLOW, TRACE, records, writeCorpus };

/** Small retained/new sanity-summary corpus with independent real errors for visibility comparisons. */
function writeSanityCorpus(root) {
    const summary = index => ({ timestamp: new Date(Date.UTC(2026, 10, 5) + index * 1000).toISOString(), level: 'ERROR',
        message: 'Sanity Check Failed', details: { type: 'SANITY_CHECK_FAILED', category: 'harness', visibility: index % 2 ? 'default' : 'diagnostic',
            causesSystemFlow: true, correlationId: 'sanity-summary', failedChecks: [{ name: 'synthetic source request', status: 'fail' }], stderr: 'owned runner unavailable' } });
    const values = Array.from({ length: 5 }, (_, index) => summary(index + 1));
    const streams = {
        'pcm-core': values,
        'ho-b-gateway': [{ timestamp: '2026-11-05T00:00:00.000Z', level: 'ERROR', message: 'Underlying gateway request failed', details: { type: 'GATEWAY_ERROR', url: '/wrong-path', method: 'GET' } },
            { timestamp: '2026-11-05T00:00:00.100Z', level: 'ERROR', message: 'Unrelated source uses same event name', details: { type: 'SANITY_CHECK_FAILED', visibility: 'default' } }],
        'ds-fhir-server': [{ timestamp: '2026-11-05T00:00:00.000Z', level: 'ERROR', message: 'Actual listener failure', details: { type: 'PROCESS_RELOAD_FAILED', stage: 'listener' } }]
    };
    for (const [source, records] of Object.entries(streams)) {
        const filename = path.join(root, source, 'current.log'); fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    return { summaries: values.length, sources: Object.keys(streams) };
}
module.exports.writeSanityCorpus = writeSanityCorpus;
