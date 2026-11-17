'use strict';
/** Realistic shared lifecycle failures must retain ownership and hide uncertain inventory. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executeOperation, publishOperation, verifyCounts } = require('../workflow');
const { operationOwner, latestVerifiedLoad } = require('../operation-owner');
const { inspectTransactionBundle, MANAGED_CLINICAL_RESOURCE_TYPES, countExactSearch } = require('../transaction-bundle');
const { DataOperationRegistry } = require('../../src/pcm-core/src/data-operations');
const buffer = fs.readFileSync(path.join(__dirname, '../ci/ho-a.source.transaction.json'));
const inspected = inspectTransactionBundle(buffer);

/** Model only the existing private FHIR boundary and injectable filesystem publication. */
function fixture(t, kind = 'import') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical-workflow-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const owner = operationOwner({ stateDir: directory, serverId: 'ho-a', kind, details: { sha256: inspected.sha256 }, env: {} });
    let posts = 0;
    let loaded = false;
    const options = { ...owner, buffer, endpoint: 'http://private/fhir', headers: {},
        fetchImpl: async (url, init = {}) => {
            if (init.method === 'POST') {
                posts++; loaded = true;
                return { ok: true, status: 200, text: async () => JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response', entry: inspected.bundle.entry.map(() => ({ response: { status: '201 Created' } })) }) };
            }
            return { ok: true, json: async () => ({ resourceType: 'Bundle', total: loaded ? inspected.counts[new URL(url).pathname.split('/').pop()] || 0 : 0 }) };
        } };
    return { ...owner, options, directory, posts: () => posts, clear: () => { loaded = false; } };
}

for (const failure of ['verification', 'publication']) {
    test(`${failure} failure never publishes inventory and retains recovery ownership`, async t => {
        const f = fixture(t);
        let cleanups = 0;
        f.options.cleanup = async () => { cleanups++; };
        if (failure === 'verification') {
            const original = f.options.fetchImpl;
            f.options.fetchImpl = (url, init) => init?.method === 'POST' ? original(url, init) : Promise.resolve({ ok: true, json: async () => ({ resourceType: 'Bundle', total: 0 }) });
        } else {
            const original = f.registry.write.bind(f.registry);
            f.registry.write = operation => { if (operation.phase === 'succeeded') throw new Error('ledger publication failed'); return original(operation); };
        }
        await assert.rejects(executeOperation(f.options), /mismatch|failed/);
        assert.equal(f.posts(), 1);
        assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
        assert.equal(f.registry.get(f.operation.id).submittedOutcome, 'unknown');
        assert.equal(f.registry.get(f.operation.id).failureStage,
            failure === 'verification' ? 'read-only-verification' : 'publication');
        assert.equal(f.registry.get(f.operation.id).deadlines.transactionWaitMs, 3_600_000);
        assert.equal(cleanups, 0);
        assert.equal(latestVerifiedLoad(f.registry, 'ho-a'), null);
        assert.throws(() => f.registry.create('ho-a', 'import'), /busy/);
        assert.equal(f.registry.create('ho-b', 'reset').phase, 'queued');
    });
}

test('verified publication survives upload cleanup failure and records the residual', async t => {
    const f = fixture(t);
    const result = await executeOperation({ ...f.options, cleanup: async () => { throw new Error('scoped cleanup failed'); } });
    assert.equal(result.phase, 'succeeded');
    assert.equal(f.posts(), 1);
    assert.match(f.registry.get(f.operation.id).diagnostics.at(-1), /Verified cleanup failed/);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a').id, result.id);
});

test('lost transaction response persists its deadline and explicitly unknown outcome', async t => {
    const f = fixture(t);
    const diagnostics = [];
    f.options.onDiagnostic = (stage, level, details) => diagnostics.push({ stage, level, details });
    const original = f.options.fetchImpl;
    f.options.fetchImpl = (url, init) => init?.method === 'POST'
        ? Promise.reject(Object.assign(new Error('HAPI transaction response exceeded deadline'), {
            clinicalFailureStage: 'hapi-transaction-wait', clinicalDeadlineMs: 1000
        })) : original(url, init);
    await assert.rejects(executeOperation(f.options), /deadline/);
    const result = f.registry.get(f.operation.id);
    assert.equal(result.submittedOutcome, 'unknown');
    assert.equal(result.failureStage, 'hapi-transaction-wait');
    assert.equal(result.failureDeadlineMs, 1000);
    assert.equal(result.needsReconciliation, true);
    assert.ok(diagnostics.some(item => item.stage === 'request'));
    assert.ok(diagnostics.some(item => item.stage === 'timeout' && item.level === 'error' && item.details.deadlineMs === 1000));
    assert.throws(() => f.registry.create('ho-a', 'replace'), /busy/);
});

