'use strict';
/** Bounded Admin import log retrieval, attribution and credential canaries. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDiagnosticPage, READ_BUDGET, PAGE_SIZE } = require('../src/admin-log-view');
const { sanitizeLogDetails } = require('../../shared/log-policy');

const components = [
    { dir: 'pcm-core', role: 'pcm' },
    { dir: 'ho-a-hapi', role: 'hapi-import', healthOrganizationId: 'ho-a' },
    { dir: 'ho-b-hapi', role: 'hapi-import', healthOrganizationId: 'ho-b' }
];

/** Create an isolated component file with one JSON record per line. */
function write(root, component, file, records) {
    const target = path.join(root, component, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    return target;
}

function record(stage, operationId, target = 'ho-a', extra = {}) {
    return { timestamp: '2026-09-29T19:00:00.000Z', level: stage === 'hapi-error' ? 'ERROR' : 'INFO',
        message: stage, details: { stage, operationId, healthOrganizationId: target, ...extra } };
}

test('empty, rotated, cross-HO and uncorrelated native records are projected accurately', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-log-page-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(readDiagnosticPage(root, components).entries, []);
    const id = '00000000-0000-4000-8000-000000000003';
    write(root, 'pcm-core', 'current.log', [record('timeout', id)]);
    write(root, 'ho-a-hapi', 'history/2026-09-28/app.log', [{ ...record('hapi-complete', id),
        timestamp: '2026-09-29T19:02:00.000Z' }]);
    write(root, 'ho-b-hapi', 'current.log', [record('hapi-error', null, 'ho-b')]);
    const target = readDiagnosticPage(root, components, { target: 'ho-a', operationId: id });
    assert.deepEqual(target.entries.map(item => item.stage), ['timeout', 'hapi-complete']);
    assert.deepEqual(target.entries.map(item => item.target), ['ho-a', 'ho-a']);
    assert.ok(Date.parse(target.entries[1].timestamp) > Date.parse(target.entries[0].timestamp),
        'named HAPI completion remains visible after PCM response timeout');
    const b = readDiagnosticPage(root, components, { target: 'ho-b', severity: 'ERROR' });
    assert.equal(b.entries.length, 1);
    assert.equal(b.entries[0].correlation, 'unavailable');
    assert.equal(b.entries[0].component, 'ho-b-hapi');
});

test('high-volume paging bounds reads and rows while retaining complete raw values', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-log-page-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const id = '00000000-0000-4000-8000-000000000004';
    const payload = 'non-AWS token Patient/123 ?_tag=synthetic';
    write(root, 'ho-a-hapi', 'current.log', Array.from({ length: 7000 }, (_, index) =>
        record(`hapi-complete-${index}`, id, 'ho-a', { payload })));
    const first = readDiagnosticPage(root, components, { target: 'ho-a' });
    assert.equal(first.entries.length, PAGE_SIZE);
    assert.ok(first.bytesRead <= READ_BUDGET);
    assert.ok(first.nextCursor);
    assert.match(first.entries[0].raw, /non-AWS token Patient\/123/);
    const second = readDiagnosticPage(root, components, { target: 'ho-a' }, first.nextCursor);
    assert.equal(second.entries.length, PAGE_SIZE);
    assert.notEqual(second.entries[0].stage, first.entries[0].stage);
    assert.ok(second.bytesRead <= READ_BUDGET);
    assert.throws(() => readDiagnosticPage(root, components, {}, '../../secret'), /Invalid log page cursor/);
    assert.throws(() => readDiagnosticPage(root, components, {}, 'x'.repeat(201)), /Invalid log page cursor/);
});

test('sparse operation search advances through a full read budget and applies time filters', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-log-page-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'pcm-core', 'current.log', Array.from({ length: 16000 }, (_, index) =>
        record(`stage-${index}`, `other-${index}`, 'ho-a', { payload: 'x'.repeat(80) })));
    const filters = { operationId: 'sought', since: '2026-09-29T18:00:00Z', until: '2026-09-29T20:00:00Z' };
    let cursor;
    let pages = 0;
    do {
        const page = readDiagnosticPage(root, components, filters, cursor);
        assert.equal(page.entries.length, 0);
        assert.ok(page.bytesRead <= READ_BUDGET);
        cursor = page.nextCursor;
        pages++;
    } while (cursor && pages < 10);
    assert.equal(cursor, null);
    assert.ok(pages > 1);
});

test('synthetic AWS operational credentials are blocked while non-AWS values remain', () => {
    const safe = sanitizeLogDetails({ operationId: 'non-AWS-token', aws_secret_access_key: 'synthetic-secret',
        message: 'AKIAABCDEFGHIJKLMNOP Patient/123' });
    assert.equal(safe.aws_secret_access_key, '[AWS_CREDENTIAL_BLOCKED]');
    assert.match(safe.message, /\[AWS_CREDENTIAL_BLOCKED\]/);
    assert.match(safe.message, /Patient\/123/);
    assert.equal(safe.operationId, 'non-AWS-token');
});

test('a full Admin page still reports another component failure', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-log-failures-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(root, 'pcm-core', 'current.log', Array.from({ length: 80 }, () => record('accepted', 'op')));
    // A directory in place of a configured stream is an explicit read failure.
    fs.mkdirSync(path.join(root, 'ho-a-hapi', 'current.log'), { recursive: true });
    const page = readDiagnosticPage(root, components);
    assert.equal(page.entries.length, PAGE_SIZE);
    assert.deepEqual(page.failures.map(item => item.component), ['ho-a-hapi']);
});


test('legacy diagnostic HTML is only an explicit central-viewer bridge', () => {
    require('../../../test-support/team-config').installTestRuntime();
    const { renderAdminLogView } = require('../src/routes/ui')._test;
    const html = renderAdminLogView({ operationId: 'exact-op', stage: 'failure' });
    assert.match(html, /Open broader Logs context/);
    assert.match(html, /operationId=exact-op/);
    assert.doesNotMatch(html, /<table|name="operationId"|Full diagnostic record/);
});

test('Admin cursor is invalidated by rotation, truncation and the shared clear generation', t => {
    const { clearConfiguredLogs } = require('../src/log-clear');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-log-cursor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = write(root, 'pcm-core', 'current.log', Array.from({ length: 100 }, (_, i) => record(`stage-${i}`, 'op')));
    let first = readDiagnosticPage(root, components);
    assert.ok(first.nextCursor);
    fs.renameSync(file, `${file}.old`);
    fs.copyFileSync(`${file}.old`, file);
    assert.throws(() => readDiagnosticPage(root, components, {}, first.nextCursor), /Invalid/);
    first = readDiagnosticPage(root, components);
    clearConfiguredLogs(root, components);
    fs.copyFileSync(`${file}.old`, file); // Same-size repopulation must not revive a pre-clear cursor.
    assert.throws(() => readDiagnosticPage(root, components, {}, first.nextCursor), /Invalid/);
});

test('complete export includes every retained rotation and primitive JSON remains raw diagnostic text', t => {
    const { readComponentLogRecords } = require('../src/log-reader');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-all-history-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (let index = 0; index < 8; index++) write(root, 'pcm-core', `history/2026-10-0${index}/app.log`, [record('retained', 'op')]);
    write(root, 'pcm-core', 'current.log', [7, null]);
    const full = readComponentLogRecords(root, 'pcm-core', 'PCM', { allHistory: true });
    assert.equal(full.length, 10);
    assert.equal(full.at(-2).parsed, null);
    assert.equal(full.at(-2).raw, '7');
    assert.equal(full.at(-1).raw, 'null');
});
