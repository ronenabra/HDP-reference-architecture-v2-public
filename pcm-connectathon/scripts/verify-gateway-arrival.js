#!/usr/bin/env node
'use strict';
/** Verify actual NGINX phases, identity and retained reader behavior in an owned
 * network-isolated fixture. Never creates, discovers or changes a retained team.
 * Requires gateway-arrival-fixture-server.js and explicitly selected local ports.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { setTimeout: delay } = require('node:timers/promises');
const { readUnifiedPage, readUnifiedDetail } = require('../../src/pcm-core/src/unified-log-page');
const { normalizeLogEntry, expandLogEntry } = require('../../src/pcm-core/src/log-normalization');
const directory = process.env.ARRIVAL_FIXTURE_DIR || '/fixture';
const normalize = entry => expandLogEntry(normalizeLogEntry(entry));
const standalone = process.env.ARRIVAL_STANDALONE === 'true';
const runId = Date.now().toString(36);
const sources = standalone ? [{ id: 'ho-b', port: 8080, organization: 'reference' }]
    : ['a', 'b', 'c'].map((suffix, i) => ({ id: `ho-${suffix}`, port: 8442 + i, organization: `ho-${suffix}` }));
// B's existing browser gateway uses 8443; A and C are the adjacent isolated ports.
const components = sources.map(source => ({ dir: `${source.id}-gateway`, label: `${source.id} Gateway`, role: 'gateway', healthOrganizationId: source.id }));
const tls = { rejectUnauthorized: false, key: fs.readFileSync(path.join(directory, 'certs/client.key')), cert: fs.readFileSync(path.join(directory, 'certs/client.crt')) };

/** Send real TLS HTTP traffic; preserve exact method/URL/correlation input. */
function request(source, uri, correlationId, method = 'GET') {
    return new Promise((resolve, reject) => {
        const outgoing = https.request({ ...tls, hostname: '127.0.0.1', port: source.port, path: uri, method,
            headers: { Authorization: 'Bearer fixture-public-token', 'X-Correlation-Id': correlationId,
                'X-Flow-Id': 'runtime-arrival-flow', 'X-Local-Token': 'spoofed-private-token',
                'X-PCM-Import-Credential': 'spoofed-import-credential', 'X-PCM-Request-URI': '/spoofed' } }, response => {
            response.resume(); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
        }); outgoing.on('error', reject); outgoing.end();
    });
}
/** Select only the real JSON source lines from this source and correlation. */
function records(source, correlationId) {
    return fs.readFileSync(path.join(directory, 'logs', `${source.id}-gateway/current.log`), 'utf8')
        .split('\n').filter(Boolean).map(JSON.parse).filter(record => record.details?.correlationId === correlationId);
}
/** Client response delivery can precede NGINX log-phase append by one event turn. */
async function completed(source, correlationId, expectedCount) {
    const deadline = Date.now() + 2000;
    let observed;
    do {
        observed = records(source, correlationId);
        if (observed.length >= expectedCount) return observed;
        assert.ok(Date.now() < deadline, 'native completion append must become observable');
        await delay(5);
    } while (true);
}
/** Verify main/auth identities do not collapse despite shared request/correlation IDs. */
async function paired(source, correlationId, expectedStatus, { expectedCount = 4, originalUrl, method = 'GET' } = {}) {
    const observed = await completed(source, correlationId, expectedCount);
    assert.equal(observed.length, expectedCount, `${source.id}: ${correlationId}`);
    const requests = observed.filter(record => record.details.type === 'GATEWAY_REQUEST');
    const responses = observed.filter(record => record.details.type === 'GATEWAY_RESPONSE');
    assert.equal(requests.length, expectedCount / 2); assert.equal(responses.length, expectedCount / 2);
    assert.equal(new Set(requests.map(record => record.details.arrivalId)).size, requests.length);
    for (const record of requests) {
        const completion = responses.find(item => item.details.arrivalId === record.details.arrivalId);
        assert.ok(completion, 'one source-local completion per actual observation');
        assert.equal(record.level, 'INFO'); assert.ok(record.timestamp); assert.ok(record.details.timestampEpoch);
        assert.equal(record.details.healthOrganizationId, source.organization);
        assert.equal(record.details.flowId, 'runtime-arrival-flow');
        assert.ok(Number(record.details.timestampEpoch) <= Number(completion.details.timestampEpoch));
        if (originalUrl) assert.equal(record.details.originalUrl, originalUrl);
        assert.equal(normalize(completion).length, 1);
    }
    const main = requests.find(record => record.details.url !== '/auth');
    assert.equal(main.details.method, method);
    assert.equal(responses.find(record => record.details.arrivalId === main.details.arrivalId).details.status, String(expectedStatus));
    if (expectedCount === 4) assert.equal(requests.find(record => record.details.url === '/auth').details.parentArrivalId, main.details.arrivalId);
    return { source: source.id, arrivals: requests.length, completions: responses.length, status: expectedStatus };
}