test('delayed HAPI response records wait, then distinct acceptance, type checks and publication', async t => {
    const f = fixture(t);
    const diagnostics = [];
    f.options.onDiagnostic = (stage, level, details) => diagnostics.push({ stage, level, details });
    let releaseResponse;
    let enteredPost;
    const entered = new Promise(resolve => { enteredPost = resolve; });
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    const original = f.options.fetchImpl;
    f.options.fetchImpl = async (url, init) => {
        if (init?.method === 'POST') {
            assert.equal(init.headers['X-PCM-Operation-Id'], f.operation.id);
            enteredPost();
            await responseGate;
        }
        return original(url, init);
    };
    const running = executeOperation(f.options);
    await entered;
    const reader = new DataOperationRegistry({ directory: f.registry.directory });
    const waiting = reader.status(f.operation.id);
    assert.equal(waiting.currentStage, 'transaction-waiting');
    assert.ok(waiting.transactionDeadlineAt);
    assert.equal(waiting.stageTimestamps['response-received'], undefined);
    assert.equal(waiting.verifiedTypes.length, 0);
    assert.deepEqual(waiting.progressEvents.map(event => event.event).slice(0, 6), [
        'upload-received', 'bundle-check-started', 'bundle-check-complete',
        'target-preflight-started', 'target-preflight-complete', 'transaction-waiting'
    ]);
    releaseResponse();
    const result = await running;
    assert.equal(result.currentStage, 'completed');
    const events = result.progressEvents.map(event => event.event);
    assert.ok(events.indexOf('response-received') < events.indexOf('transaction-accepted'));
    assert.ok(events.indexOf('transaction-accepted') < events.indexOf('verification-started'));
    assert.ok(events.indexOf('type-verified') < events.indexOf('inventory-publication-started'));
    assert.ok(events.indexOf('inventory-publication-started') < events.indexOf('completed'));
    assert.equal(result.verifiedTypes.length, result.verificationTypeTotal);
    assert.equal(result.verifiedTypes.find(item => item.type === 'Patient').count, inspected.counts.Patient);
    assert.deepEqual(diagnostics.map(item => item.stage), ['request', 'response', 'transaction-accepted', 'verified']);
});

test('HAPI HTTP error records response and failure with operation context', async t => {
    const f = fixture(t);
    const diagnostics = [];
    f.options.onDiagnostic = (stage, level, details) => diagnostics.push({ stage, level, details });
    const original = f.options.fetchImpl;
    f.options.fetchImpl = (url, init) => init?.method === 'POST'
        ? Promise.resolve({ ok: false, status: 500, text: async () => '{"issue":"synthetic HAPI error"}' })
        : original(url, init);
    await assert.rejects(executeOperation(f.options), /HAPI returned HTTP 500/);
    assert.deepEqual(diagnostics.map(item => item.stage), ['request', 'response', 'failure']);
    assert.equal(diagnostics[1].details.httpStatus, 500);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
});

test('verified child retains reservation until parent publication and rejects duplicate manual POST', async t => {
    const f = fixture(t);
    await executeOperation({ ...f.options, deferCompletion: true });
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a'), null);
    assert.throws(() => f.registry.create('ho-a', 'import'), /busy/);
    publishOperation(f.registry, f.operation);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a').sha256, inspected.sha256);
    const next = f.registry.create('ho-a', 'import', { sha256: inspected.sha256 });
    await assert.rejects(executeOperation({ ...f.options, operation: next }), /already loaded/);
    assert.equal(f.posts(), 1);
    assert.equal(latestVerifiedLoad(f.registry, 'ho-a').id, f.operation.id);
});

