'use strict';
/** Byte paging, full-detail retention, clear scope and active-writer regressions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUnifiedPage, readUnifiedDetail, READ_BUDGET, ROW_LIMIT, MAX_LINE } = require('../src/unified-log-page');
const { clearConfiguredLogs } = require('../src/log-clear');
const { configuredLogComponents } = require('../src/log-ordering');
const { buildTeamConfig } = require('../../../test-support/team-config');

/** Write an isolated log stream, retaining append handles for the clear test. */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-page-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (dir, records, file = 'current.log') => {
        const name = path.join(root, dir, file);
        fs.mkdirSync(path.dirname(name), { recursive: true });
        fs.writeFileSync(name, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
        return name;
    };
    return { root, write };
}
function record(index, extra = {}) {
    return { timestamp: new Date(Date.UTC(2026, 9, 4) + index * 1000).toISOString(), level: 'INFO',
        message: `record ${index}`, details: { type: 'REQUEST', category: 'system', visibility: 'default', ...extra } };
}
const components = [{ dir: 'pcm-core', label: 'PCM Core', role: 'pcm' },
    { dir: 'sp-client', label: 'Doctor App', role: 'doctor' }];

test('10,000 mixed records page within byte/row/response bounds with complete selected details', t => {
    const { root, write } = fixture(t);
    const payload = 'non-AWS token Patient/123 <script>literal</script> '.repeat(70);
    write('pcm-core', Array.from({ length: 5000 }, (_, i) => record(i * 2, { payload })));
    write('sp-client', Array.from({ length: 5000 }, (_, i) => record(i * 2 + 1, { payload })), 'history/2026-10-03/app.log');
    const ids = new Set();
    let cursor = '';
    let pages = 0;
    do {
        const page = readUnifiedPage(root, components, { order: 'timeline', tail: 'top' }, cursor);
        assert.ok(page.entries.length <= ROW_LIMIT);
        assert.ok(page.bytesRead <= READ_BUDGET);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
        for (const entry of page.entries) {
            assert.equal(ids.has(entry.id), false, `duplicate ${entry.id}`);
            ids.add(entry.id);
            assert.equal(entry.details.payload, undefined);
        }
        if (pages === 0) {
            assert.equal(page.entries[0].message, 'record 9999');
            assert.equal(readUnifiedDetail(root, components, page.entries[0].reference).details.payload, payload);
        }
        cursor = page.nextCursor;
        pages++;
    } while (cursor && pages < 1000);
    assert.equal(cursor, null);
    assert.equal(ids.size, 10000);
});

test('malformed, multibyte, oversized and sparse-filter pages advance without inventing records', t => {
    const { root, write } = fixture(t);
    write('pcm-core', [record(1), 'null', '{malformed', record(2, { payload: 'ז'.repeat(200000) }), record(3)]);
    let cursor = '';
    const messages = [];
    let oversized = 0;
    do {
        const page = readUnifiedPage(root, components, {}, cursor);
        messages.push(...page.entries.map(entry => entry.message));
        oversized += page.skippedLongLines;
        cursor = page.nextCursor;
    } while (cursor);
    assert.equal(oversized, 1);
    assert.ok(messages.includes('null'));
    assert.ok(messages.includes('{malformed'));
    assert.ok(messages.includes('record 1'));
    assert.ok(messages.includes('record 3'));
    const empty = readUnifiedPage(root, components, { role: 'doctor' });
    assert.equal(empty.entries.length, 0);
    assert.equal(empty.nextCursor, null);
});

