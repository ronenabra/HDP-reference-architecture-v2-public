'use strict';
/** Stopped import reconciliation proves content without a second mutation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DataOperationRegistry, latestVerifiedLoad } = require('../../src/pcm-core/src/data-operations');
const { inspectTransactionBundle } = require('../transaction-bundle');
const { reconcileOperation, resetUncertainTarget, readAllResources, verifyLiveTransaction, normalizedResource } = require('../reconciliation');

const tags = [
    { system: 'urn:hdp-test-bundle:synthetic-source', code: 'ho-a' },
    { system: 'urn:hdp-test-bundle:synthetic-dataset', code: 'recovery-test-v1' }
];
const patientUrn = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const observationUrn = 'urn:uuid:22222222-2222-4222-8222-222222222222';
const sourceEntries = [
    { fullUrl: patientUrn, request: { method: 'POST', url: 'Patient' }, resource: {
        resourceType: 'Patient', meta: { tag: tags }, identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }], name: [{ text: 'Test Eleven' }]
    } },
    { fullUrl: observationUrn, request: { method: 'POST', url: 'Observation' }, resource: {
        resourceType: 'Observation', meta: { tag: tags }, status: 'final', code: { text: 'Test result' },
        subject: { reference: patientUrn }, valueString: 'normal'
    } }
];
const buffer = Buffer.from(JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: sourceEntries }));
const inspected = inspectTransactionBundle(buffer);

function fixture(t, edit = () => {}, { interrupted = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical-reconcile-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const registry = new DataOperationRegistry({ directory: path.join(directory, 'data-operations') });
    const targetIdentity = '{"id":"ho-a"}';
    const operation = registry.create('ho-a', 'import', { targetIdentity, sha256: inspected.sha256,
        bytes: inspected.bytes, entries: inspected.entries, source: inspected.source, version: inspected.version });
    registry.transition(operation.id, 'loading', { mutationSubmitted: true, inventoryInvalidated: true });
    if (!interrupted) registry.transition(operation.id, 'failed', { needsReconciliation: true, submittedOutcome: 'unknown' });
    const uploadPath = path.join(directory, `${operation.id}.json`);
    fs.writeFileSync(uploadPath, buffer);
    const resources = sourceEntries.map((entry, index) => ({ ...structuredClone(entry.resource), id: `live-${index + 1}`,
        meta: { ...structuredClone(entry.resource.meta), versionId: '1', lastUpdated: '2026-09-29T00:00:00Z' } }));
    resources[1].subject.reference = 'Patient/live-1';
    edit(resources);
    let posts = 0;
    const fetchImpl = async (url, init = {}) => {
        if (init.method === 'POST') { posts++; if (url.endsWith('/$expunge')) resources.splice(0); }
        const pathname = new URL(url).pathname;
        const type = pathname.split('/').pop();
        const entries = pathname.endsWith('/_history') ? [] : resources.filter(resource => resource.resourceType === type).map(resource => ({ resource }));
        const total = pathname.endsWith('/_history') ? resources.length : entries.length;
        return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total, entry: entries }) };
    };
    const options = { registry, operationId: operation.id, workersStopped: true, targetIdentity, uploadPath,
        endpoint: 'http://private/fhir', headers: {}, fetchImpl,
        cleanup: async () => fs.unlinkSync(uploadPath) };
    return { registry, operation, options, posts: () => posts, resources, uploadPath };
}

test('complete evidence publishes one result and Patient inventory with zero POSTs', async t => {
    const f = fixture(t);
    const result = await reconcileOperation(f.options);
    assert.equal(result.phase, 'succeeded');
    assert.equal(result.currentStage, 'completed');
    assert.equal(result.progressEvents.at(-1).event, 'completed');
    assert.equal(result.submittedOutcome, 'verified-complete');
    assert.equal(result.patients.length, 1);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a').id, result.id);
    assert.equal(f.posts(), 0);
    assert.equal(fs.existsSync(f.uploadPath), false);
    assert.throws(() => f.registry.completeReconciliation(result.id, {}));
    assert.equal(result.verificationMethod, 'complete-content');
});

test('a restarted reader fences an explicitly stopped unfinished submission before complete-content proof', async t => {
    const f = fixture(t, () => {}, { interrupted: true });
    const restarted = new DataOperationRegistry({ directory: f.registry.directory });
    const result = await reconcileOperation({ ...f.options, registry: restarted, fetchImpl: async (...args) => {
        const pending = restarted.get(f.operation.id);
        assert.equal(pending.needsReconciliation, true);
        assert.equal(pending.submittedOutcome, 'unknown');
        assert.equal(pending.failureStage, 'worker-stopped');
        assert.throws(() => f.registry.transition(f.operation.id, 'verifying'), /fenced/);
        return f.options.fetchImpl(...args);
    } });
    assert.equal(result.phase, 'succeeded');
    assert.equal(result.verificationMethod, 'complete-content');
    assert.equal(result.submittedOutcome, 'verified-complete');
    assert.ok(result.stoppedWorkerConfirmedAt);
    assert.equal(f.posts(), 0);
    assert.equal(fs.existsSync(f.uploadPath), false);
});

test('unfinished recovery requires literal stopped confirmation and preserves uncertain ownership on failed proof', async t => {
    const f = fixture(t, resources => { resources[1].valueString = 'different'; }, { interrupted: true });
    const before = fs.readFileSync(f.registry.file(f.operation.id));
    for (const workersStopped of [false, undefined, 'true']) {
        await assert.rejects(reconcileOperation({ ...f.options, workersStopped }), /confirmed stopped workers/);
        assert.deepEqual(fs.readFileSync(f.registry.file(f.operation.id)), before);
    }
    await assert.rejects(reconcileOperation(f.options), /mismatch|changed|extra/);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.equal(f.registry.get(f.operation.id).submittedOutcome, 'unknown');
    assert.throws(() => f.registry.create('ho-a', 'import'), /busy/);
    assert.equal(fs.existsSync(f.uploadPath), true);
    assert.equal(f.posts(), 0);
});

test('an unprovable killed import permits only confirmed target-scoped reset before a fresh import', async t => {
    const f = fixture(t, resources => { resources[1].valueString = 'different'; }, { interrupted: true });
    const options = { ...f.options, confirmation: 'delete-all:team:ho-a', expectedConfirmation: 'delete-all:team:ho-a' };
    await assert.rejects(resetUncertainTarget({ ...options, confirmation: 'other-target' }), /confirmation/);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, undefined);
    assert.equal(f.posts(), 0);
    const result = await resetUncertainTarget(options);
    assert.equal(result.phase, 'failed');
    assert.equal(result.submittedOutcome, 'resolved-by-target-reset');
    assert.equal(result.needsReconciliation, false);
    assert.equal(f.posts(), 1);
    assert.equal(f.registry.create('ho-a', 'import').phase, 'queued');
});

/** Model a validated transaction response followed by a failed count-only verification. */
function recordAcceptedResponse(f, patch = {}) {
    f.registry.write({ ...f.registry.get(f.operation.id), beforeResourceCount: 0, hasHistory: false,
        failureStage: 'read-only-verification', stageTimestamps: { 'transaction-accepted': '2026-10-08T10:00:00Z' }, ...patch });
}

