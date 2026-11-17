'use strict';
/** Doctor completion summaries use one source-aware policy without rewriting retained evidence. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../../shared/logger');
const { knownLogClassification } = require('../../shared/log-policy');
const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
const { readUnifiedPage, readUnifiedDetail } = require('../src/unified-log-page');
const { readLogExport } = require('../src/log-export');
const { createLogSearch } = require('../src/log-search');
const normalize = entry => expandLogEntry(normalizeLogEntry(entry));
const doctor = { dir: 'sp-client', label: 'Doctor App', role: 'doctor' };

/** Build representative historical system/default evidence with exact recorded metadata. */
function retainedRecord(type = 'DATA_FETCH_COMPLETED', extra = {}) {
    return {
        timestamp: '2026-11-16T12:05:23.064Z', sequence: 117, tick: '6201117',
        id: 'original-emitted-id', level: 'INFO', message: 'Data Fetch Completed',
        event: { schemaVersion: '1.0', eventName: type,
            source: { componentId: 'sp-client', role: 'doctor' },
            correlation: { flowId: 'fetch-classification-flow', correlationId: 'fetch-request',
                traceId: '11111111111111111111111111111111', spanId: '2222222222222222', parentSpanId: '3333333333333333', traceFlags: '01' },
            provenance: { kind: 'emitted' } },
        details: { type, category: 'system', visibility: 'default', causesSystemFlow: true,
            flowId: 'fetch-classification-flow', correlationId: 'fetch-request',
            consentId: 'saved-consent', targetUrl: 'https://source.test/fhir',
            payload: { resourceType: 'Bundle', entry: [], text: 'Exact non-AWS local payload ✓' }, ...extra }
    };
}

test('shared Doctor emission corrects legacy explicit values and preserves context and payload', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-emission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previousLogDir = process.env.LOG_DIR;
    process.env.LOG_DIR = root;
    t.after(() => {
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
    });
    const logger = createLogger({ service: 'sp-client' });
    const input = retainedRecord().details;
    logger.withContext({ causesSystemFlow: true }, () => logger.info('Data Fetch Completed', input));
    const emitted = JSON.parse(fs.readFileSync(logger.getLogPath(), 'utf8'));
    assert.deepEqual(emitted.details, { ...input, sessionId: logger.getSessionId(), category: 'harness', visibility: 'diagnostic' });
    assert.equal(input.category, 'system');
    assert.equal(input.visibility, 'default');
    assert.equal(emitted.event.eventName, 'DATA_FETCH_COMPLETED');
    assert.deepEqual(emitted.event.source, { componentId: 'sp-client', role: 'doctor' });
});

test('retained correction changes only classification and preserves true, false and absent flow flags', () => {
    for (const flag of [true, false, undefined]) {
        const input = retainedRecord('DATA_FETCH_COMPLETED', { causesSystemFlow: flag });
        const before = structuredClone(input), projected = normalizeLogEntry(input);
        assert.deepEqual(projected, { ...input, details: { ...input.details, category: 'harness', visibility: 'diagnostic' } });
        assert.deepEqual(input, before);
    }
    const eventOnly = retainedRecord();
    delete eventOnly.details.type;
    assert.equal(normalizeLogEntry(eventOnly).details.visibility, 'diagnostic');
    assert.deepEqual(knownLogClassification(retainedRecord(), { componentId: 'sp-client' }), { category: 'harness', visibility: 'diagnostic' });
});

test('exact identity and trusted source leave HTTP, authorization, failures and lookalikes unchanged', () => {
    for (const type of ['OUTGOING_REQUEST', 'OUTGOING_RESPONSE', 'OUTGOING_ERROR', 'TOKEN_ISSUED', 'INTROSPECTION_DECISION', 'DATA_FETCH_FAILED', 'DATA_FETCH_UNEXPECTED_RESPONSE', 'DATA_FETCH_COMPLETED_OTHER', 'UNKNOWN']) {
        const input = retainedRecord(type, { url: '/fetch-data' });
        // Even a conflicting completion envelope cannot replace the recorded explicit type.
        input.event.eventName = 'DATA_FETCH_COMPLETED';
        assert.deepEqual(normalizeLogEntry(input).details, input.details, type);
    }
    for (const source of [{ componentId: 'pcm-core', role: 'pcm' }, { componentId: 'ho-a-adapter', role: 'adapter' },
        { componentId: 'ho-a-gateway', role: 'gateway' }, { componentId: 'custom', role: 'application' }]) {
        const input = retainedRecord();
        assert.equal(knownLogClassification(input, source), null);
        input.event.source = source;
        assert.deepEqual(normalizeLogEntry(input).details, input.details);
    }
    const unknown = retainedRecord(); delete unknown.event;
    assert.deepEqual(normalizeLogEntry(unknown).details, unknown.details);
});