for (const type of ['DocumentReference', 'MedicationAdministration']) {
    test(`${type}-only target blocks ordinary POST before mutation`, async t => {
        const f = fixture(t);
        let typeProbes = 0;
        f.options.fetchImpl = async (url, init = {}) => {
            assert.notEqual(init.method, 'POST');
            if (url.includes(`/${type}?`)) typeProbes++;
            return { ok: true, json: async () => ({ resourceType: 'Bundle', total: url.includes(`/${type}?`) ? 1 : 0 }) };
        };
        await assert.rejects(executeOperation(f.options), /target is non-empty/);
        assert.equal(f.posts(), 0);
        assert.equal(typeProbes, 1);
        assert.equal(f.registry.get(f.operation.id).needsReconciliation, false);
    });
}

test('a future unsupported resource type is refused before any target query or POST', async t => {
    const f = fixture(t);
    const bundle = JSON.parse(buffer);
    bundle.entry[0].resource.resourceType = 'FutureClinicalResource';
    bundle.entry[0].request.url = 'FutureClinicalResource';
    let requests = 0;
    f.options.fetchImpl = async () => { requests++; throw new Error('unexpected target request'); };
    await assert.rejects(executeOperation({ ...f.options, buffer: Buffer.from(JSON.stringify(bundle)) }), /FutureClinicalResource is unsupported/);
    assert.equal(requests, 0);
    assert.equal(f.registry.get(f.operation.id).mutationSubmitted, undefined);
    assert.equal(f.registry.get(f.operation.id).submittedOutcome, 'not-submitted');
});

test('source-tagged verification detects missing and extra resources independently of target totals', async () => {
    for (const delta of [-1, 1]) {
        await assert.rejects(verifyCounts({ endpoint: 'http://private/fhir', headers: {}, fetchImpl: async url => {
            assert.match(url, /_tag=urn%3Ahdp-test-bundle%3Asynthetic-source/);
            assert.match(url, /_tag=urn%3Ahdp-test-bundle%3Asynthetic-dataset/);
            const type = new URL(url).pathname.split('/').pop();
            return { ok: true, json: async () => ({ resourceType: 'Bundle', total: (inspected.counts[type] || 0) + (type === 'Patient' ? delta : 0) }) };
        } }, inspected), /verification count mismatch/);
    }
    await assert.rejects(verifyCounts({ endpoint: 'http://private/fhir', headers: {}, fetchImpl: async url => {
        const type = new URL(url).pathname.split('/').pop();
        return { ok: true, json: async () => ({ resourceType: 'Bundle', total: type === 'DocumentReference'
            ? 1 : inspected.counts[type] || 0 }) };
    } }, inspected), /DocumentReference verification count mismatch: expected 0, received 1/);
});

test('post-load verification uses one uncached exact aggregate per type with both scope tags', async () => {
    const calls = [];
    const progress = [];
    const counts = await verifyCounts({ endpoint: 'http://private/fhir', headers: { 'X-PCM-Import-Credential': 'private-test' },
        fetchImpl: async (url, init) => {
            const parsed = new URL(url);
            calls.push(parsed);
            assert.equal(parsed.searchParams.get('_summary'), 'count');
            assert.equal(parsed.searchParams.get('_total'), 'accurate');
            assert.equal(parsed.searchParams.has('_count'), false);
            assert.deepEqual(parsed.searchParams.getAll('_tag'), [
                `urn:hdp-test-bundle:synthetic-source|${inspected.source}`,
                `urn:hdp-test-bundle:synthetic-dataset|${inspected.version}`
            ]);
            assert.equal(init.headers['Cache-Control'], 'no-cache');
            assert.equal(init.headers['X-PCM-Import-Credential'], 'private-test');
            return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle',
                total: inspected.counts[parsed.pathname.split('/').pop()] || 0 }) };
        }
    }, inspected, (type, count) => progress.push({ type, count }));
    assert.deepEqual(counts, inspected.counts);
    assert.equal(calls.length, MANAGED_CLINICAL_RESOURCE_TYPES.length);
    assert.equal(progress.length, MANAGED_CLINICAL_RESOURCE_TYPES.length);
    assert.ok(progress.some(item => item.count === 0));
});

