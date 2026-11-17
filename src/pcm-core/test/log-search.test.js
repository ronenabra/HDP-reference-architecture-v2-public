'use strict';
/** Real worker/file/API regressions for the separate retained-query contract. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createLogSearch } = require('../src/log-search');
const { validateFilters, candidate, containsText, LIMITS } = require('../src/log-search-contract');
const { readUnifiedPage, readUnifiedDetail } = require('../src/unified-log-page');
const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
const { clearConfiguredLogs } = require('../src/log-clear');
const sources = [{ dir: 'pcm-core', label: 'PCM', role: 'pcm' },
    { dir: 'zz-adapter', label: 'Late adapter', role: 'adapter', healthOrganizationId: 'ho-b' }];
const normalize = entry => expandLogEntry(normalizeLogEntry(entry));

/** Install owned source files and register worker cleanup before file removal. */
function fixture(t, options) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-search-'));
    const service = createLogSearch(options);
    t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const write = (records, dir = 'pcm-core', file = 'current.log') => {
        const name = path.join(root, dir, file); fs.mkdirSync(path.dirname(name), { recursive: true });
        fs.writeFileSync(name, records.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n');
        return name;
    };
    return { root, service, write };
}

/** Wait on a bounded test deadline, returning all immutable match pages. */
async function result(f, filters, list = sources) {
    const job = f.service.start(f.root, list, filters);
    return finish(f, job.id, list);
}
async function finish(f, id, list = sources) {
    const deadline = Date.now() + 10000;
    let page;
    do {
        page = f.service.read(id, f.root, list);
        if (page.state !== 'running') break;
        assert.ok(Date.now() < deadline, 'worker must finish within the test deadline');
        await new Promise(resolve => setTimeout(resolve, 5));
    } while (true);
    const entries = [...page.entries];
    let offset = page.nextOffset;
    while (offset !== null) {
        const next = f.service.read(id, f.root, list, { offset: String(offset) });
        entries.push(...next.entries); offset = next.nextOffset;
    }
    return { ...page, entries };
}
function record(index, details = {}) {
    return { timestamp: new Date(Date.UTC(2026, 10, 4, 10) + index * 1000).toISOString(), level: 'INFO',
        message: `Synthetic event ${index}`, details: { type: 'REQUEST', method: 'GET', url: '/fhir/Observation?x=1', status: 200, ...details } };
}

test('filter grammar rejects arrays, unknown fields, excessive input, invalid times and ranges', () => {
    for (const input of [null, [], { traceId: ['abc'] }, { text: 'a'.repeat(513) }, { cursor: '/etc/passwd' },
        { diagnostics: 'yes' }, { since: 'yesterday' }, { until: '2026-11-04' }, { since: '2026-02-30T10:00:00Z' },
        { since: '2026-11-04T11:00:00Z', until: '2026-11-04T10:00:00Z' }]) assert.throws(() => validateFilters(input), TypeError);
    assert.equal(validateFilters({ since: '2026-11-04T10:00Z', text: ' .* ' }).text, ' .* ');
    assert.throws(() => validateFilters({ AKIAABCDEFGHIJKLMNOP: '' }), error => !error.message.includes('AKIAABCDEFGHIJKLMNOP'));
});

test('literal semantics include values, ignore case, exclude keys/injected classification and preserve value boundaries', () => {
    const entry = { message: 'Hello World', details: { payload: { NeverAValue: 'A[.*]B', list: ['first', 'second'] }, role: 'adapter' } };
    for (const needle of ['hello world', 'a[.*]b', 'second']) assert.equal(containsText(entry, needle), true);
    for (const needle of ['neveravalue', 'firstsecond', 'adapter']) assert.equal(containsText(entry, needle), false);
    assert.equal(candidate('{"body":"ordinary\\nline"}', { traceId: 'absent' }, {}), false);
    assert.equal(candidate('{"traceId":"\\u0061bc"}', { traceId: 'abc' }, {}), true);
});