test('exact role/HO filters survive paging and snapshot excludes concurrent appends', t => {
    const { root, write } = fixture(t);
    const list = [{ dir: 'ho-a-adapter', label: 'A Adapter', role: 'adapter', healthOrganizationId: 'ho-a' }];
    const filename = write(list[0].dir, Array.from({ length: 500 }, (_, i) => record(i)));
    const filters = { role: 'adapter', healthOrganizationId: 'ho-a', order: 'flow' };
    const first = readUnifiedPage(root, list, filters);
    fs.appendFileSync(filename, JSON.stringify(record(600)) + '\n');
    const second = readUnifiedPage(root, list, filters, first.nextCursor);
    assert.ok(second.entries.every(entry => entry.details.healthOrganizationId === 'ho-a'));
    assert.ok(second.entries.every(entry => entry.details.role === 'adapter'));
    assert.ok(second.entries.every(entry => entry.message !== 'record 600'));
    assert.ok(second.entries.some(entry => entry.flowGroup));
    assert.throws(() => readUnifiedPage(root, list, { ...filters, role: 'doctor' }, first.nextCursor), /filters changed/);
    assert.throws(() => readUnifiedPage(root, list, filters, '../../secret'), /Invalid/);
    assert.throws(() => readUnifiedDetail(root, list, Buffer.from(JSON.stringify({ name: '../secret', start: 0, end: 5 })).toString('base64url')), /Invalid/);
    fs.renameSync(filename, filename + '.old');
    fs.writeFileSync(filename, JSON.stringify(record(700)) + '\n');
    assert.throws(() => readUnifiedPage(root, list, filters, first.nextCursor), /changed|cleared/);
});

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) {
    test(`bidirectional ${order}/${tail} reloads all evicted records within fixed read/cursor bounds`, t => {
        const { root, write } = fixture(t);
        const filenames = components.map((component, componentIndex) => write(component.dir,
            Array.from({ length: 550 }, (_, index) => record(index * 2 + componentIndex,
                { flowId: `flow-${Math.floor(index / 7)}`, payload: 'bounded synthetic payload '.repeat(340) }))));
        const filters = { order, tail };
        let page = readUnifiedPage(root, components, filters);
        assert.equal(page.previousCursor, null);
        const olderIds = new Set();
        let reads = 0;
        do {
            assert.ok(page.bytesRead <= READ_BUDGET);
            assert.ok(page.entries.length <= ROW_LIMIT);
            for (const entry of page.entries) { assert.equal(olderIds.has(entry.id), false); olderIds.add(entry.id); }
            if (!page.nextCursor) break;
            page = readUnifiedPage(root, components, filters, page.nextCursor);
            assert.ok(++reads < 100);
        } while (true);
        assert.equal(olderIds.size, 1100);
        filenames.forEach(filename => fs.appendFileSync(filename, JSON.stringify(record(10000)) + '\n'));
        const newerIds = new Set(page.entries.map(entry => entry.id));
        reads = 0;
        while (page.previousCursor) {
            assert.ok(page.previousCursor.length <= 32000);
            page = readUnifiedPage(root, components, filters, page.previousCursor);
            assert.ok(page.bytesRead <= READ_BUDGET);
            assert.ok(page.entries.length <= ROW_LIMIT);
            for (const entry of page.entries) {
                assert.equal(newerIds.has(entry.id), false, `duplicate newer record ${entry.id}`);
                newerIds.add(entry.id);
                assert.notEqual(entry.message, 'record 10000');
            }
            assert.ok(++reads < 100);
        }
        assert.deepEqual(newerIds, olderIds);
        assert.ok(page.nextCursor, 'older pages can be loaded again after reaching the snapshot head');
    });
}

test('newer continuations cross empty filtered pages, oversized lines and raw line endings safely', t => {
    const { root, write } = fixture(t);
    const filename = write('pcm-core', Array.from({ length: 420 }, (_, index) => record(index,
        { method: index % 70 === 0 ? 'POST' : 'GET', payload: 'x'.repeat(10000) })));
    fs.appendFileSync(filename, 'X'.repeat(3 * READ_BUDGET + MAX_LINE) + '\r\n' + JSON.stringify(record(900, { method: 'POST' })));
    const filters = { method: 'POST' };
    let page = readUnifiedPage(root, components, filters);
    const expected = new Set();
    do {
        page.entries.forEach(entry => expected.add(entry.id));
        if (!page.nextCursor) break;
        page = readUnifiedPage(root, components, filters, page.nextCursor);
    } while (true);
    const restored = new Set(page.entries.map(entry => entry.id));
    let emptyPages = 0;
    while (page.previousCursor) {
        page = readUnifiedPage(root, components, filters, page.previousCursor);
        if (!page.entries.length) emptyPages++;
        assert.ok(page.bytesRead <= READ_BUDGET);
        for (const entry of page.entries) { assert.equal(restored.has(entry.id), false); restored.add(entry.id); }
    }
    assert.ok(emptyPages > 0);
    assert.equal(expected.size, 7);
    assert.deepEqual(restored, expected);
});

