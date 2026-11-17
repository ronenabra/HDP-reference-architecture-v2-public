'use strict';

/** Regressions for informational arrivals and unchanged completion severity/source. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
require('../../../test-support/team-config').installTestRuntime();
const { gatewayCompletion, gatewayRaw } = require('../../../test-support/gateway-log-fixture');
const { expandLogEntry, normalizeLogEntry, createUiApp } = require('../src/index');
const { createEventMetadata } = require('../../shared/log-event');

for (let index = 0; index < 6; index++) {
    const original = gatewayCompletion(index);
    test(`${original.level} ${original.details.url}: derived INFO preserves completion, timing, correlation and source`, () => {
        const source = { dir: 'ho-b-gateway', label: 'HO B Gateway', role: 'gateway', healthOrganizationId: 'ho-b' };
        const completion = normalizeLogEntry({ ...original, id: `completion-${index}`, component: source.label });
        completion.event = createEventMetadata(completion, source);
        const before = structuredClone(completion);
        const [request, response] = expandLogEntry(completion);
        assert.equal(request.level, 'INFO');
        assert.equal(response, completion);
        assert.deepEqual(response, before);
        assert.equal(request.id, `${response.id}-gateway-request`);
        assert.equal(request.timestamp, new Date(Date.parse(response.timestamp) - 13).toISOString());
        assert.equal(request.event.provenance.kind, 'derived');
        assert.equal(request.event.provenance.derivedFrom, response.id);
        assert.deepEqual(request.event.source, response.event.source);
        assert.deepEqual(request.event.correlation, response.event.correlation);
        for (const field of ['status', 'statusCode', 'upstreamStatus', 'upstreamAddr', 'upstreamResponseTime', 'authStatus', 'bytesSent']) {
            assert.equal(request.details[field], undefined);
        }
        for (const field of ['requestTime', 'requestId', 'correlationId', 'flowId', 'traceId', 'originalUrl', 'token', 'patient']) {
            assert.equal(request.details[field], response.details[field]);
        }
        assert.equal(request.details.type, 'GATEWAY_REQUEST');
        assert.match(request.event.provenance.note, /raw source is the gateway response/);
    });
}

test('native errors and non-gateway completion roles remain unchanged', () => {
    for (const details of [{ type: 'GATEWAY_ERROR', role: 'gateway' }, { type: 'GATEWAY_RESPONSE', role: 'security' }]) {
        const record = { ...gatewayCompletion(2), details };
        assert.deepEqual(expandLogEntry(record), [record]);
    }
});

test('informational projection does not relax raw binding or fixed sampling query boundaries', () => {
    const { classifyRequestBinding } = require('../../ds-auth-adapter/src/request-binding');
    const { assertSampleRequest, URI } = require('../../shared/sandbox-patients');
    assert.throws(() => classifyRequestBinding({ method: 'GET', uri: '//fhir/Observation?_count=10' }), /invalid/);
    assert.doesNotThrow(() => assertSampleRequest({ method: 'GET', uri: URI }));
    assert.throws(() => assertSampleRequest({ method: 'GET', uri: URI.replace('_count=10', '_count=11') }), /fixed projected Patient search/);
});

/** Read the actual UI HTTP route and fail immediately on an API error.
 * @param {string} base Owned listener origin.
 * @param {string} route API path.
 * @param {object} params Exact query fields.
 * @returns {Promise<object|object[]>} Parsed successful JSON response.
 */
async function get(base, route, params) {
    const response = await fetch(`${base}${route}?${new URLSearchParams(params)}`);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
}

test('HTTP browse, paging, detail, legacy references and live catch-up filter the selected projection', async t => {
    const directory = path.join(process.env.SHARED_LOGS_DIR, 'ho-b-gateway');
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, 'current.log');
    fs.writeFileSync(filename, Array.from({ length: 630 }, (_, index) => gatewayRaw(index)).join('\n') + '\n');
    const server = createUiApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const diagnostics of ['false', 'true']) for (const level of ['INFO', 'WARN', 'ERROR']) {
        const params = { page: 'true', role: 'gateway', healthOrganizationId: 'ho-b', diagnostics, level };
        const first = await get(base, '/api/unified-logs', params);
        const rows = [...first.entries];
        let cursor = first.nextCursor;
        let pages = 1;
        while (cursor) {
            const page = await get(base, '/api/unified-logs', { ...params, cursor });
            rows.push(...page.entries); cursor = page.nextCursor;
            assert.ok(++pages < 10, 'bounded fixture must finish');
        }
        assert.equal(rows.length, level === 'INFO' ? 840 : 210);
        assert.ok(pages > 1, 'exercise filtered pagination at every severity');
        assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
        assert.ok(rows.every(row => row.level === level));
        assert.equal(rows.filter(row => row.details.type === 'GATEWAY_REQUEST').length, level === 'INFO' ? 630 : 0);
        const samples = level === 'INFO'
            ? rows.filter(row => row.details.type === 'GATEWAY_REQUEST').slice(0, 6) : rows.slice(0, 2);
        for (const row of samples) {
            const selected = await get(base, '/api/unified-logs/detail', { reference: row.reference });
            const index = Number(row.details.correlationId.split('-').at(-1));
            assert.equal(selected.level, level); assert.equal(selected.entry.level, level);
            assert.equal(selected.entry.id, row.id);
            assert.equal(selected.details.type, row.details.type);
            assert.equal(selected.raw, gatewayRaw(index));
            assert.equal(selected.rawRedacted, false);
            assert.equal(selected.details.token, 'synthetic-non-AWS-token');
            assert.equal(selected.details.patient, 'Patient/synthetic-gateway');
            if (row.details.type === 'GATEWAY_REQUEST') {
                assert.equal(selected.details.status, undefined);
                assert.equal(selected.provenance.kind, 'derived');
                assert.equal(JSON.parse(selected.raw).level, gatewayCompletion(index).level);
            } else {
                assert.equal(selected.details.status, gatewayCompletion(index).details.status);
                const legacy = JSON.parse(Buffer.from(row.reference, 'base64url').toString());
                delete legacy.variant; delete legacy.digest;
                const detail = await get(base, '/api/unified-logs/detail', { reference: Buffer.from(JSON.stringify(legacy)).toString('base64url') });
                assert.equal(detail.details.type, 'GATEWAY_RESPONSE'); assert.equal(detail.level, level);
            }
        }
        const array = await get(base, '/api/unified-logs', { ...params, page: 'false' });
        assert.deepEqual(array.map(row => row.id), first.entries.map(row => row.id));
    }
    const params = { page: 'true', role: 'gateway', healthOrganizationId: 'ho-b' };
    const heads = new Map();
    for (const diagnostics of ['false', 'true']) for (const level of ['INFO', 'WARN', 'ERROR']) {
        heads.set(`${diagnostics}-${level}`, await get(base, '/api/unified-logs', { ...params, diagnostics, level }));
    }
    fs.appendFileSync(filename, Array.from({ length: 6 }, (_, index) => gatewayRaw(630 + index)).join('\n') + '\n');
    for (const diagnostics of ['false', 'true']) for (const level of ['INFO', 'WARN', 'ERROR']) {
        const live = await get(base, '/api/unified-logs', { ...params, diagnostics, level, cursor: heads.get(`${diagnostics}-${level}`).liveCursor });
        assert.equal(live.entries.length, level === 'INFO' ? 8 : 2);
        assert.ok(live.entries.every(row => row.level === level));
        assert.equal(live.entries.filter(row => row.details.type === 'GATEWAY_REQUEST').length, level === 'INFO' ? 6 : 0);
    }
});