for (const field of ['correlationId', 'flowId', 'traceId']) {
    test(`${field} requires exact parsed value, including escaped/metadata IDs, without payload/substring false matches`, async t => {
        const f = fixture(t), id = '0123456789abcdef0123456789abcdef';
        const encoded = JSON.stringify(record(2, { [field]: id })).replace(id, '\\u0030' + id.slice(1));
        const metadata = { ...record(3), event: { correlation: { [field]: id } } };
        f.write([record(0, { body: id }), record(1, { [field]: id + 'x' }), encoded, metadata, record(4, { [field]: id.toUpperCase() })]);
        const page = await result(f, { [field]: id });
        assert.equal(page.state, 'complete'); assert.equal(page.progress.matched, 2);
        assert.deepEqual(page.entries.map(entry => entry.message).sort(), ['Synthetic event 2', 'Synthetic event 3']);
        const browse = readUnifiedPage(f.root, sources, { [field]: id }, '', normalize);
        assert.deepEqual(page.entries.map(entry => entry.id).sort(), browse.entries.map(entry => entry.id).sort());
        for (const entry of page.entries) assert.equal(readUnifiedDetail(f.root, sources, entry.reference, normalize).id, entry.id);
    });
}

test('combined source/role/HO/level/method/path/status/ID/time/text narrows the canonical projection', async t => {
    const f = fixture(t);
    f.write([record(0, { correlationId: 'shared', body: { resourceType: 'Observation', valueString: 'Rare Literal [x]' } }),
        record(1, { correlationId: 'shared', status: 401, body: 'Rare literal [x]' })], 'zz-adapter');
    f.write([record(0, { correlationId: 'shared', body: 'Rare literal [x]' })]);
    const page = await result(f, { source: 'zz-adapter', role: 'adapter', healthOrganizationId: 'ho-b', level: 'INFO', method: 'GET',
        path: '/fhir/Observation', status: '200', correlationId: 'shared', since: '2026-11-04T10:00:00Z', until: '2026-11-04T10:00:00Z', text: 'rare literal [x]' });
    assert.equal(page.entries.length, 1); assert.equal(page.sources.length, 1);
    assert.throws(() => f.service.start(f.root, sources, { source: '../../etc/passwd' }), /configured log source ID/);
});

test('visibility and AWS scrubbing precede search, counts and snippets; non-AWS payload remains in selected raw/detail', async t => {
    const f = fixture(t), secret = 'FAKE_SEARCH_AWS_SECRET';
    f.write([record(0, { visibility: 'hidden', body: 'secret phrase' }), record(1, { visibility: 'diagnostic', body: 'secret phrase' }),
        record(2, { AWS_SECRET_ACCESS_KEY: secret, token: 'synthetic-bearer-kept', body: 'Patient/123' })]);
    assert.equal((await result(f, { text: 'secret phrase' })).entries.length, 0);
    assert.equal((await result(f, { text: 'secret phrase', diagnostics: 'true' })).entries.length, 1);
    assert.equal((await result(f, { text: 'secret phrase', diagnostics: 'true', visibility: 'all' })).entries.length, 2);
    assert.equal((await result(f, { text: secret })).progress.matched, 0);
    const page = await result(f, { text: 'synthetic-bearer-kept' });
    const detail = readUnifiedDetail(f.root, sources, page.entries[0].reference, normalize);
    assert.equal(detail.details.token, 'synthetic-bearer-kept'); assert.match(detail.raw, /Patient\/123/);
    assert.doesNotMatch(JSON.stringify(page) + JSON.stringify(detail), new RegExp(secret));
});

test('gateway derived INFO and estimated message/time use canonical exact filters and raw completion', async t => {
    const f = fixture(t), gateway = [{ dir: 'gateway', label: 'Gateway', role: 'gateway' }];
    const raw = ' { "timestamp":"2026-11-04T10:00:01Z", "level":"ERROR", "message":"Gateway completion", "details":{"type":"GATEWAY_RESPONSE","method":"GET","url":"/auth","correlationId":"same","requestTime":"1","status":401} }\r';
    f.write([raw], 'gateway');
    const page = await result(f, { correlationId: 'same', level: 'INFO', text: 'gateway request:', since: '2026-11-04T10:00:00Z', until: '2026-11-04T10:00:00Z' }, gateway);
    assert.equal(page.entries.length, 1); assert.equal(page.entries[0].event.provenance.kind, 'derived');
    const detail = readUnifiedDetail(f.root, gateway, page.entries[0].reference, normalize);
    assert.equal(detail.level, 'INFO'); assert.equal(detail.raw, raw);
    assert.equal((await result(f, { level: 'ERROR' }, gateway)).entries[0].details.type, 'GATEWAY_RESPONSE');
});