test('newer cursors enforce filter, generation, file identity and snapshot-size validation', t => {
    const { root, write } = fixture(t);
    const filename = write('pcm-core', Array.from({ length: 500 }, (_, index) => record(index)));
    const first = readUnifiedPage(root, components);
    const second = readUnifiedPage(root, components, {}, first.nextCursor);
    assert.ok(second.previousCursor);
    assert.throws(() => readUnifiedPage(root, components, { method: 'POST' }, second.previousCursor), /filters changed/);
    const zlib = require('node:zlib');
    const state = JSON.parse(zlib.inflateRawSync(Buffer.from(second.previousCursor.slice(3), 'base64url')));
    const invalid = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    assert.throws(() => readUnifiedPage(root, components, {}, invalid({ ...state, direction: 'sideways' })), /direction/);
    assert.throws(() => readUnifiedPage(root, components, {}, invalid({ ...state, files: state.files.map(file => ({ ...file, size: 'infinite' })) })), /offset|changed/);
    fs.truncateSync(filename, 0);
    assert.throws(() => readUnifiedPage(root, components, {}, second.previousCursor), /changed|cleared/);
});

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) {
    test(`live checkpoint ${order}/${tail} drains a burst larger than the cache and fixes each target`, t => {
        const { root, write } = fixture(t);
        const files = components.map((source, componentIndex) => write(source.dir,
            Array.from({ length: 100 }, (_, index) => record(index * 2 + componentIndex))));
        const filters = { order, tail };
        const initial = readUnifiedPage(root, components, filters);
        files.forEach((file, componentIndex) => fs.appendFileSync(file,
            Array.from({ length: 750 }, (_, index) => JSON.stringify(record((index + 100) * 2 + componentIndex, { payload: 'x'.repeat(7000) }))).join('\n') + '\n'));
        let page = readUnifiedPage(root, components, filters, initial.liveCursor);
        files.forEach((file, componentIndex) => fs.appendFileSync(file,
            Array.from({ length: 100 }, (_, index) => JSON.stringify(record((index + 850) * 2 + componentIndex))).join('\n') + '\n'));
        const seen = new Set();
        let pages = 0;
        do {
            assert.ok(page.bytesRead <= READ_BUDGET); assert.ok(page.entries.length <= ROW_LIMIT);
            for (const entry of page.entries) {
                const number = Number(entry.message.replace('record ', ''));
                assert.ok(number >= 200 && number < 1700);
                assert.equal(seen.has(entry.id), false); seen.add(entry.id);
            }
            if (!page.previousCursor) break;
            page = readUnifiedPage(root, components, filters, page.previousCursor);
            assert.ok(++pages < 100);
        } while (true);
        assert.equal(seen.size, 1500);
        const resume = readUnifiedPage(root, components, filters, page.resumeCursor);
        assert.equal(Math.max(...resume.entries.map(entry => Number(entry.message.replace('record ', '')))), 1699);
        const nextInterval = readUnifiedPage(root, components, filters, page.liveCursor);
        assert.equal(nextInterval.entries.length, 200);
        assert.equal(nextInterval.previousCursor, null);
        assert.ok(nextInterval.entries.every(entry => !seen.has(entry.id) && Number(entry.message.replace('record ', '')) >= 1700));
        assert.equal(readUnifiedPage(root, components, filters, nextInterval.liveCursor).entries.length, 0);
    });
}

test('live checkpoints advance sparse/empty intervals and include a newly created configured source', t => {
    const { root, write } = fixture(t);
    const filters = { method: 'POST' };
    const initial = readUnifiedPage(root, components, filters);
    write('pcm-core', Array.from({ length: 400 }, (_, index) => record(index, { method: 'GET', payload: 'x'.repeat(10000) })));
    let page = readUnifiedPage(root, components, filters, initial.liveCursor);
    let emptyPages = 0;
    do {
        assert.equal(page.entries.length, 0); emptyPages++;
        if (!page.previousCursor) break;
        page = readUnifiedPage(root, components, filters, page.previousCursor);
    } while (true);
    assert.ok(emptyPages > 1);
    write('sp-client', [record(900, { method: 'POST' })]);
    const next = readUnifiedPage(root, components, filters, page.liveCursor);
    assert.deepEqual(next.entries.map(entry => entry.message), ['record 900']);
});