/** Run the narrow gateway matrix and write a compact machine-readable result. */
async function main() {
    const results = [];
    const presets = standalone ? ['standalone'] : ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict'];
    for (const preset of presets) {
        if (!standalone) {
            const response = await fetch(`http://127.0.0.1:43186/fixture/preset?preset=${preset}`, { method: 'POST' });
            assert.equal(response.status, 200); await delay(1600);
        }
        for (const source of sources) {
            for (const [scenario, expectedStatus] of [['success', 200], ['rejected', 401], ['upstream-error', 502]]) {
                const correlationId = `runtime-${runId}-${preset}-${source.id}-${scenario}`;
                const uri = `/fhir/Observation?scenario=${scenario}`;
                const outcome = await request(source, uri, correlationId);
                assert.equal(outcome.status, expectedStatus);
                assert.equal(outcome.headers['x-correlation-id'], correlationId);
                assert.equal(outcome.headers['x-flow-id'], 'runtime-arrival-flow');
                if (!standalone) assert.equal(outcome.headers['x-pcm-conformance-mode'] || '', preset === 'strict' ? '' : 'connectathon');
                results.push({ preset, scenario, ...await paired(source, correlationId, expectedStatus, { originalUrl: uri }) });
            }
            const shared = `runtime-${runId}-${preset}-${source.id}-reused`;
            const replies = await Promise.all(Array.from({ length: 8 }, () => request(source, '/fhir/Observation?scenario=success', shared)));
            assert.ok(replies.every(reply => reply.status === 200));
            const concurrent = await completed(source, shared, 32);
            assert.equal(concurrent.length, 32);
            assert.equal(new Set(concurrent.filter(record => record.details.type === 'GATEWAY_REQUEST').map(record => record.details.arrivalId)).size, 16);
            assert.equal(new Set(concurrent.filter(record => record.details.type === 'GATEWAY_RESPONSE').map(record => record.details.arrivalId)).size, 16);
            results.push({ preset, source: source.id, scenario: 'concurrent-reused-correlation', requests: 8, arrivals: 16, completions: 16 });
            const correlationId = `quote"backslash\\tab\t-${runId}-${preset}-${source.id}`;
            const uri = '/fhir/Observation?scenario=success&quote="&backslash=\\';
            assert.equal((await request(source, uri, correlationId)).status, 200);
            results.push({ preset, scenario: 'json-escaping', ...await paired(source, correlationId, 200, { originalUrl: uri }) });
            const wrong = `runtime-${runId}-${preset}-${source.id}-wrong-path`;
            assert.equal((await request(source, '/arbitrary-wrong-path', wrong)).status, 404);
            results.push({ preset, scenario: 'wrong-path', ...await paired(source, wrong, 404, { expectedCount: 2, originalUrl: '/arbitrary-wrong-path' }) });
            const root = `runtime-${runId}-${preset}-${source.id}-root-post`;
            assert.equal((await request(source, '/fhir?scenario=success', root, 'POST')).status, 200);
            results.push({ preset, scenario: 'root-post', ...await paired(source, root, 200, { originalUrl: '/fhir?scenario=success', method: 'POST' }) });
        }
    }
    // Check the actual captured private relay requests after native auth succeeds.
    const observed = await (await fetch('http://127.0.0.1:43186/fixture/state')).json();
    const forwarded = observed.requests.filter(item => !item.isAuth && item.headers['x-correlation-id']?.startsWith(`runtime-${runId}-`));
    assert.ok(forwarded.length);
    for (const item of forwarded) {
        assert.equal(item.headers['x-pcm-import-credential'], undefined);
        assert.notEqual(item.headers['x-pcm-request-uri'], '/spoofed');
        if (standalone) { assert.equal(item.headers.authorization, 'Bearer fixture-private-token'); assert.equal(item.headers['x-local-token'], undefined); }
        else { assert.equal(item.headers.authorization, undefined); assert.equal(item.headers['x-local-token'], 'fixture-private-token'); }
    }
    for (const order of ['flow', 'timeline']) {
        const page = readUnifiedPage(path.join(directory, 'logs'), components, { order }, '', normalize);
        assert.ok(page.bytesRead <= 1048576); assert.ok(page.entries.length <= 200);
        assert.ok(page.entries.every(row => row.event.provenance.kind === 'emitted'));
        const arrival = page.entries.find(row => row.details.type === 'GATEWAY_REQUEST');
        const detail = readUnifiedDetail(path.join(directory, 'logs'), components, arrival.reference, normalize);
        assert.equal(JSON.parse(detail.raw).details.type, 'GATEWAY_REQUEST');
    }
    const result = { node: process.version, configuration: standalone ? 'standalone' : 'managed-three-HO', scenarios: results.length, results,
        privateForwarding: 'verified', boundedViews: ['flow', 'timeline'] };
    fs.writeFileSync(path.join(directory, 'artifacts', standalone ? 'standalone-runtime.json' : 'managed-runtime.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ configuration: result.configuration, scenarios: result.scenarios, status: 'PASS' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
