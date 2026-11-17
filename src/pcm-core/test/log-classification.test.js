'use strict';
/** Approved semantic rules, retained bytes, bounded notices and real API regression coverage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { knownLogClassification, classifyRoute } = require('../../shared/log-policy');
const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
const { readUnifiedPage, readUnifiedDetail, matches, READ_BUDGET } = require('../src/unified-log-page');
const { configuredLogComponents } = require('../src/log-ordering');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { records, writeCorpus } = require('../../../test-support/log-classification-corpus');
const normalize = row => expandLogEntry(normalizeLogEntry(row));

test('selection is source-aware and does not manufacture a Doctor flow; other routes remain real', () => {
    assert.deepEqual(classifyRoute('/selection?next=1', 'sp-client'), { category: 'harness', visibility: 'diagnostic', emitMiddleware: true, causesSystemFlow: false });
    assert.equal(classifyRoute('/selection', 'pcm-core').visibility, 'default');
    for (const url of ['/auth', '/auth-check', '/introspect', '/token', '/api/fhir-service/r4/Patient']) assert.equal(classifyRoute(url, 'sp-client').visibility, 'default');
    for (const role of ['doctor', 'gateway']) for (const url of ['/', '/favicon.ico', '/selection', '/wrong']) {
        const row = normalizeLogEntry({ event: { source: { role } }, details: { type: 'GATEWAY_ERROR', url } });
        assert.equal(row.details.visibility, 'default');
    }
});

test('legacy semantic corrections preserve explicit unrelated metadata and unknown fallback', () => {
    for (const row of records()) {
        const role = row.source === 'sp-client' ? 'doctor' : row.source.endsWith('adapter') ? 'adapter' : 'fhir';
        const input = { ...row, event: { source: { componentId: row.source, role } } };
        const before = JSON.stringify(input), result = normalizeLogEntry(input);
        assert.equal(JSON.stringify(input), before);
        const noise = row.details.url === '/selection' || row.details.url?.startsWith('/sandbox/authentication/') || row.details.type === 'SYSTEM_BROWSER_ACTION' || row.details.type === 'CONFORMANCE_MODE' || !row.details.type || row.details.stage === 'config' || row.details.type.startsWith('HARNESS_');
        assert.equal(result.details.visibility, noise ? 'diagnostic' : 'default', row.details.type);
    }
    assert.equal(normalizeLogEntry({ details: { type: 'UNKNOWN' } }).details.category, 'uncategorized');
    assert.equal(normalizeLogEntry({ details: { type: 'UNKNOWN', visibility: 'diagnostic' } }).details.visibility, 'diagnostic');
    for (const stage of ['listener', 'prepare-listener', 'rollback']) assert.equal(normalizeLogEntry({ message: 'DS FHIR config reload rejected', event: { source: { componentId: 'ds-fhir-server' } }, details: { type: 'PROCESS_RELOAD_FAILED', stage } }).details.visibility, 'default');
    assert.equal(knownLogClassification({ message: 'DS FHIR config reload rejected', details: { type: 'PROCESS_RELOAD_FAILED' } }, { componentId: 'ds-fhir-server' }).visibility, 'diagnostic');
    assert.equal(knownLogClassification({ message: 'DS FHIR config reload rejected', details: { type: 'PROCESS_RELOAD_FAILED', stage: 'config' } }, { componentId: 'pcm-core' }), null);
    for (const type of ['PROCESS_BOOT', 'PROCESS_LISTENING']) assert.equal(normalizeLogEntry({ details: { type, visibility: 'default' } }).details.visibility, 'diagnostic');
    // Extension identities remain opt-in even if they claim a built-in auth event name.
    assert.equal(normalizeLogEntry({ event: { source: { componentId: 'extensions/custom', role: 'addon' } }, details: { type: 'LOCAL_JWT_VERIFIED', visibility: 'diagnostic' } }).details.visibility, 'diagnostic');
    assert.equal(normalizeLogEntry({ event: { source: { componentId: 'sp-client', role: 'doctor' } }, details: { type: 'REQUEST' } }).details.visibility, 'default');
});

test('bounded OFF/ON pages retain every real hop; notice exact source/raw survives filters and fails after rotation/clear', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classification-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    writeCorpus(root, { padding: 700 });
    const components = configuredLogComponents(buildTeamConfig());
    const off = readUnifiedPage(root, components, { diagnostics: 'false', order: 'timeline' }, '', normalize);
    assert.ok(off.bytesRead <= READ_BUDGET); assert.ok(off.entries.length < 200);
    assert.equal(off.entries.some(row => row.details.visibility === 'diagnostic'), false);
    for (const type of ['TOKEN_ISSUED', 'DS_LOCAL_TOKEN_MINTED', 'INTROSPECTION_DECISION', 'LOCAL_JWT_METADATA_CACHE_HIT', 'LOCAL_JWT_VERIFIED', 'UNKNOWN_FUTURE_EVENT']) assert.ok(off.entries.some(row => row.details.type === type), type);
    assert.ok(off.entries.filter(row => row.details.type === 'GATEWAY_ERROR').every(row => matches(row, { diagnostics: 'false' })));
    const target = off.criticalDiagnostic; assert.ok(target); assert.equal(target.details.payload, undefined);
    const detail = readUnifiedDetail(root, components, target.reference, normalize);
    assert.equal(detail.entry.id, target.id); assert.equal(detail.source.componentId, target.event.source.componentId);
    assert.ok(detail.raw.includes('private-non-AWS-token') || detail.raw.includes('synthetic local UI'));
    assert.equal(matches(target, { role: 'doctor', level: 'INFO' }), false);
    const file = path.join(root, detail.source.componentId, target.logFile), bytes = fs.readFileSync(file);
    fs.writeFileSync(file + '.replacement', bytes); fs.renameSync(file + '.replacement', file);
    assert.throws(() => readUnifiedDetail(root, components, target.reference, normalize), /changed|cleared/);
    fs.writeFileSync(file, ''); assert.throws(() => readUnifiedDetail(root, components, target.reference, normalize));
});

test('routine diagnostics do not cause an error notice', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-classification-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'pcm-core')); fs.writeFileSync(path.join(root, 'pcm-core/current.log'), JSON.stringify({ level: 'INFO', details: { type: 'CONFORMANCE_MODE' } }) + '\n');
    assert.equal(readUnifiedPage(root, [{ dir: 'pcm-core', role: 'pcm' }], {}, '', normalize).criticalDiagnostic, null);
});

test('real API exposes diagnostic evidence only ON, keeps export/raw and exact search consistent', async t => {
    const config = require('../../../test-support/team-config').installTestRuntime();
    const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
    const root = process.env.SHARED_LOGS_DIR;
    writeCorpus(root);
    const app = require('../src/index').createUiApp();
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    t.after(async () => { await app.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(runtime, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const read = async url => (await fetch(base + url)).json();
    const off = await read('/api/unified-logs?page=true&diagnostics=false');
    const on = await read('/api/unified-logs?page=true&diagnostics=true');
    assert.ok(on.entries.length > off.entries.length);
    assert.ok(on.entries.some(row => row.details.type === 'SYSTEM_BROWSER_ACTION'));
    assert.equal(off.entries.some(row => row.details.type === 'SYSTEM_BROWSER_ACTION'), false);
    assert.equal(off.entries.some(row => row.details.visibility === 'diagnostic'), false);
    assert.ok(on.entries.some(row => row.details.url === '/selection' && row.details.causesSystemFlow === false));
    const target = off.criticalDiagnostic;
    const detail = await read('/api/unified-logs/detail?reference=' + encodeURIComponent(target.reference));
    assert.equal(detail.entry.id, target.id);
    const jobResponse = await fetch(base + '/api/unified-logs/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId: 'classification-journey', diagnostics: 'false' }) });
    assert.equal(jobResponse.status, 202); const job = await jobResponse.json();
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
        result = await read('/api/unified-logs/search/' + job.id);
        if (result.state !== 'running') break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.state, 'complete'); assert.ok(result.criticalDiagnostic);
    assert.equal(result.entries.some(row => row.details.visibility === 'diagnostic'), false);
    for (const type of ['TOKEN_ISSUED', 'DS_LOCAL_TOKEN_MINTED', 'LOCAL_JWT_VERIFIED', 'INTROSPECTION_DECISION', 'SYSTEM_AUTHENTICATION', 'SYSTEM_OTP', 'SYSTEM_WORKFLOW_FAILURE']) assert.ok(result.entries.some(row => row.details.type === type), type);
    const exported = await fetch(base + '/admin/logs/download'); assert.equal(exported.status, 200);
    assert.match(await exported.text(), /DS FHIR config reload rejected/);
    const legacy = await read('/api/unified-logs?diagnostics=false');
    assert.ok(Array.isArray(legacy)); assert.equal(legacy.some(row => row.details.visibility === 'diagnostic'), false);
    assert.ok(config.legacyDataSource.enabled);
});

test('gateway wrong URLs stay default with browser-like headers or missing IDs, independent of Doctor UI roots', () => {
    const { parseGatewayErrorLine } = require('../src/gateway-error-log');
    for (const url of ['/', '/favicon.ico', '/arbitrary-wrong-path', '/auth', '/selection']) {
        const raw = `2026/11/05 00:00:00 [error] 1#1: *9 open() failed (2: No such file), client: 127.0.0.1, request: "GET ${url} HTTP/1.1", host: "gateway.test"`;
        const parsed = parseGatewayErrorLine(raw);
        for (const correlated of [false, true]) {
            const row = normalizeLogEntry({ ...parsed, event: { source: { componentId: 'ho-b-gateway', role: 'gateway' } }, details: { ...parsed.details,
                headers: correlated ? { 'user-agent': 'Mozilla/5.0', 'x-correlation-id': 'recorded-request' } : {},
                ...(correlated ? { correlationId: 'recorded-request' } : {}) } });
            assert.equal(row.details.url, url); assert.equal(row.details.method, 'GET'); assert.equal(row.details.raw, raw);
            assert.equal(row.details.visibility, 'default'); assert.equal(matches(row, { diagnostics: 'false' }), true);
            assert.equal(row.details.flowId, undefined);
        }
    }
    for (const url of ['/', '/selection', '/reset', '/manage', '/ui', '/admin']) assert.equal(normalizeLogEntry({ event: { source: { componentId: 'sp-client', role: 'doctor' } }, details: { type: 'REQUEST', url } }).details.visibility, 'diagnostic');
});


test('native purpose classification keeps only request/response ordinary without changing other sources or bytes', () => {
    const types = ['HAPI_STARTUP_READY', 'HAPI_RESOURCE_DECISION', 'HAPI_IMPORT_DIAGNOSTIC', 'HAPI_RESULT_FILTER_SUMMARY', 'HAPI_REQUEST', 'HAPI_RESPONSE', 'HAPI_ERROR', 'HAPI_ADMISSION', 'HAPI_CONTEXT_VALIDATION', 'DS_CACHE_DECISION', 'HAPI_NATIVE_DIAGNOSTIC', 'HAPI_STARTUP_FAILED', 'HAPI_LOG_LOSS', 'HAPI_LOG_RECOVERY', 'HAPI_FUTURE', 'REQUEST', '', undefined];
    for (const type of types) for (const visibility of [undefined, 'default', 'diagnostic', 'hidden']) for (const level of ['INFO', 'WARN', 'ERROR']) {
        const input = { level, raw: 'exact retained bytes', event: { source: { role: type === 'HAPI_IMPORT_DIAGNOSTIC' ? 'hapi-import' : 'hapi', componentId: 'ho-a-hapi-runtime' } }, details: { type, category: 'system', visibility } };
        const before = JSON.stringify(input), result = normalizeLogEntry(input);
        assert.equal(result.details.visibility, ['HAPI_REQUEST', 'HAPI_RESPONSE'].includes(type) ? 'default' : 'diagnostic', type);
        assert.equal(result.details.category, type === 'HAPI_STARTUP_READY' ? 'lifecycle' : 'system');
        assert.equal(result.raw, input.raw); assert.equal(JSON.stringify(input), before);
    }
    assert.equal(normalizeLogEntry({ event: { source: { role: 'addon' } }, details: { type: 'HAPI_RESOURCE_DECISION' } }).details.visibility, 'default');
    for (const role of ['adapter', 'gateway', 'hapi-import', 'addon']) for (const type of ['HAPI_REQUEST', 'HAPI_RESPONSE', 'HAPI_ERROR', 'HAPI_FUTURE']) {
        assert.equal(knownLogClassification({ details: { type } }, { role }), null);
    }
});


test('registered retained native files use the same browse, search, diagnostic notice and exact raw policy', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-purpose-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const components = [{ dir: 'ho-a-hapi-runtime', role: 'hapi', healthOrganizationId: 'ho-a' }, { dir: 'ho-a-hapi', role: 'hapi-import', healthOrganizationId: 'ho-a' }];
    const types = ['HAPI_STARTUP_READY', 'HAPI_RESOURCE_DECISION', 'HAPI_RESULT_FILTER_SUMMARY', 'HAPI_REQUEST', 'HAPI_RESPONSE', 'HAPI_ERROR', 'HAPI_ADMISSION', 'HAPI_CONTEXT_VALIDATION', 'HAPI_NATIVE_DIAGNOSTIC', 'HAPI_STARTUP_FAILED', 'HAPI_LOG_LOSS', 'HAPI_LOG_RECOVERY', 'HAPI_FUTURE'];
    const raw = type => JSON.stringify({ timestamp: type === 'HAPI_ERROR' ? '2026-11-16T00:00:01Z' : '2026-11-16T00:00:00Z', level: ['HAPI_ERROR', 'HAPI_IMPORT_DIAGNOSTIC'].includes(type) ? 'ERROR' : type === 'HAPI_NATIVE_DIAGNOSTIC' ? 'WARN' : 'INFO', message: type,
        details: { type, category: 'system', visibility: type === 'HAPI_REQUEST' ? 'diagnostic' : 'default', flowId: 'native-visibility', privateInput: 'exact non-AWS content' } });
    for (const component of components) { fs.mkdirSync(path.join(root, component.dir)); fs.writeFileSync(path.join(root, component.dir, 'current.log'), (component.role === 'hapi' ? types : ['HAPI_IMPORT_DIAGNOSTIC']).map(raw).join('\n') + '\n'); }
    const off = readUnifiedPage(root, components, { diagnostics: 'false' }, '', normalize);
    assert.deepEqual(new Set(off.entries.map(row => row.details.type)), new Set(['HAPI_REQUEST', 'HAPI_RESPONSE']));
    assert.equal(off.criticalDiagnostic.details.type, 'HAPI_ERROR');
    const on = readUnifiedPage(root, components, { diagnostics: 'true' }, '', normalize);
    assert.equal(on.entries.length, types.length + 1);
    for (const entry of on.entries) {
        const detail = readUnifiedDetail(root, components, entry.reference, normalize);
        assert.equal(detail.raw.trimEnd(), raw(entry.details.type));
        assert.equal(detail.entry.details.visibility, entry.details.visibility);
        assert.equal(detail.entry.event.source.componentId, entry.event.source.componentId);
    }
    const search = require('../src/log-search').createLogSearch(); t.after(() => search.close());
    for (const diagnostics of ['false', 'true']) {
        const job = search.start(root, components, { flowId: 'native-visibility', diagnostics });
        const deadline = Date.now() + 5000;
        let result;
        do {
            result = search.read(job.id, root, components);
            if (result.state !== 'running') break;
            assert.ok(Date.now() < deadline, 'focused native search must complete');
            await new Promise(resolve => setTimeout(resolve, 5));
        } while (true);
        assert.equal(result.state, 'complete');
        assert.deepEqual(new Set(result.entries.map(row => row.details.type)), new Set((diagnostics === 'true' ? on : off).entries.map(row => row.details.type)));
    }
});
