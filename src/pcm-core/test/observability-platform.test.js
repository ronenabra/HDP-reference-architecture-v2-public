'use strict';
/** Executable contract for source identity, provenance, privacy and bounded projection. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEventMetadata, configuredExtensionSources, normalizeExtensionRecord } = require('../../shared/log-event');
const { configuredLogComponents, orderUnifiedLogs } = require('../src/log-ordering');
const { readUnifiedPage, readUnifiedDetail, ROW_LIMIT } = require('../src/unified-log-page');
const { readComponentLogRecords } = require('../src/log-reader');
const { clearConfiguredLogs } = require('../src/log-clear');
const { filesFor, project } = require('../src/admin-log-view');
const { validateTeamConfig } = require('../../shared/team-config-validator');
const { buildTeamConfig } = require('../../../test-support/team-config');

/** Own and remove only this test's temporary source files. */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observability-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, write(dir, records, logFile = 'current.log') {
        const filename = path.join(root, dir, logFile); fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, records.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n'); return filename;
    } };
}
const event = (index, details = {}) => ({ timestamp: new Date(1767225600000 + index).toISOString(), level: 'INFO', message: `event ${index}`, details });
const extension = { id: 'security-demo', label: 'Demo security tool', role: 'security', format: 'hdp-jsonl' };
const gateway = { dir: 'ho-a-gateway', label: 'Renamed Healthcare Gateway', role: 'gateway', healthOrganizationId: 'ho-a' };

test('versioned envelope uses configured role/source and bounded AWS-safe context', () => {
    const result = createEventMetadata(event(0, { type: 'TOKEN_MINTED', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flowId: 'AKIAABCDEFGHIJKLMNOP' }), gateway);
    assert.equal(result.schemaVersion, '1.0'); assert.equal(result.source.componentId, 'ho-a-gateway');
    assert.equal(result.source.role, 'gateway'); assert.equal(result.correlation.traceId, 'a'.repeat(32));
    assert.equal(result.correlation.flowId, '[AWS_CREDENTIAL_BLOCKED]');
    assert.equal(createEventMetadata(event(0, { traceId: '0'.repeat(32), spanId: 'bad' }), gateway).correlation.traceId, undefined);
});

test('extensions are opt-in read-only configured files with closed identity and schema validation', () => {
    assert.deepEqual(configuredExtensionSources({}), []);
    const config = buildTeamConfig({ observability: { sources: [extension] } });
    assert.equal(validateTeamConfig(config).valid, true);
    assert.equal(configuredLogComponents(config).at(-1).dir, 'extensions/security-demo');
    for (const source of [{ ...extension, id: '../outside' }, { ...extension, role: 'pcm' }, { ...extension, path: '/tmp/private' }, { ...extension, format: 'javascript' }]) {
        assert.throws(() => configuredExtensionSources({ observability: { sources: [source] } }), /Invalid/);
        assert.equal(validateTeamConfig(buildTeamConfig({ observability: { sources: [source] } })).valid, false);
    }
    assert.throws(() => configuredExtensionSources({ observability: { sources: [extension, extension] } }), /duplicate/);
});