test('invalid or unauthorized aggregates cannot be treated as empty or trigger resource downloads', async () => {
    for (const [status, body] of [
        [200, { resourceType: 'Bundle' }],
        [200, { resourceType: 'Bundle', total: -1 }],
        [200, { resourceType: 'Bundle', total: 1.5 }],
        [200, { resourceType: 'Bundle', total: '0' }],
        [403, { resourceType: 'OperationOutcome', issue: [{ diagnostics: 'not authorized' }] }],
        [400, { resourceType: 'OperationOutcome', issue: [{ diagnostics: 'unrelated error' }] }]
    ]) {
        let requests = 0;
        await assert.rejects(countExactSearch({ endpoint: 'http://private/fhir', initialUrl: 'http://private/fhir/Patient',
            fetchImpl: async () => { requests++; return { ok: status === 200, status, json: async () => body }; }
        }), /exact count response is invalid/);
        assert.equal(requests, 1);
    }
});

test('known older private count rejection falls back to ID pages with both tags retained', async () => {
    const calls = [];
    const total = await countExactSearch({ endpoint: 'http://private/fhir',
        initialUrl: 'http://private/fhir/Patient?_tag=source%7Ctest&_tag=dataset%7Cv1', fetchImpl: async url => {
            const parsed = new URL(url);
            calls.push(parsed);
            assert.deepEqual(parsed.searchParams.getAll('_tag'), ['source|test', 'dataset|v1']);
            if (parsed.searchParams.has('_summary')) return { ok: false, status: 400,
                json: async () => ({ resourceType: 'OperationOutcome', issue: [{ diagnostics: 'HAPI-2038: _summary=count is not permitted on this server' }] }) };
            assert.equal(parsed.searchParams.get('_elements'), 'id');
            assert.equal(parsed.searchParams.get('_count'), '1000');
            assert.equal(parsed.searchParams.has('_total'), false);
            return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', entry: [{ resource: { id: '1' } }] }) };
        }
    });
    assert.equal(total, 1);
    assert.equal(calls.length, 2);
});

for (const kind of ['reset', 'replace']) test(`${kind} verifies empty state before completion or resubmission`, async t => {
    const f = fixture(t, kind);
    const result = await executeOperation({ ...f.options, reset: async () => {
        f.registry.transition(f.operation.id, 'resetting', { mutationSubmitted: true, inventoryInvalidated: true });
        f.clear();
    } });
    assert.equal(result.phase, 'succeeded');
    assert.ok(result.resetVerifiedAt);
    assert.equal(f.posts(), kind === 'replace' ? 1 : 0);
});

test('uncertain legacy marker blocks POST and requires explicit recovery', async t => {
    const f = fixture(t);
    const marker = path.join(f.directory, `${inspected.sha256}.json`);
    fs.writeFileSync(marker, JSON.stringify({ status: 'recovery-required', sha256: inspected.sha256 }));
    await assert.rejects(executeOperation({ ...f.options, legacyStateDir: f.directory }), /explicit reconciliation/);
    assert.equal(f.posts(), 0);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.ok(fs.existsSync(marker));
});

test('complete legacy evidence with missing persisted data is never replayed', async t => {
    const f = fixture(t);
    const marker = path.join(f.directory, `${inspected.sha256}.json`);
    fs.writeFileSync(marker, JSON.stringify({ status: 'complete', targetHo: 'ho-a', sha256: inspected.sha256,
        entries: inspected.entries, verifiedCounts: inspected.counts }));
    await assert.rejects(executeOperation({ ...f.options, legacyStateDir: f.directory }), /count mismatch/);
    assert.equal(f.posts(), 0);
    assert.equal(f.registry.get(f.operation.id).needsReconciliation, true);
    assert.ok(fs.existsSync(marker));
});

test('verified reset retires old markers before a replacement transaction', async t => {
    const f = fixture(t, 'replace');
    const marker = path.join(f.directory, `${inspected.sha256}.json`);
    fs.writeFileSync(marker, JSON.stringify({ status: 'recovery-required' }));
    const result = await executeOperation({ ...f.options, legacyStateDir: f.directory, reset: async () => {
        f.registry.transition(f.operation.id, 'resetting', { mutationSubmitted: true, inventoryInvalidated: true });
        f.clear();
    } });
    assert.equal(result.phase, 'succeeded');
    assert.equal(fs.existsSync(marker), false);
    assert.equal(f.posts(), 1);
});