test('central and local retained browse/search/detail share Diagnostics policy and preserve exact source bytes', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-retained-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const adapter = { dir: 'ho-a-adapter', label: 'Adapter', role: 'adapter' };
    const components = [doctor, adapter];
    const records = [retainedRecord('OUTGOING_RESPONSE'), retainedRecord(), retainedRecord('DATA_FETCH_FAILED'), retainedRecord('INTROSPECTION_DECISION')];
    const target = records[1], targetOffset = Buffer.byteLength(JSON.stringify(records[0]) + '\n');
    const content = records.map(row => JSON.stringify(row)).join('\n') + '\n';
    for (const source of components) {
        fs.mkdirSync(path.join(root, source.dir));
        // The adapter deliberately claims Doctor metadata: configured identity must win.
        fs.writeFileSync(path.join(root, source.dir, 'current.log'), content);
    }
    const search = createLogSearch();
    t.after(() => search.close());
    for (const inventory of [components, [doctor]]) {
        for (const diagnostics of ['false', 'true']) {
            const page = readUnifiedPage(root, inventory, { diagnostics }, '', normalize);
            const summaries = page.entries.filter(row => row.details.type === 'DATA_FETCH_COMPLETED');
            assert.deepEqual(new Set(summaries.map(row => row.event.source.componentId)),
                new Set([...(diagnostics === 'true' ? ['sp-client'] : []), ...(inventory.length === 2 ? ['ho-a-adapter'] : [])]));
            assert.equal(page.entries.length, inventory.length * records.length - (diagnostics === 'false' ? 1 : 0));
            assert.equal(page.criticalDiagnostic, null);
            for (const summary of summaries) {
                const detail = readUnifiedDetail(root, inventory, summary.reference, normalize);
                assert.equal(detail.raw, JSON.stringify(target));
                assert.equal(detail.rawRedacted, false);
                assert.deepEqual(detail.source, { componentId: summary.event.source.componentId, logFile: 'current.log', byteOffset: targetOffset });
                assert.equal(detail.entry.id, summary.id);
                assert.equal(detail.entry.componentLine, targetOffset);
                assert.equal(detail.entry.sequence, 117);
                assert.equal(detail.entry.tick, '6201117');
                assert.deepEqual(detail.entry.event, { ...target.event, source: { componentId: summary.event.source.componentId, role: summary.event.source.role } });
                assert.deepEqual(detail.entry.details.payload, target.details.payload);
                assert.equal(detail.entry.details.causesSystemFlow, true);
                assert.equal(detail.entry.details.visibility, summary.event.source.role === 'doctor' ? 'diagnostic' : 'default');
                assert.equal(detail.entry.details.category, summary.event.source.role === 'doctor' ? 'harness' : 'system');
            }
            const job = search.start(root, inventory, { flowId: 'fetch-classification-flow', diagnostics });
            const deadline = Date.now() + 5000;
            let result;
            do {
                result = search.read(job.id, root, inventory);
                if (result.state !== 'running') break;
                assert.ok(Date.now() < deadline, 'focused retained search must complete');
                await new Promise(resolve => setTimeout(resolve, 5));
            } while (true);
            assert.equal(result.state, 'complete');
            assert.deepEqual(new Set(result.entries.map(row => row.id)), new Set(page.entries.map(row => row.id)));
            for (const entry of result.entries) {
                const detail = readUnifiedDetail(root, inventory, entry.reference, normalize);
                assert.equal(detail.entry.details.visibility, entry.details.visibility);
            }
        }
    }
    // Full-history export retains the recorded classification and payload, as before.
    const exported = readLogExport(root, components);
    assert.equal(exported.complete, true);
    for (const source of components) {
        assert.deepEqual(exported.logs[source.dir][1].details, target.details);
        assert.equal(fs.readFileSync(path.join(root, source.dir, 'current.log'), 'utf8'), content);
    }
});