test('external source cannot claim built-in roles or default visibility and preserves non-AWS payloads', t => {
    const { root, write } = fixture(t), sources = configuredExtensionSources({ observability: { sources: [extension] } });
    write(sources[0].dir, [event(1, { role: 'pcm', visibility: 'default', type: 'OUTGOING_REQUEST', token: 'synthetic-token', patient: 'Patient/demo', AWS_SECRET_ACCESS_KEY: 'secret' })]);
    assert.equal(readUnifiedPage(root, sources).entries.length, 0);
    const page = readUnifiedPage(root, sources, { diagnostics: 'true' });
    assert.equal(page.entries[0].event.source.role, 'security');
    assert.equal(page.entries[0].event.provenance.kind, 'imported');
    const detail = readUnifiedDetail(root, sources, page.entries[0].reference);
    assert.equal(detail.details.token, 'synthetic-token'); assert.equal(detail.details.patient, 'Patient/demo');
    assert.equal(detail.details.AWS_SECRET_ACCESS_KEY, '[AWS_CREDENTIAL_BLOCKED]'); assert.equal(detail.rawRedacted, true);
    assert.doesNotMatch(detail.raw, /"secret"/);
    const exported = readComponentLogRecords(root, sources[0].dir, sources[0].dir, { allHistory: true, source: sources[0] });
    assert.doesNotMatch(JSON.stringify(exported), /"secret"/);
    assert.equal(clearConfiguredLogs(root, sources).results[0].status, 'retained');
    assert.ok(fs.readFileSync(path.join(root, sources[0].dir, 'current.log'), 'utf8'));
});

test('external malformed/unsupported records report parse errors without unsafe raw fallback', t => {
    const { root, write } = fixture(t), sources = configuredExtensionSources({ observability: { sources: [extension] } });
    write(sources[0].dir, ['{"AWS_SECRET_ACCESS_KEY":"unsafe"', { event: { schemaVersion: '99' }, message: 'unsafe' }]);
    const page = readUnifiedPage(root, sources, { diagnostics: 'true' });
    assert.equal(page.entries.length, 2);
    for (const row of page.entries) {
        const detail = readUnifiedDetail(root, sources, row.reference);
        assert.equal(detail.provenance.kind, 'unparsed'); assert.ok(detail.parseError); assert.equal(detail.rawRedacted, true);
        assert.doesNotMatch(detail.raw, /unsafe/);
    }
});

test('single OpenTelemetry LogRecord adapter keeps trace IDs and does not pretend to be OTLP ingestion', () => {
    const source = { ...configuredExtensionSources({ observability: { sources: [extension] } })[0], format: 'otel-log-record' };
    const record = normalizeExtensionRecord({ timeUnixNano: '1767225600000000000', severityText: 'WARN', body: { stringValue: 'A policy decision' }, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flags: 1,
        attributes: [{ key: 'http.request.method', value: { stringValue: 'POST' } }, { key: '__proto__', value: { stringValue: 'bad' } }] }, source);
    assert.equal(record.timestamp, '2026-01-01T00:00:00.000Z'); assert.equal(record.message, 'A policy decision');
    assert.equal(record.event.correlation.traceId, 'a'.repeat(32)); assert.equal(record.event.correlation.traceFlags, '01');
    assert.equal(record.details.attributes['http.request.method'], 'POST'); assert.equal(Object.hasOwn(record.details.attributes, '__proto__'), false);
    assert.throws(() => normalizeExtensionRecord({ resourceLogs: [] }, source), /LogRecord/);
});

test('per-HO gateway error streams appear in browse/export and are truncated by clear', t => {
    const { root, write } = fixture(t);
    write(gateway.dir, ['2026/10/06 12:00:00 [error] request failed'], 'error.log');
    assert.ok(filesFor(root, [gateway]).some(file => file.logFile === 'error.log'));
    assert.equal(readUnifiedPage(root, [gateway]).entries.length, 1);
    assert.equal(readComponentLogRecords(root, gateway.dir).length, 1);
    assert.equal(clearConfiguredLogs(root, [gateway]).status, 'cleared');
    assert.equal(fs.readFileSync(path.join(root, gateway.dir, 'error.log'), 'utf8'), '');
});

test('gateway error inference never crosses two HO sources and marks inferred correlation', () => {
    const failure = (id, component, ho, details) => ({ id, component, ...event(1, { role: 'gateway', healthOrganizationId: ho, method: 'GET', url: '/fhir/Patient', status: 502, ...details }) });
    const rows = [failure('b-response', 'B Gateway', 'ho-b', { type: 'GATEWAY_RESPONSE', correlationId: 'b' }),
        failure('a-error', 'A Gateway', 'ho-a', { type: 'GATEWAY_ERROR' }), failure('a-response', 'A Gateway', 'ho-a', { type: 'GATEWAY_RESPONSE', correlationId: 'a' })];
    const result = orderUnifiedLogs(rows, 'timeline').find(row => row.id === 'a-error');
    assert.equal(result.details.correlationId, 'a'); assert.equal(result.details.correlationMethod, 'inferred-time-url');
});