test('accepted response recovery checks aggregates/history without downloading bodies or replaying POST', async t => {
    const f = fixture(t);
    recordAcceptedResponse(f);
    let requests = 0;
    f.options.fetchImpl = async (url, init = {}) => {
        requests++;
        assert.notEqual(init.method, 'POST');
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/_history')) {
            assert.equal(parsed.searchParams.get('_count'), '1');
            return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: inspected.entries }) };
        }
        assert.equal(parsed.searchParams.get('_summary'), 'count');
        assert.equal(parsed.searchParams.get('_total'), 'accurate');
        assert.equal(init.headers['Cache-Control'], 'no-cache');
        return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle',
            total: inspected.counts[parsed.pathname.split('/').pop()] || 0 }) };
    };
    const result = await reconcileOperation(f.options);
    assert.equal(result.verificationMethod, 'accepted-transaction-counts');
    assert.equal(result.contentSha256, undefined);
    assert.equal(result.history, undefined);
    assert.equal(result.hasHistory, true);
    assert.equal(result.phase, 'succeeded');
    assert.equal(result.verifiedTypes.length, 19);
    assert.equal(requests, 39);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a').id, result.id);
});

for (const issue of ['tagged count', 'foreign data', 'missing history']) {
    test(`accepted response recovery retains the reservation on ${issue}`, async t => {
        const f = fixture(t);
        recordAcceptedResponse(f);
        f.options.fetchImpl = async url => {
            const parsed = new URL(url);
            const type = parsed.pathname.split('/').pop();
            let total = type === '_history' ? inspected.entries : inspected.counts[type] || 0;
            if (issue === 'missing history' && type === '_history') total = 0;
            if (type === 'Patient' && ((issue === 'tagged count' && parsed.searchParams.has('_tag'))
                || (issue === 'foreign data' && !parsed.searchParams.has('_tag')))) total++;
            return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total }) };
        };
        await assert.rejects(reconcileOperation(f.options), /mismatch|no persisted history/);
        assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
        assert.equal(latestVerifiedLoad(f.registry, 'ho-a'), null);
        assert.throws(() => f.registry.create('ho-a', 'import'), /busy/);
        assert.equal(fs.existsSync(f.uploadPath), true);
    });
}