test('malformed AWS records cannot leak through parse errors, literal matches, counts or selected raw/detail', async t => {
    const f = fixture(t);
    const access = 'AKIAABCDEFGHIJKLMNOP', secret = 'FAKE_MALFORMED_AWS_SECRET';
    f.write([access, `{"AWS_SECRET_ACCESS_KEY":"${secret}"`,
        `{"aws\\u005fsecret_access_key":"${secret}"`,
        `{"AccessKeyId":"fake","SecretAccessKey":"${secret}","Token":"session"`,
        `{"authorizationData":[{"authorizationToken":"${secret}","proxyEndpoint":"https://example.invalid"`,
        '{malformed non-AWS bearer-kept']);
    assert.equal((await result(f, { text: access })).progress.matched, 0);
    assert.equal((await result(f, { text: secret })).progress.matched, 0);
    const page = await result(f, {});
    assert.equal(page.entries.length, 6);
    for (const entry of page.entries) {
        const detail = readUnifiedDetail(f.root, sources, entry.reference, normalize);
        assert.doesNotMatch(JSON.stringify(entry) + JSON.stringify(detail), new RegExp(`${access}|${secret}`));
    }
    const kept = await result(f, { text: 'non-AWS bearer-kept' });
    assert.equal(kept.entries.length, 1);
    assert.equal(readUnifiedDetail(f.root, sources, kept.entries[0].reference, normalize).raw, '{malformed non-AWS bearer-kept');
});

test('malformed/Unicode/unterminated and oversized records retain honest bounded scope', async t => {
    const f = fixture(t);
    const name = f.write(['{malformed ז', record(1, { body: 'ז encoded' }), 'x'.repeat(LIMITS.line + 10), record(2)]);
    fs.appendFileSync(name, JSON.stringify(record(3, { body: 'final unterminated' })));
    const page = await result(f, {});
    assert.equal(page.state, 'partial'); assert.equal(page.complete, false);
    assert.equal(page.skippedLongLines, 1); assert.equal(page.entries.length, 4);
    assert.ok(page.entries.some(entry => entry.event.provenance.kind === 'unparsed'));
    assert.equal((await result(f, { text: 'ז' })).entries.length, 2);
    assert.equal((await result(f, { text: 'final unterminated' })).entries.length, 1);
});

test('deterministic identities/pages deduplicate variants and identical records while respecting the 1000-result cap', async t => {
    const f = fixture(t); f.write(Array.from({ length: 1002 }, () => record(0)));
    const first = await result(f, {}), second = await result(f, {});
    assert.equal(first.state, 'result-limit'); assert.equal(first.complete, false);
    assert.equal(first.progress.matched, 1000); assert.equal(first.entries.length, 1000);
    assert.equal(new Set(first.entries.map(entry => entry.id)).size, 1000);
    assert.deepEqual(first.entries.map(entry => entry.id), second.entries.map(entry => entry.id));
    assert.throws(() => f.service.read(first.id, f.root, sources, { offset: '1' }), /offset/);
    assert.throws(() => f.service.read(first.id, f.root, sources, { order: 'raw' }), /order/);
});

test('exactly the result cap can still complete; browse retention is current plus five newest rotations', async t => {
    const f = fixture(t); f.write(Array.from({ length: 1000 }, (_, i) => record(i)));
    assert.equal((await result(f, {})).state, 'complete');
    f.write([]);
    for (let index = 0; index < 7; index++) f.write([record(index)], 'pcm-core', `history/2026-11-0${index + 1}/app.log`);
    const page = await result(f, {});
    assert.equal(page.entries.length, 5);
    assert.equal(page.snapshot.scope, 'configured-current-and-five-rotations');
    assert.ok(page.entries.every(entry => Number(entry.message.split(' ').at(-1)) >= 2));
});