test('every page truthfully reports incomplete coverage, exact trace/flow filters and missing source inventory', t => {
    const { root, write } = fixture(t);
    write(gateway.dir, Array.from({ length: ROW_LIMIT + 10 }, (_, i) => event(i, { type: 'REQUEST', flowId: 'same-flow', traceId: 'a'.repeat(32) })));
    const first = readUnifiedPage(root, [gateway, { dir: 'ho-a-hapi', label: 'HAPI', role: 'hapi-import' }], { flowId: 'same-flow' });
    assert.equal(first.entries.length, ROW_LIMIT); assert.equal(first.coverage.scope, 'page'); assert.equal(first.coverage.state, 'partial');
    assert.ok(first.coverage.reasons.includes('older-records')); assert.equal(first.sources[1].coverage, 'import-only'); assert.equal(first.sources[1].state, 'missing');
    const next = readUnifiedPage(root, [gateway, { dir: 'ho-a-hapi', label: 'HAPI', role: 'hapi-import' }], { flowId: 'same-flow' }, first.nextCursor);
    assert.equal(next.entries.length, 10); assert.ok(next.coverage.reasons.includes('older-page'));
    assert.equal(readUnifiedPage(root, [gateway], { traceId: 'b'.repeat(32) }).entries.length, 0);
});

test('selected raw identity detects same-size in-place rewrites; malformed native raw stays visible', t => {
    const { root, write } = fixture(t); const filename = write(gateway.dir, ['{malformed']);
    const row = readUnifiedPage(root, [gateway]).entries[0], detail = readUnifiedDetail(root, [gateway], row.reference);
    assert.equal(detail.raw, '{malformed'); assert.ok(detail.entry.parseError); assert.equal(detail.provenance.kind, 'unparsed');
    fs.writeFileSync(filename, '{different\n');
    assert.throws(() => readUnifiedDetail(root, [gateway], row.reference), /changed/);
});

test('native AWS transformations are disclosed and raw reference variant stays bounded for huge type strings', t => {
    const { root, write } = fixture(t);
    write(gateway.dir, [event(1, { type: 'a'.repeat(100000), AWS_SECRET_ACCESS_KEY: 'must-not-appear' })]);
    const row = readUnifiedPage(root, [gateway]).entries[0];
    assert.ok(row.reference.length < 1024);
    const detail = readUnifiedDetail(root, [gateway], row.reference);
    assert.equal(detail.rawRedacted, true); assert.doesNotMatch(JSON.stringify(detail), /must-not-appear/);
});

test('extension symlinks are reported rather than reading outside the declared mount', t => {
    const { root, write } = fixture(t), sources = configuredExtensionSources({ observability: { sources: [extension] } });
    const secret = write('other', [event(1)]); fs.mkdirSync(path.join(root, sources[0].dir), { recursive: true });
    fs.symlinkSync(secret, path.join(root, sources[0].dir, 'current.log'));
    const result = readUnifiedPage(root, sources, { diagnostics: 'true' });
    assert.equal(result.entries.length, 0); assert.match(result.failures[0].error, /symlink/);
    assert.throws(() => readComponentLogRecords(root, sources[0].dir, sources[0].dir, { source: sources[0] }), /symlink/);
});