for (const patch of [
    { stageTimestamps: {} }, { beforeResourceCount: 1 }, { hasHistory: true },
    { failureStage: 'transaction-response' }, { failureStage: 'hapi-transaction-wait' }
]) test(`count recovery cannot replace full proof without accepted empty-target evidence: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, resources => { resources[1].valueString = 'changed'; });
    recordAcceptedResponse(f, patch);
    await assert.rejects(reconcileOperation(f.options), /content.*changed/);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.equal(f.posts(), 0);
});

test('HAPI metadata set reordering preserves complete recovery proof', async t => {
    const f = fixture(t, resources => {
        for (const resource of resources) resource.meta.tag.reverse();
    });
    const result = await reconcileOperation(f.options);
    assert.equal(result.phase, 'succeeded');
    assert.equal(f.posts(), 0);
});

test('metadata normalization preserves values, clinical order and primitive extension pairing', () => {
    const source = { resourceType: 'Patient', name: [{ given: ['First', 'Second'] }], meta: {
        tag: tags, profile: ['urn:profile:a', 'urn:profile:b'],
        security: [{ system: 'urn:security', code: 'a' }, { system: 'urn:security', code: 'b' }]
    } };
    const before = structuredClone(source);
    const reordered = structuredClone(source);
    for (const field of ['tag', 'profile', 'security']) reordered.meta[field].reverse();
    assert.equal(normalizedResource(source), normalizedResource(reordered));
    assert.deepEqual(source, before);
    for (const field of ['profile', 'security']) {
        const changed = structuredClone(source);
        changed.meta[field].pop();
        assert.notEqual(normalizedResource(source), normalizedResource(changed));
    }
    const clinicalChange = structuredClone(source);
    clinicalChange.name[0].given.reverse();
    assert.notEqual(normalizedResource(source), normalizedResource(clinicalChange));
    source.meta._profile = [{ extension: [{ url: 'urn:test', valueString: 'first' }] }, null];
    const pairedChange = structuredClone(source);
    pairedChange.meta.profile.reverse();
    assert.notEqual(normalizedResource(source), normalizedResource(pairedChange));
});

for (const [name, edit] of [
    ['changed metadata member', resources => { resources[0].meta.tag[0].display = 'changed'; }],
    ['changed provenance source', resources => { resources[0].meta.source = 'urn:changed-source'; }],
    ['duplicate metadata member', resources => { resources[0].meta.tag.push(structuredClone(tags[0])); }]
]) test(`${name} retains the reconciliation reservation`, async t => {
    const f = fixture(t, edit);
    await assert.rejects(reconcileOperation(f.options), /Patient content at transaction entry 0.*changed/);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.throws(() => f.registry.create('ho-a', 'import'), /busy/);
    assert.equal(f.posts(), 0);
});

for (const [name, edit] of [
    ['partial', resources => resources.pop()],
    ['changed', resources => { resources[1].valueString = 'abnormal'; }],
    ['duplicate', resources => { resources.push(structuredClone(resources[1])); }],
    ['foreign', resources => { resources.push({ ...structuredClone(resources[1]), id: 'foreign', valueString: 'foreign' }); }],
    ['history', resources => { resources[0].meta.versionId = '2'; }]
]) test(`${name} data cannot publish or release ownership`, async t => {
    const f = fixture(t, edit);
    await assert.rejects(reconcileOperation(f.options), /mismatch|changed|duplicate|extra|history|ambiguous/);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a'), null);
    assert.throws(() => f.registry.create('ho-a', 'reset'), /busy/);
    assert.equal(f.posts(), 0);
    assert.equal(fs.existsSync(f.uploadPath), true);
});

test('still-running declaration and concurrent barrier retain the reservation', async t => {
    const f = fixture(t);
    await assert.rejects(reconcileOperation({ ...f.options, workersStopped: false }), /stopped workers/);
    const release = f.registry.beginReconciliation(f.operation.id);
    assert.throws(() => f.registry.beginReconciliation(f.operation.id), /EEXIST/);
    assert.throws(() => f.registry.transition(f.operation.id, 'failed'), /fenced/);
    release();
    assert.throws(() => f.registry.create('ho-a', 'replace'), /busy/);
});

test('cleanup failure records diagnostics after verified publication', async t => {
    const f = fixture(t);
    const result = await reconcileOperation({ ...f.options, cleanup: async () => { throw new Error('unlink denied'); } });
    assert.equal(result.phase, 'succeeded');
    assert.match(result.diagnostics.at(-1), /cleanup failed/);
    assert.equal(fs.existsSync(f.uploadPath), true);
    assert.equal(f.posts(), 0);
});

test('changed upload or target identity cannot start reconciliation', async t => {
    const f = fixture(t);
    await assert.rejects(reconcileOperation({ ...f.options, targetIdentity: '{"id":"ho-b"}' }), /target configuration changed/);
    fs.writeFileSync(f.uploadPath, Buffer.from(JSON.stringify({ ...JSON.parse(buffer), entry: sourceEntries.slice(0, 1) })));
    await assert.rejects(reconcileOperation(f.options), /saved upload differs/);
    assert.equal(f.posts(), 0);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.throws(() => f.registry.create('ho-a', 'import'), /busy/);
});

test('explicit target-scoped reset requires exact confirmation and verified zero state', async t => {
    const f = fixture(t, resources => { resources[1].valueString = 'changed'; });
    const options = { registry: f.registry, operationId: f.operation.id, workersStopped: true,
        targetIdentity: f.options.targetIdentity, confirmation: 'delete-all:team:ho-a',
        expectedConfirmation: 'delete-all:team:ho-a', endpoint: f.options.endpoint,
        headers: {}, fetchImpl: f.options.fetchImpl };
    await assert.rejects(resetUncertainTarget({ ...options, confirmation: 'wrong' }), /confirmation/);
    assert.equal(f.posts(), 0);
    const result = await resetUncertainTarget(options);
    assert.equal(result.phase, 'failed');
    assert.equal(result.currentStage, 'failed');
    assert.equal(result.lastCompletedStage, 'reset-complete');
    assert.equal(result.needsReconciliation, false);
    assert.equal(result.submittedOutcome, 'resolved-by-target-reset');
    assert.equal(f.posts(), 1);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a'), null);
    assert.equal(f.registry.create('ho-a', 'import').phase, 'queued');
});

test('content enumeration follows HAPI system-level page links through the private endpoint', async () => {
    const calls = [];
    const resources = await readAllResources({ endpoint: 'http://private/fhir', headers: {}, fetchImpl: async url => {
        calls.push(url);
        return { ok: true, json: async () => calls.length === 1
            ? { resourceType: 'Bundle', total: 2, entry: [{ resource: { resourceType: 'Patient', id: 'one' } }],
                link: [{ relation: 'next', url: 'http://internal:8080/fhir?_getpages=abc' }] }
            : { resourceType: 'Bundle', total: 2, entry: [{ resource: { resourceType: 'Patient', id: 'two' } }] } };
    } }, 'Patient', 2);
    assert.equal(resources.length, 2);
    assert.equal(calls[1], 'http://private/fhir?_getpages=abc');
});

test('complete resource and history proof supports more than 100 bounded pages', async () => {
    const entries = Array.from({ length: 101 }, (_, index) => ({ fullUrl: `urn:uuid:source-${index}`,
        request: { method: 'POST' }, resource: { resourceType: 'Patient', identifier: [{ system: 'urn:test', value: String(index) }] } }));
    const live = entries.map((entry, index) => ({ ...entry.resource, id: `live-${index}`, meta: { versionId: '1' } }));
    const calls = [];
    const result = await verifyLiveTransaction({ endpoint: 'http://private/fhir', headers: {},
        inspected: { bundle: { entry: entries }, counts: { Patient: 101 }, entries: 101 },
        fetchImpl: async url => {
            calls.push(url);
            const parsed = new URL(url);
            const type = parsed.pathname.split('/').pop();
            const page = Number(parsed.searchParams.get('page') || 0);
            const populated = type === 'Patient' || type === '_history';
            return { ok: true, json: async () => ({ resourceType: 'Bundle',
                entry: populated ? [{ resource: live[page] }] : [],
                link: populated && page < 100 ? [{ relation: 'next', url: `http://private/fhir/${type}?page=${page + 1}` }] : [] }) };
        } });
    assert.deepEqual(result.counts, { Patient: 101 });
    assert.equal(result.history, 101);
    assert.equal(calls.filter(url => new URL(url).pathname.endsWith('/Patient')).length, 101);
    assert.equal(calls.filter(url => new URL(url).pathname.endsWith('/_history')).length, 101);
});