test('fixed byte snapshot excludes appends, including extension of an unterminated final record', async t => {
    const f = fixture(t); const filename = f.write([record(0)]);
    const job = f.service.start(f.root, sources, {});
    fs.appendFileSync(filename, JSON.stringify(record(1)) + '\n');
    assert.equal((await finish(f, job.id)).entries.length, 1);
    assert.equal((await result(f, {})).entries.length, 2);
});

for (const mutation of ['truncate', 'truncate-regrow', 'replace', 'rotate', 'clear', 'inventory']) {
    test(`${mutation} invalidates saved query results rather than silently reusing offsets`, async t => {
        const f = fixture(t), filename = f.write([record(0), record(1)]);
        const page = await result(f, {});
        if (mutation === 'truncate') fs.truncateSync(filename, 0);
        if (mutation === 'truncate-regrow') fs.writeFileSync(filename, 'z'.repeat(fs.statSync(filename).size + 10));
        if (mutation === 'replace' || mutation === 'rotate') { fs.renameSync(filename, filename + '.old'); f.write([record(0), record(1)]); }
        if (mutation === 'clear') clearConfiguredLogs(f.root, sources);
        const next = f.service.read(page.id, f.root, mutation === 'inventory' ? sources.slice(0, 1) : sources);
        assert.equal(next.state, 'failed'); assert.deepEqual(next.entries, []);
    });
}

test('extension source claims and symlinks cannot impersonate built-ins or suppress healthy results', async t => {
    const f = fixture(t), external = { dir: 'extensions/one', label: 'Extension', role: 'security', format: 'hdp-jsonl', external: true };
    f.write([record(0)]); const filename = f.write([record(1, { role: 'pcm', visibility: 'default', body: 'Extension needle' })], external.dir);
    const list = [...sources, external];
    assert.equal((await result(f, { text: 'Extension needle' }, list)).entries.length, 0);
    const visible = await result(f, { diagnostics: 'true', text: 'Extension needle' }, list);
    assert.equal(visible.entries[0].details.role, 'security');
    assert.equal(visible.entries[0].event.source.componentId, 'extensions/one');
    fs.renameSync(filename, filename + '.real'); fs.symlinkSync('current.log.real', filename);
    const page = await result(f, { diagnostics: 'true' }, list);
    assert.equal(page.state, 'partial'); assert.equal(page.entries.length, 1);
    assert.ok(page.failures.some(failure => failure.component === external.dir));
});

test('two workers admit no unbounded queue; cancel/deadline/expiry/close release bounded jobs', async t => {
    const f = fixture(t, { deadline: 5, lifetime: 1500 });
    f.write(Array.from({ length: 16000 }, (_, i) => record(i, { body: 'padding'.repeat(50) })));
    const a = f.service.start(f.root, sources, { text: 'absent' });
    const b = f.service.start(f.root, sources, { text: 'absent' });
    assert.throws(() => f.service.start(f.root, sources, {}), error => error.status === 429);
    assert.equal(f.service.cancel(a.id, f.root, sources).state, 'cancelled');
    assert.equal((await finish(f, b.id)).state, 'deadline');
    await f.service.close();
    assert.throws(() => f.service.start(f.root, sources, {}), error => error.status === 503);
});

test('expired jobs disappear and terminal jobs are evicted before the fixed retention bound is exceeded', async t => {
    const f = fixture(t, { jobs: 1, lifetime: 250 }); f.write([record(0)]);
    const first = await result(f, {});
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await result(f, {});
    assert.throws(() => f.service.read(first.id, f.root, sources), error => error.status === 404);
    await new Promise(resolve => setTimeout(resolve, 260));
    assert.throws(() => f.service.read(second.id, f.root, sources), error => error.status === 404);
});