test('selected derived gateway request retains its own identity and exact source response text', t => {
    require('../../../test-support/team-config').installTestRuntime();
    const { normalizeLogEntry, expandLogEntry } = require('../src/index');
    const normalize = entry => expandLogEntry(normalizeLogEntry(entry));
    const { root, write } = fixture(t);
    const record = event(1000, { type: 'GATEWAY_RESPONSE', method: 'GET', url: '/fhir/Observation', status: 200, requestTime: 0.2, correlationId: 'request-a' });
    write(gateway.dir, [record]);
    const page = readUnifiedPage(root, [gateway], {}, '', normalize);
    assert.equal(page.entries.length, 2);
    const request = page.entries.find(row => row.details.type === 'GATEWAY_REQUEST'), response = page.entries.find(row => row.details.type === 'GATEWAY_RESPONSE');
    assert.notEqual(request.reference, response.reference);
    const selected = readUnifiedDetail(root, [gateway], request.reference, normalize);
    assert.equal(selected.entry.id, request.id); assert.equal(selected.details.type, 'GATEWAY_REQUEST');
    assert.equal(selected.details.status, undefined); assert.equal(selected.provenance.kind, 'derived');
    assert.equal(selected.provenance.derivedFrom, response.id); assert.equal(selected.raw, JSON.stringify(record));
    assert.equal(selected.event.source.role, 'gateway'); assert.match(selected.provenance.note, /response record/);
    const original = readUnifiedDetail(root, [gateway], response.reference, normalize);
    assert.equal(original.details.type, 'GATEWAY_RESPONSE'); assert.equal(original.details.status, 200); assert.equal(original.provenance.kind, 'emitted');
    const legacyRef = JSON.parse(Buffer.from(response.reference, 'base64url').toString()); delete legacyRef.variant; delete legacyRef.digest;
    assert.equal(readUnifiedDetail(root, [gateway], Buffer.from(JSON.stringify(legacyRef)).toString('base64url'), normalize).details.type, 'GATEWAY_RESPONSE');
});

test('diagnostics OFF excludes harness errors while keeping real protocol errors and token events', t => {
    const { normalizeLogEntry, expandLogEntry } = require('../src/index');
    const { root, write } = fixture(t);
    write(gateway.dir, [event(1, { type: 'HARNESS_FAILURE' }), event(2, { type: 'TOKEN_MINTED' }),
        { ...event(3, { type: 'OUTGOING_ERROR' }), level: 'ERROR' }, { ...event(4, { type: 'HARNESS_ERROR' }), level: 'ERROR' }]);
    const normalize = entry => expandLogEntry(normalizeLogEntry(entry));
    const visible = readUnifiedPage(root, [gateway], {}, '', normalize).entries;
    assert.deepEqual(visible.map(row => row.details.type).sort(), ['OUTGOING_ERROR', 'TOKEN_MINTED']);
    assert.equal(readUnifiedPage(root, [gateway], { diagnostics: 'true' }, '', normalize).entries.length, 4);
});

test('OTel semantic AWS attributes and nested credential kvlists cannot escape through raw/detail/export', t => {
    const { root, write } = fixture(t);
    const sources = configuredExtensionSources({ observability: { sources: [{ ...extension, format: 'otel-log-record' }] } });
    const kv = (key, value) => ({ key, value: { stringValue: value } });
    const row = { body: { kvlistValue: { values: [kv('AccessKeyId', 'example-access'), kv('SecretAccessKey', 'nested-secret'), kv('SessionToken', 'nested-session')] } },
        attributes: [kv('AWS_SECRET_ACCESS_KEY', 'review-secret'), kv('x-amz-security-token', 'review-session'), kv('non-aws-token', 'keep-synthetic')] };
    write(sources[0].dir, [row]);
    const page = readUnifiedPage(root, sources, { diagnostics: 'true' });
    const detail = readUnifiedDetail(root, sources, page.entries[0].reference);
    const exported = readComponentLogRecords(root, sources[0].dir, sources[0].dir, { source: sources[0], allHistory: true });
    assert.equal(detail.rawRedacted, true);
    for (const secret of ['review-secret', 'review-session', 'nested-secret', 'nested-session', 'example-access']) {
        assert.equal(detail.raw.includes(secret), false, secret);
        assert.equal(JSON.stringify(exported).includes(secret), false, secret);
    }
    assert.match(detail.raw, /keep-synthetic/); assert.match(detail.raw, /AWS_CREDENTIAL_BLOCKED/);
});