test('reconciliation rejects invalid entry limits and bounds empty continuation chains', async () => {
    let calls = 0;
    const transport = { endpoint: 'http://private/fhir', headers: {}, fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => ({ resourceType: 'Bundle', entry: [],
            link: [{ relation: 'next', url: `http://private/fhir/Patient?page=${calls}` }] }) };
    } };
    for (const limit of [-1, NaN, Infinity, undefined]) {
        await assert.rejects(readAllResources(transport, 'Patient', limit), /invalid reconciliation entry limit/);
    }
    assert.equal(calls, 0);
    await assert.rejects(readAllResources(transport, 'Patient', 1), /exceeded 2 pages/);
    assert.equal(calls, 2);
});

test('lost-response recovery counts complete history from the explicit origin and refuses foreign versions', async t => {
    const f=fixture(t);
    const fetchImpl=async(url,init)=>{
        const parsed=new URL(url);
        if(parsed.pathname==='/fhir/_history')return {ok:true,status:200,json:async()=>({resourceType:'Bundle',
            total:parsed.searchParams.get('_since')==='0001-01-01T00:00:00Z'?inspected.entries:0})};
        return f.options.fetchImpl(url,init);
    };
    const evidence=await verifyLiveTransaction({...f.options,inspected,fetchImpl});
    assert.equal(evidence.history,inspected.entries);
    await assert.rejects(verifyLiveTransaction({...f.options,inspected,fetchImpl:async(url,init)=>{
        if(new URL(url).pathname==='/fhir/_history')return {ok:true,status:200,json:async()=>({resourceType:'Bundle',total:inspected.entries+1})};
        return fetchImpl(url,init);
    }}),/target history differs/);
});
