'use strict';
/** Emitted causes survive the one trusted browse/search/detail/export projection without historical joins. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { readUnifiedPage, readUnifiedDetail } = require('../src/unified-log-page');
const { readLogExport } = require('../src/log-export');
const { createLogSearch } = require('../src/log-search');
const { project } = require('../src/admin-log-view');
const source = { dir: 'ho-a-hapi-runtime', label: 'A HAPI runtime', role: 'hapi', healthOrganizationId: 'ho-a', strictPath: true };
const cause = { setting: 'maxAllocatedBytes', threshold: 2147483648, observed: 2159627600, unit: 'bytes' };
const message = 'HAPI_ERROR · QUERY_BUDGET_EXCEEDED: maxAllocatedBytes limit=2147483648 bytes observed=2159627600 bytes';
/** Write only an owned temporary log; callers can inspect the exact original bytes independently. */
function fixture(t, details = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-budget-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const record = { timestamp: '2026-11-16T12:19:31.401Z', level: 'ERROR', message,
        details: { type: 'HAPI_ERROR', reasonCode: 'QUERY_BUDGET_EXCEEDED', budgetFailure: cause, status: 503, correlationId: 'budget-request', ...details } };
    const raw = JSON.stringify(record); fs.mkdirSync(path.join(root, source.dir));
    fs.writeFileSync(path.join(root, source.dir, 'current.log'), raw + '\n');
    return { root, raw };
}
test('central and source-local browse, selected JSON/raw and export retain exact emitted message and cause', t => {
    const f = fixture(t);
    for (const filters of [{ diagnostics: 'true' }, { diagnostics: 'true', source: source.dir, role: 'hapi' }]) {
        const page = readUnifiedPage(f.root, [source], filters); assert.equal(page.entries.length, 1);
        const row = page.entries[0]; assert.equal(row.message, message); assert.deepEqual(row.details.budgetFailure, cause);
        const selected = readUnifiedDetail(f.root, [source], row.reference); assert.equal(selected.raw, f.raw);
        assert.deepEqual(selected.entry.details.budgetFailure, cause); assert.equal(selected.entry.message, message);
    }
    const exported = readLogExport(f.root, [source]); assert.equal(exported.complete, true);
    assert.match(JSON.stringify(exported), /2159627600/); assert.ok(JSON.stringify(exported).includes(message));
    const off = readUnifiedPage(f.root, [source], { diagnostics: 'false' });
    assert.equal(off.entries.length, 0); assert.ok(off.criticalDiagnostic, 'existing diagnostic ERROR notice remains visible');
});
test('retained literal search diagnoses the final ERROR independently', async t => {
    const f = fixture(t), service = createLogSearch(); t.after(() => service.close());
    for (const filters of [{ text: 'maxAllocatedBytes', diagnostics: 'true' }, { text: '2159627600 bytes', diagnostics: 'true', source: source.dir }]) {
        const job = service.start(f.root, [source], filters); let result; const deadline = Date.now() + 5000;
        do { result = service.read(job.id, f.root, [source]); if (result.state !== 'running') break;
            assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); } while (true);
        assert.equal(result.state, 'complete'); assert.equal(result.entries.length, 1);
        assert.equal(result.entries[0].message, message); assert.deepEqual(result.entries[0].details.budgetFailure, cause);
    }
});
test('malformed, unknown and oversized cause shapes cannot enter bounded summary fields', t => {
    for (const malformed of [null, [], { ...cause, extra: 'untrusted' }, { ...cause, threshold: '2147483648' },
        { ...cause, observed: -1 }, { ...cause, observed: Number.MAX_SAFE_INTEGER + 1 },
        { ...cause, setting: '__proto__' }, { ...cause, unit: 'bytes'.repeat(10000) }]) {
        const f = fixture(t, { budgetFailure: malformed }); const page = readUnifiedPage(f.root, [source], { diagnostics: 'true' });
        assert.equal(page.entries[0].details.budgetFailure, undefined);
        assert.equal(readUnifiedDetail(f.root, [source], page.entries[0].reference).raw, f.raw);
    }
});
test('historical WARNs and generic ERRORs remain raw and incomplete without unsafe display derivation', () => {
    for (const logger of ['org.hl7.hdp.pcm.hapi.PcmQueryLimits', 'unrelated']) for (const args of [
        ['maxAllocatedBytes', 2147483648, 2159627600], ['unknown', 1, 2], ['maxAllocatedBytes', '1', 2], [], ['maxAllocatedBytes', 1, 'x'.repeat(10000)]]) {
        const raw = JSON.stringify({ level: 'WARN', message: 'HAPI native runtime warning/error', details: { type: 'HAPI_NATIVE_DIAGNOSTIC',
            nativeLogger: logger, nativeMessage: 'PCM_QUERY_LIMIT setting={} threshold={} observed={}', arguments: args } });
        const row = project(raw, { component: source, logFile: 'current.log' }, 17);
        assert.equal(row.raw, raw); assert.equal(row.byteOffset, 17); assert.equal(row.details.budgetFailure, undefined);
        assert.equal(row.message, 'HAPI native runtime warning/error');
    }
    const raw = JSON.stringify({ level: 'ERROR', message: 'HAPI_ERROR · error-response', details: { type: 'HAPI_ERROR' } });
    assert.equal(project(raw, { component: source, logFile: 'current.log' }, 1).details.budgetFailure, undefined);
});

test('private-token budget stays at its trusted adapter owner in shared summaries', t => {
    const f = fixture(t);
    const adapter = { dir: 'ho-a-adapter', label: 'A Adapter', role: 'adapter', healthOrganizationId: 'ho-a' };
    const privateCause = { setting: 'maxPrivateAuthorizationBytes', threshold: 1, observed: 2048, unit: 'bytes' };
    fs.mkdirSync(path.join(f.root, adapter.dir));
    const raw = JSON.stringify({ timestamp: '2026-11-16T12:20:00Z', level: 'WARN', message: 'Private token refusal', details: {
        type: 'DS_AUTHORIZATION_DENIED', reasonCode: 'QUERY_BUDGET_EXCEEDED', budgetFailure: privateCause } });
    fs.writeFileSync(path.join(f.root, adapter.dir, 'current.log'), raw + '\n');
    const page = readUnifiedPage(f.root, [adapter], {diagnostics:'false'});
    assert.deepEqual(page.entries[0].details.budgetFailure, privateCause);
    assert.equal(readUnifiedDetail(f.root, [adapter], page.entries[0].reference).raw, raw);
    const {summarize} = require('../src/unified-log-page');
    assert.equal(summarize({...page.entries[0], event:{source:{role:'hapi'}}},'x').details.budgetFailure, undefined);
    assert.equal(summarize({...page.entries[0], details:{...page.entries[0].details,budgetFailure:cause}},'x').details.budgetFailure, undefined);
});