test('catch-up refuses unprovable continuity instead of jumping after clear, truncation or an extended partial line', t => {
    const { root, write } = fixture(t);
    const filename = write('pcm-core', [record(1)]);
    fs.writeFileSync(filename, '{"message":"partial');
    const point = readUnifiedPage(root, components).liveCursor;
    fs.appendFileSync(filename, ' completion"}\n');
    assert.throws(() => readUnifiedPage(root, components, {}, point), /continuity.*unterminated/);
    const nextPoint = readUnifiedPage(root, components).liveCursor;
    fs.truncateSync(filename, 0);
    assert.throws(() => readUnifiedPage(root, components, {}, nextPoint), /changed|cleared/);
    write('pcm-core', [record(2)]);
    const clearedPoint = readUnifiedPage(root, components).liveCursor;
    clearConfiguredLogs(root, components);
    assert.throws(() => readUnifiedPage(root, components, {}, clearedPoint), /filters changed/);
});

test('clear includes every configured current/history/error stream and preserves active append handles', t => {
    const { root, write } = fixture(t);
    const inventory = configuredLogComponents(buildTeamConfig());
    for (const component of inventory) {
        write(component.dir, [record(1)]);
        write(component.dir, [record(0)], 'history/old/app.log');
    }
    write('ds-gateway', ['2026/10/04 00:00:00 [error] request failed'], 'error.log');
    const filename = path.join(root, 'pcm-core/current.log');
    const fd = fs.openSync(filename, 'a');
    const first = readUnifiedPage(root, inventory);
    const result = clearConfiguredLogs(root, inventory);
    assert.equal(result.status, 'cleared');
    assert.equal(result.results.length, inventory.length);
    for (const component of inventory) {
        assert.equal(fs.readFileSync(path.join(root, component.dir, 'current.log'), 'utf8'), '');
        assert.equal(fs.existsSync(path.join(root, component.dir, 'history')), false);
    }
    assert.equal(fs.readFileSync(path.join(root, 'ds-gateway/error.log'), 'utf8'), '');
    fs.writeSync(fd, JSON.stringify(record(900)) + '\n');
    fs.closeSync(fd);
    assert.equal(readUnifiedPage(root, inventory).entries[0].message, 'record 900');
    assert.throws(() => readUnifiedDetail(root, inventory, first.entries[0].reference), /Invalid/);
});

test('missing streams are empty; unreadable streams and partial clear failures are reported independently', t => {
    const { root, write } = fixture(t);
    assert.deepEqual(readUnifiedPage(root, components).entries, []);
    write('pcm-core', [record(1)]);
    fs.mkdirSync(path.join(root, 'sp-client/current.log'), { recursive: true });
    const page = readUnifiedPage(root, components);
    assert.equal(page.entries.length, 1);
    assert.equal(page.failures[0].component, 'sp-client');
    const result = clearConfiguredLogs(root, components);
    assert.equal(result.status, 'partial');
    assert.equal(result.results.find(item => item.component === 'sp-client').status, 'failed');
    assert.equal(result.results.find(item => item.component === 'pcm-core').status, 'cleared');
});


test('registered source filter selects only its trusted stream, composes exactly, pages and rejects unknown identities', t => {
    const { root, write } = fixture(t);
    const list = [{ dir: 'adapter-one', label: 'Same label', role: 'adapter', healthOrganizationId: 'ho-a' },
        { dir: 'adapter-two', label: 'Same label', role: 'adapter', healthOrganizationId: 'ho-a' }];
    write('adapter-one', Array.from({ length: 450 }, (_, i) => record(i, { method: 'GET' })));
    // Producer claims never authorize selection of another configured file.
    write('adapter-two', [record(999, { source: 'adapter-one' })]);
    const filters = { source: 'adapter-one', role: 'adapter', healthOrganizationId: 'ho-a', method: 'GET' };
    let page = readUnifiedPage(root, list, filters), count = page.entries.length;
    assert.equal(page.sources.length, 1); assert.equal(page.sources[0].componentId, 'adapter-one');
    while (page.nextCursor) { page = readUnifiedPage(root, list, filters, page.nextCursor); count += page.entries.length; }
    assert.equal(count, 450);
    assert.equal(readUnifiedPage(root, list, { ...filters, role: 'doctor' }).entries.length, 0);
    for (const source of ['Same label', 'ADAPTER-ONE', '../adapter-one', 'unknown', ['adapter-one'], 'x'.repeat(257)]) {
        assert.throws(() => readUnifiedPage(root, list, { source }), /configured log source ID/);
    }
    const first = readUnifiedPage(root, list, filters);
    assert.throws(() => readUnifiedPage(root, list, { ...filters, source: 'adapter-two' }, first.nextCursor), /filters changed/);
});