test('invalid external timestamps cannot hide healthy protocol events with Diagnostics OFF or ON', t => {
    const { normalizeLogEntry, expandLogEntry } = require('../src/index');
    const normalize = entry => expandLogEntry(normalizeLogEntry(entry));
    const { root, write } = fixture(t), sources = [gateway, ...configuredExtensionSources({ observability: { sources: [extension] } })];
    write(gateway.dir, [event(1, { type: 'TOKEN_MINTED' })]);
    write(sources[1].dir, [event(2, { type: 'GATEWAY_RESPONSE', timestampEpoch: 1e100, requestTime: -1e100 })]);
    const hidden = readUnifiedPage(root, sources, {}, '', normalize);
    assert.equal(hidden.entries.length, 1); assert.equal(hidden.entries[0].details.type, 'TOKEN_MINTED');
    const visible = readUnifiedPage(root, sources, { diagnostics: 'true' }, '', normalize);
    assert.equal(visible.entries.length, 2); assert.ok(visible.entries.some(row => row.details.type === 'TOKEN_MINTED'));
    assert.equal(visible.entries.find(row => row.event.source.role === 'security').event.provenance.kind, 'imported');
    assert.equal(normalizeLogEntry(event(3, { timestampEpoch: 1e100 })).timestamp, event(3).timestamp);
});

test('hostile external field types fail into diagnostic parse errors without poisoning native pages', t => {
    const { normalizeLogEntry, expandLogEntry } = require('../src/index');
    const normalize = entry => expandLogEntry(normalizeLogEntry(entry));
    const { root, write } = fixture(t), sources = [gateway, ...configuredExtensionSources({ observability: { sources: [extension] } })];
    const hostile = { toString: null, valueOf: null };
    write(gateway.dir, [event(1, { type: 'TOKEN_MINTED' })]);
    write(sources[1].dir, [{ timestamp: hostile }, { message: hostile }, { details: { type: hostile } }, { tick: hostile }, { details: { flowId: hostile } }]);
    assert.equal(readUnifiedPage(root, sources, {}, '', normalize).entries.length, 1);
    const visible = readUnifiedPage(root, sources, { diagnostics: 'true' }, '', normalize);
    assert.equal(visible.entries.length, 6); assert.equal(visible.entries.filter(row => row.parseError).length, 5);
});

test('extension open rejects a last-moment symlink swap before any outside bytes are read', t => {
    const { openLogFile } = require('../src/log-source');
    const { root, write } = fixture(t), source = configuredExtensionSources({ observability: { sources: [extension] } })[0];
    const filename = write(source.dir, [event(1)]), outside = write('outside', ['outside-canary']);
    const io = { ...fs, openSync(name, flags) { fs.unlinkSync(filename); fs.symlinkSync(outside, filename); return fs.openSync(name, flags); } };
    assert.throws(() => openLogFile(root, { component: source, filename }, io), /ELOOP|symlink|changed/);
});

test('extension open rejects an ancestor swap even when the last path is an ordinary file', t => {
    const { openLogFile } = require('../src/log-source');
    const { root, write } = fixture(t), source = configuredExtensionSources({ observability: { sources: [extension] } })[0];
    const filename = write(source.dir, [event(1)]), other = write('outside', ['outside-canary']);
    const directory = path.dirname(filename);
    const io = { ...fs, openSync(name, flags) { fs.renameSync(directory, directory + '-old'); fs.symlinkSync(path.dirname(other), directory); return fs.openSync(name, flags); } };
    assert.throws(() => openLogFile(root, { component: source, filename }, io), /changed/);
});

