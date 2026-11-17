'use strict';
/** Stateless emitted/fallback gateway identity across bounded reader contracts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { arrival, completion } = require('../../../test-support/gateway-arrival-fixture');
const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
const { readUnifiedPage, readUnifiedDetail, ROW_LIMIT, READ_BUDGET } = require('../src/unified-log-page');
const { readComponentLogRecords } = require('../src/log-reader');
const { clearConfiguredLogs } = require('../src/log-clear');
const { createLogSearch } = require('../src/log-search');
const sources = ['a', 'b'].map(id => ({ dir: `ho-${id}-gateway`, label: `HO ${id} Gateway`, role: 'gateway', healthOrganizationId: `ho-${id}` }));
const normalize = entry => expandLogEntry(normalizeLogEntry(entry));

/** Create only disposable files and bound search worker lifetime to each test. */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-arrival-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, write(records, source = sources[0], file = 'current.log') {
        const filename = path.join(root, source.dir, file); fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
        return filename;
    } };
}

for (const url of ['/fhir/Observation?_count=10', '/auth']) {
    test(`${url}: actual observation has own raw/emitted provenance; successful completion marker suppresses fallback`, t => {
        const f = fixture(t), first = arrival(1, { url, token: 'non-AWS-token' }), last = completion(1, { url });
        f.write([first, last]);
        const page = readUnifiedPage(f.root, sources, {}, '', normalize);
        assert.equal(page.entries.length, 2);
        const request = page.entries.find(row => row.details.type === 'GATEWAY_REQUEST');
        assert.equal(request.event.provenance.kind, 'emitted'); assert.equal(request.level, 'INFO');
        assert.equal(request.timestamp, '2026-11-05T10:00:00.001Z');
        const detail = readUnifiedDetail(f.root, sources, request.reference, normalize);
        assert.equal(detail.raw, JSON.stringify(first)); assert.equal(detail.details.token, 'non-AWS-token');
        assert.equal(detail.provenance.kind, 'emitted'); assert.equal(detail.details.status, undefined);
        assert.equal(page.entries.find(row => row.details.type === 'GATEWAY_RESPONSE').level, 'ERROR');
    });
}

test('only a valid successful protocol marker suppresses historical INFO reconstruction', () => {
    for (const extra of [{ arrivalId: '' }, { arrivalId: 'bad' }, { arrivalProtocol: undefined }, { arrivalProtocol: 'other' }]) {
        const [request, response] = normalize(completion(1, extra));
        assert.equal(request.level, 'INFO'); assert.equal(request.event.provenance.kind, 'derived');
        assert.equal(response.level, 'ERROR'); assert.equal(request.details.status, undefined);
    }
});

test('concurrent and reused correlation IDs, same identities on different sources, and auth remain separate', t => {
    const f = fixture(t), records = [arrival(1), arrival(2), arrival(3, { url: '/auth', parentArrivalId: arrival(1).details.arrivalId }), completion(2), completion(3, { url: '/auth' }), completion(1)];
    for (const source of sources) f.write(records, source);
    for (const order of ['timeline', 'flow']) {
        const page = readUnifiedPage(f.root, sources, { order }, '', normalize);
        assert.equal(page.entries.length, 12);
        assert.equal(page.entries.filter(row => row.details.type === 'GATEWAY_REQUEST').length, 6);
        assert.equal(new Set(page.entries.map(row => row.id)).size, 12);
        assert.equal(new Set(page.entries.map(row => row.event.source.componentId)).size, 2);
    }
});