test('real HTTP query route keeps browse/detail/clear contracts and validates untrusted filters/coordinates', async t => {
    const config = require('../../../test-support/team-config').installTestRuntime();
    const { createUiApp } = require('../src/index');
    const root = process.env.SHARED_LOGS_DIR, filename = path.join(root, 'pcm-core/current.log');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(record(0, { correlationId: 'api-exact', body: 'Patient/456 non-AWS bearer' })) + '\n');
    const app = createUiApp(), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await app.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const start = await fetch(base + '/api/unified-logs/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ correlationId: 'api-exact' }) });
    assert.equal(start.status, 202); assert.equal(start.headers.get('cache-control'), 'no-store');
    const invalid = await fetch(base + '/api/unified-logs/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{AWS_SECRET_ACCESS_KEY:"FAKE_API_SECRET"' });
    assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /FAKE_API_SECRET/);
    const oversized = await fetch(base + '/api/unified-logs/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(17000) }) });
    assert.equal(oversized.status, 413);
    const job = await start.json(); let page;
    do { await new Promise(resolve => setTimeout(resolve, 10)); page = await (await fetch(base + '/api/unified-logs/search/' + job.id)).json(); } while (page.state === 'running');
    assert.equal(page.state, 'complete'); assert.equal(page.entries.length, 1);
    const detail = await (await fetch(base + '/api/unified-logs/detail?' + new URLSearchParams({ reference: page.entries[0].reference }))).json();
    assert.match(detail.raw, /Patient\/456/);
    assert.equal((await fetch(base + '/api/unified-logs/search/' + job.id + '?offset=../etc')).status, 400);
    assert.equal((await fetch(base + '/api/unified-logs/search/not-a-job')).status, 404);
    assert.ok(Array.isArray(await (await fetch(base + '/api/unified-logs')).json()));
    const exact = await (await fetch(base + '/api/unified-logs?page=true&source=pcm-core&role=pcm&method=GET&correlationId=api-exact')).json();
    assert.equal(exact.entries.length, 1); assert.deepEqual(exact.sources.map(source => source.componentId), ['pcm-core']);
    assert.equal((await (await fetch(base + '/api/unified-logs?page=true&source=pcm-core&role=adapter')).json()).entries.length, 0);
    for (const source of ['unknown', '../pcm-core', 'PCM Core']) {
        const rejected = await fetch(base + '/api/unified-logs?' + new URLSearchParams({ page: 'true', source }));
        assert.equal(rejected.status, 409); assert.match((await rejected.json()).error, /configured log source ID/);
        const searchRejected = await fetch(base + '/api/unified-logs/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
        assert.equal(searchRejected.status, 400);
    }
    assert.equal((await fetch(base + '/api/unified-logs?page=true&source=pcm-core&source=sp-client')).status, 409);

    await fetch(base + '/api/unified-logs/clear', { method: 'POST' });
    page = await (await fetch(base + '/api/unified-logs/search/' + job.id)).json();
    assert.equal(page.state, 'failed'); assert.deepEqual(page.entries, []);
    assert.ok(config.teamId);
});
test('native writer health belongs to the captured search and does not silently become live health',async t=>{
 const f=fixture(t),native={dir:'ho-a-hapi-runtime',label:'Native',role:'hapi',healthOrganizationId:'ho-a',strictPath:true};
 f.write([record(1,{type:'HAPI_CONTEXT_VALIDATION',reasonCode:'CONTEXT_VALIDATED'})],native.dir);
 const filename=path.join(f.root,native.dir,'health.json');
 const state={state:'loss',queuedEntries:0,queuedBytes:0,dropped:3,writeFailures:0,lastSuccessEpochMs:Date.now(),pendingLoss:0,observedAtEpochMs:Date.now()};
 fs.writeFileSync(filename,JSON.stringify(state));const job=f.service.start(f.root,[native],{});const captured=await finish(f,job.id,[native]);
 assert.equal(captured.sources[0].runtimeHealth.dropped,3);assert.ok(captured.coverage.reasons.includes('native-diagnostics-gaps'));
 fs.writeFileSync(filename,JSON.stringify({...state,state:'available',dropped:0}));
 assert.equal(f.service.read(job.id,f.root,[native]).sources[0].runtimeHealth.dropped,3);
 assert.equal(readUnifiedPage(f.root,[native],{}).sources[0].runtimeHealth.dropped,0);
});
