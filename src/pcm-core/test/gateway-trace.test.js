'use strict';
/** Configured-source trust and clock/restart fidelity for the measured gateway bridge. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readUnifiedPage, readUnifiedDetail } = require('../src/unified-log-page');
const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
const { arrival, completion } = require('../../../test-support/gateway-arrival-fixture');
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

test('gateway span metadata retains observed links/raw bytes while configured HO overrides caller claims', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-trace-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sources = ['a', 'b'].map(letter => ({ dir: `ho-${letter}-gateway`, role: 'gateway', label: `HO ${letter}`, healthOrganizationId: `ho-${letter}` }));
    const normalize = value => expandLogEntry(normalizeLogEntry(value));
    for (const source of sources) {
        fs.mkdirSync(path.join(root, source.dir));
        const details = { traceId: TRACE, spanId: '1111111111111111', parentSpanId: '00f067aa0ba902b7', traceFlags: '01', spanKind: 'server', healthOrganizationId: 'forged-ho', componentRole: 'pcm', token: 'ordinary-synthetic', AWS_SECRET_ACCESS_KEY: 'blocked-canary' };
        const records = [arrival(1, details), completion(1, details)];
        fs.writeFileSync(path.join(root, source.dir, 'current.log'), records.map(JSON.stringify).join('\n') + '\n');
    }
    const page = readUnifiedPage(root, sources, { traceId: TRACE }, '', normalize);
    assert.equal(page.entries.length, 4);
    for (const row of page.entries) {
        assert.equal(row.event.source.role, 'gateway');
        assert.equal(row.event.source.healthOrganizationId, row.event.source.componentId.slice(0, 4));
        assert.equal(row.event.correlation.parentSpanId, '00f067aa0ba902b7');
        const detail = readUnifiedDetail(root, sources, row.reference, normalize);
        assert.equal(detail.details.token, 'ordinary-synthetic');
        assert.doesNotMatch(detail.raw, /blocked-canary/);
        assert.equal(JSON.parse(detail.raw).details.traceId, TRACE);
    }
    assert.equal(readUnifiedPage(root, sources, { healthOrganizationId: 'ho-a', traceId: TRACE }, '', normalize).entries.length, 2);
});

test('clock rollback and a restarted writer retain distinct source coordinates and recorded parent links', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-clock-restart-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = { dir: 'ho-a-gateway', label: 'A gateway', role: 'gateway', healthOrganizationId: 'ho-a' };
    fs.mkdirSync(path.join(root, source.dir));
    const first = arrival(1, { traceId: TRACE, spanId: '1111111111111111', timestampEpoch: '1794000001.100' });
    const child = arrival(2, { traceId: TRACE, spanId: '2222222222222222', parentSpanId: '1111111111111111', url: '/auth', timestampEpoch: '1794000000.100' });
    const restarted = arrival(3, { traceId: TRACE, spanId: '3333333333333333', timestampEpoch: '1793999999.100' });
    fs.writeFileSync(path.join(root, source.dir, 'current.log'), [first, child, restarted].map(JSON.stringify).join('\n') + '\n');
    const normalize = value => expandLogEntry(normalizeLogEntry(value));
    const page = readUnifiedPage(root, [source], { order: 'timeline', tail: 'bottom' }, '', normalize);
    assert.equal(new Set(page.entries.map(row => row.id)).size, 3);
    assert.deepEqual(page.entries.map(row => row.details.spanId), ['3333333333333333', '2222222222222222', '1111111111111111']);
    const linked = page.entries.find(row => row.details.spanId === '2222222222222222');
    assert.equal(linked.event.correlation.parentSpanId, '1111111111111111');
    const detail = readUnifiedDetail(root, [source], linked.reference, normalize);
    assert.equal(detail.raw, JSON.stringify(child));
    assert.equal(detail.entry.details.parentSpanId, '1111111111111111');
    assert.match(page.coverage.note, /complete/i);
});