test('mixed legacy/new records pair across pages and rotations with no cross-page pairing state', t => {
    const f = fixture(t), count = 240;
    f.write(Array.from({ length: count }, (_, index) => arrival(index + 1)), sources[0], 'history/2026-11-04/app.log');
    const records = Array.from({ length: count }, (_, index) => completion(index + 1));
    records.push(completion(1001, { arrivalId: '' }));
    f.write(records);
    let cursor = '', rows = [], pages = 0;
    do {
        const page = readUnifiedPage(f.root, sources, {}, cursor, normalize);
        assert.ok(page.entries.length <= ROW_LIMIT); assert.ok(page.bytesRead <= READ_BUDGET);
        assert.ok((page.nextCursor || '').length < 65536);
        rows.push(...page.entries); cursor = page.nextCursor; assert.ok(++pages < 10);
    } while (cursor);
    assert.equal(rows.length, count * 2 + 2);
    assert.equal(rows.filter(row => row.event.provenance.kind === 'derived').length, 1);
    assert.equal(rows.filter(row => row.event.provenance.kind === 'emitted' && row.details.type === 'GATEWAY_REQUEST').length, count);
    // A retained completion whose actual arrival has expired still does not invent
    // a second request or claim the arrival is in the current retention window.
    fs.rmSync(path.join(f.root, sources[0].dir, 'history'), { recursive: true });
    const retained = readUnifiedPage(f.root, sources, {}, '', normalize);
    assert.equal(retained.entries.filter(row => row.details.type === 'GATEWAY_REQUEST').length, 1);
    assert.equal(retained.entries.find(row => row.details.type === 'GATEWAY_REQUEST').event.provenance.kind, 'derived');
});

test('live early arrival stays independent of future completion; clear/export/AWS preserve boundaries', t => {
    const f = fixture(t), filename = f.write([]);
    const head = readUnifiedPage(f.root, sources, {}, '', normalize);
    const first = arrival(1, { token: 'non-AWS-token', AWS_SECRET_ACCESS_KEY: 'fake-secret-never-return' });
    fs.appendFileSync(filename, JSON.stringify(first) + '\n');
    const live = readUnifiedPage(f.root, sources, {}, head.liveCursor, normalize);
    assert.equal(live.entries.length, 1); assert.equal(live.entries[0].details.type, 'GATEWAY_REQUEST');
    const detail = readUnifiedDetail(f.root, sources, live.entries[0].reference, normalize);
    assert.equal(detail.details.token, 'non-AWS-token'); assert.equal(detail.rawRedacted, true);
    assert.doesNotMatch(JSON.stringify(detail), /fake-secret-never-return/);
    fs.appendFileSync(filename, JSON.stringify(completion(1)) + '\n');
    const after = readUnifiedPage(f.root, sources, {}, live.liveCursor, normalize);
    assert.equal(after.entries.length, 1); assert.equal(after.entries[0].details.type, 'GATEWAY_RESPONSE');
    fs.appendFileSync(filename, JSON.stringify(arrival(2)) + '\n');
    const exported = readComponentLogRecords(f.root, sources[0].dir, sources[0].label, { allHistory: true, source: sources[0] });
    assert.equal(exported.length, 3); assert.doesNotMatch(JSON.stringify(exported), /fake-secret-never-return/);
    assert.equal(clearConfiguredLogs(f.root, sources).status, 'cleared');
    assert.throws(() => readUnifiedDetail(f.root, sources, live.entries[0].reference, normalize), /cleared|changed|Invalid log record reference/);
    fs.appendFileSync(filename, JSON.stringify(arrival(3)) + '\n');
    const afterClear = readUnifiedPage(f.root, sources, {}, '', normalize);
    assert.equal(afterClear.entries.length, 1); assert.equal(afterClear.entries[0].level, 'INFO');
    assert.equal(afterClear.entries[0].details.status, undefined);
});

test('retained worker search returns one actual request per completion and honest historical fallback', async t => {
    const f = fixture(t), service = createLogSearch(); t.after(() => service.close());
    f.write([arrival(1), arrival(2, { url: '/auth', parentArrivalId: arrival(1).details.arrivalId }), completion(2, { url: '/auth' }), completion(1), completion(3, { arrivalId: '' })]);
    const job = service.start(f.root, sources, { correlationId: 'reused-correlation' });
    let result;
    const deadline = Date.now() + 10000;
    do {
        result = service.read(job.id, f.root, sources);
        if (result.state !== 'running') break;
        assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
    } while (true);
    assert.equal(result.state, 'complete'); assert.equal(result.entries.length, 6);
    assert.equal(result.entries.filter(row => row.details.type === 'GATEWAY_REQUEST').length, 3);
    assert.equal(result.entries.filter(row => row.event.provenance.kind === 'derived').length, 1);
});