test('native current/history and gateway error exports share AWS-safe projections', t => {
    const { root, write } = fixture(t);
    write(gateway.dir, [event(1, { AWS_SECRET_ACCESS_KEY: 'native-export-secret', token: 'keep-synthetic' })]);
    write(gateway.dir, [event(0, { AWS_SESSION_TOKEN: 'retained-export-secret' })], 'history/old/app.log');
    write(gateway.dir, ['2026/10/06 12:00:00 [error] AKIAABCDEFGHIJKLMNOP'], 'error.log');
    const records = readComponentLogRecords(root, gateway.dir, gateway.dir, { source: gateway, allHistory: true });
    assert.doesNotMatch(JSON.stringify(records), /native-export-secret|retained-export-secret|AKIAABCDEFGHIJKLMNOP/);
    assert.match(JSON.stringify(records), /keep-synthetic/); assert.ok(records.some(row => row.rawRedacted));
});

test('maximum extension inventory and five rotations page with compact bounded compatible cursors', t => {
    const zlib = require('node:zlib');
    const { root, write } = fixture(t);
    const sources = Array.from({ length: 16 }, (_, index) => ({ id: `source-${index}-` + 'x'.repeat(38), label: `Application ${index}`, role: 'application' }));
    const inventory = configuredLogComponents(buildTeamConfig({ observability: { sources } }));
    const records = Array.from({ length: 20 }, (_, i) => event(i, { type: 'REQUEST' }));
    for (const component of inventory) {
        write(component.dir, records);
        for (let index = 0; index < 5; index++) write(component.dir, records, `history/2026-10-0${index + 1}T21-00-00.000Z/app.log`);
    }
    const filters = { diagnostics: 'true', order: 'timeline' }, seen = new Set();
    let cursor = '', pages = 0;
    do {
        const page = readUnifiedPage(root, inventory, filters, cursor);
        assert.ok(page.bytesRead <= 1024 * 1024); assert.ok(page.entries.length <= 200);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
        for (const row of page.entries) { assert.equal(seen.has(row.id), false); seen.add(row.id); }
        if (page.nextCursor) { assert.match(page.nextCursor, /^z1\./); assert.ok(page.nextCursor.length < 8000, 'full inventory cursor fits an ordinary request line'); }
        cursor = page.nextCursor; pages++;
        assert.ok(pages < 100);
    } while (cursor);
    assert.equal(inventory.length, 33);
    for (const id of ['ho-a', 'ho-b', 'ho-c']) assert.ok(inventory.some(row => row.dir === `${id}-hapi-runtime`));
    assert.equal(seen.size, 33 * 6 * 20);
    const small = readUnifiedPage(root, [inventory[0]], filters);
    // Larger fixture demonstrates compression; use a legacy state from its first snapshot.
    const first = readUnifiedPage(root, inventory, filters);
    const legacyBytes = zlib.inflateRawSync(Buffer.from(first.nextCursor.slice(3), 'base64url'));
    const legacy = JSON.parse(legacyBytes); legacy.files = legacy.files.filter(state => state.name.startsWith(inventory[0].dir + '/'));
    const legacyCursor = Buffer.from(JSON.stringify(legacy)).toString('base64url');
    assert.doesNotThrow(() => readUnifiedPage(root, [inventory[0]], filters, legacyCursor));
    assert.equal(small.coverage.scope, 'page');
});

test('compressed cursors reject expansion beyond the fixed state bound', t => {
    const zlib = require('node:zlib'), { MAX_CURSOR_STATE } = require('../src/unified-log-page');
    const { root } = fixture(t);
    const cursor = 'z1.' + zlib.deflateRawSync(Buffer.from(' '.repeat(MAX_CURSOR_STATE + 1))).toString('base64url');
    assert.throws(() => readUnifiedPage(root, [], {}, cursor), /Invalid log cursor/);
});
