'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
    DATASET_TAG_SYSTEM,
    MANAGED_CLINICAL_RESOURCE_TYPES,
    SOURCE_TAG_SYSTEM,
    countSearchResults,
    inspectTransactionBundle,
    readPrivateDataState,
    safeBundlePath,
    validateTransactionResponse
} = require('../transaction-bundle');
const { executeOperation } = require('../workflow');
const { operationOwner } = require('../operation-owner');
const { DataOperationRegistry } = require('../../src/pcm-core/src/data-operations');

const resource = (type, suffix, reference) => ({
    resourceType: type,
    ...(reference ? { subject: { reference } } : {}),
    meta: { tag: [
        { system: DATASET_TAG_SYSTEM, code: '3.0.1' },
        { system: SOURCE_TAG_SYSTEM, code: 'hospital-a' }
    ] },
    identifier: [{ system: 'urn:test', value: suffix }]
});

function sample() {
    const patientUrl = 'urn:uuid:00000000-0000-4000-8000-000000000001';
    return Buffer.from(JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: [
        { fullUrl: patientUrl, resource: resource('Patient', 'p1'), request: { method: 'POST', url: 'Patient' } },
        { fullUrl: 'urn:uuid:00000000-0000-4000-8000-000000000002', resource: resource('Observation', 'o1', patientUrl), request: { method: 'POST', url: 'Observation' } }
    ] }));
}

test('direct synthetic transaction contract records stable preflight inventory', () => {
    const parsed = JSON.parse(sample());
    parsed.entry[0].resource.identifier.push({
        system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id',
        value: '1'
    });
    const inspected = inspectTransactionBundle(Buffer.from(JSON.stringify(parsed)));
    assert.equal(inspected.entries, 2);
    assert.equal(inspected.source, 'hospital-a');
    assert.equal(inspected.version, '3.0.1');
    assert.deepEqual(inspected.counts, { Observation: 1, Patient: 1 });
    assert.deepEqual(inspected.patients, [{
        idSystem: 'http://fhir.health.gov.il/identifier/il-hdp-test-id',
        idValue: '1',
        display: '1'
    }]);
    assert.match(inspected.sha256, /^[a-f0-9]{64}$/);
});

test('validation fails before mutation for shape, limits, tags, and references', () => {
    assert.throws(() => inspectTransactionBundle(Buffer.from('{')), /not valid JSON/);
    assert.throws(() => inspectTransactionBundle(sample(), { limits: { maxBytes: 10 } }), /maxBytes/);
    const parsed = JSON.parse(sample());
    parsed.entry[1].resource.subject.reference = 'urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff';
    assert.throws(() => inspectTransactionBundle(Buffer.from(JSON.stringify(parsed))), /unresolved/);
    parsed.entry[1].resource.subject.reference = parsed.entry[0].fullUrl;
    parsed.entry[1].resource.meta.tag.find(tag => tag.system === SOURCE_TAG_SYSTEM).code = 'hospital-b';
    assert.throws(() => inspectTransactionBundle(Buffer.from(JSON.stringify(parsed))), /consistent/);
});

test('the import allowlist includes the incident types and rejects a future type', () => {
    for (const type of ['DocumentReference', 'MedicationAdministration']) {
        const parsed = JSON.parse(sample());
        parsed.entry[1].resource.resourceType = type;
        parsed.entry[1].request.url = type;
        assert.equal(inspectTransactionBundle(Buffer.from(JSON.stringify(parsed))).counts[type], 1);
        assert.ok(MANAGED_CLINICAL_RESOURCE_TYPES.includes(type));
    }
    const parsed = JSON.parse(sample());
    parsed.entry[1].resource.resourceType = 'FutureClinicalResource';
    parsed.entry[1].request.url = 'FutureClinicalResource';
    assert.throws(() => inspectTransactionBundle(Buffer.from(JSON.stringify(parsed))), /FutureClinicalResource is unsupported/);
});

test('target-wide inventory counts all 15 incident types with exact aggregates', async () => {
    const originalTypes = MANAGED_CLINICAL_RESOURCE_TYPES.filter(type => !['DocumentReference', 'MedicationAdministration'].includes(type));
    const nonzero = Object.fromEntries(originalTypes.slice(0, 13).map(type => [type, 1]));
    nonzero.Patient = 3945;
    nonzero.DocumentReference = 45;
    nonzero.MedicationAdministration = 8;
    // The fixture models the observed 4,010 total and the two formerly omitted types.
    assert.equal(Object.keys(nonzero).length, 15);
    const requests = [];
    const state = await readPrivateDataState({ endpoint: 'http://private/fhir', headers: {}, fetchImpl: async url => {
        requests.push(url);
        const parsed = new URL(url);
        const type = parsed.pathname.split('/').pop();
        if (type === '_history') return { ok: true, json: async () => ({ resourceType: 'Bundle', total: 4010, entry: [{}] }) };
        return { ok: true, json: async () => ({ resourceType: 'Bundle', total: nonzero[type] || 0 }) };
    } });
    assert.equal(state.currentResourceCount, 4010);
    assert.equal(Object.values(state.counts).filter(Boolean).length, 15);
    assert.equal(state.counts.DocumentReference, 45);
    assert.equal(state.counts.MedicationAdministration, 8);
    assert.equal(state.hasHistory, true);
    assert.ok(requests.includes('http://private/fhir/DocumentReference?_summary=count&_total=accurate'));
    assert.equal(requests.length, MANAGED_CLINICAL_RESOURCE_TYPES.length + 1);
});

test('empty current data and history remain independent target state', async () => {
    for (const history of [false, true]) {
        const state = await readPrivateDataState({ endpoint: 'http://private/fhir', headers: {}, fetchImpl: async url => ({
            ok: true, json: async () => ({ resourceType: 'Bundle', total: url.includes('/_history') && history ? 1 : 0 })
        }) });
        assert.equal(state.currentResourceCount, 0);
        assert.equal(state.hasHistory, history);
    }
});

test('bootstrap path stays inside its configured root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-bundles-'));
    try {
        fs.writeFileSync(path.join(root, 'bundle.json'), '{}');
        assert.equal(safeBundlePath(root, 'bundle.json'), path.join(root, 'bundle.json'));
        assert.throws(() => safeBundlePath(root, '../secret.json'), /safe path/);
        assert.throws(() => safeBundlePath(root, '/etc/passwd'), /safe path/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('transaction response entries are fail closed', () => {
    assert.equal(validateTransactionResponse({ resourceType: 'Bundle', type: 'transaction-response', entry: [{ response: { status: '201 Created' } }] }, 1), true);
    assert.throws(() => validateTransactionResponse({ resourceType: 'Bundle', type: 'transaction-response', entry: [{ response: { status: '400 Bad Request' } }] }, 1), /rejected/);
});

test('exact FHIR counts follow bounded pagination without trusting the returned host', async () => {
    const requested = [];
    const pages = [
        {
            resourceType: 'Bundle',
            entry: [{ resource: { resourceType: 'Patient' } }, { resource: { resourceType: 'Patient' } }],
            link: [{ relation: 'next', url: 'https://public.example.test/fhir/Patient?_count=2&_getpages=next' }]
        },
        { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient' } }] }
    ];
    const count = await countSearchResults({
        endpoint: 'http://private-hapi:8080/fhir',
        initialUrl: 'http://private-hapi:8080/fhir/Patient?_count=2',
        headers: { Authorization: 'Basic test' },
        fetchImpl: async (url, options) => {
            requested.push({ url, options });
            return { ok: true, status: 200, json: async () => pages.shift() };
        }
    });

    assert.equal(count, 3);
    assert.equal(requested.length, 2);
    assert.equal(requested[1].url, 'http://private-hapi:8080/fhir/Patient?_count=2&_getpages=next');
    assert.equal(requested[1].options.headers.Authorization, 'Basic test');

    await assert.rejects(countSearchResults({
        endpoint: 'http://private-hapi:8080/fhir',
        initialUrl: 'http://private-hapi:8080/fhir/Patient?_count=1',
        maxPages: 1,
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                resourceType: 'Bundle', entry: [{}],
                link: [{ relation: 'next', url: 'http://private-hapi:8080/fhir/Patient?page=2' }]
            })
        })
    }), /exceeded 1 pages/);
});

test('completed loader evidence is reconciled into the verified PCM operation ledger', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-recorded-import-'));
    try {
        const parsed = JSON.parse(sample());
        parsed.entry[0].resource.identifier.push({
            system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1'
        });
        const bundlePath = path.join(directory, 'hospital-a.source.transaction.json');
        fs.writeFileSync(bundlePath, JSON.stringify(parsed));
        const inspected = inspectTransactionBundle(fs.readFileSync(bundlePath));
        const importState = path.join(directory, 'import');
        fs.mkdirSync(importState);
        fs.writeFileSync(path.join(importState, `${inspected.sha256}.json`), JSON.stringify({
            status: 'complete', targetHo: 'ho-a', sha256: inspected.sha256,
            entries: inspected.entries, verifiedCounts: inspected.counts
        }));
        const owner = operationOwner({ stateDir: path.join(directory, 'state'), serverId: 'ho-a', kind: 'import', details: { sha256: inspected.sha256 }, env: {} });
        const live = parsed.entry.map((entry, index) => ({ ...structuredClone(entry.resource), id: `live-${index + 1}`,
            meta: { ...entry.resource.meta, versionId: '1', lastUpdated: '2026-09-29T00:00:00Z' } }));
        live[1].subject.reference = 'Patient/live-1';
        const operation = await executeOperation({ ...owner, buffer: fs.readFileSync(bundlePath),
            endpoint: 'http://private/fhir', headers: {}, legacyStateDir: importState,
            fetchImpl: async url => {
                const type = new URL(url).pathname.split('/').pop();
                const entries = type === '_history' ? [] : live.filter(item => item.resourceType === type).map(item => ({ resource: item }));
                return { ok: true, json: async () => ({ resourceType: 'Bundle', total: type === '_history' ? live.length : entries.length, entry: entries }) };
            }
        });
        assert.equal(fs.existsSync(path.join(importState, `${inspected.sha256}.json`)), false);
        assert.equal(operation.phase, 'succeeded');
        assert.deepEqual(operation.patients, inspected.patients);
        assert.equal(new DataOperationRegistry({ directory: path.join(directory, 'state', 'data-operations') }).list('ho-a').length, 1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('if-empty preserves other-type and history-only targets without submission or marker writes', async t => {
    const { runTransactionBundleImport } = require('../loader');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-skip-state-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bundlePath = path.join(directory, 'hospital-a.source.transaction.json');
    fs.writeFileSync(bundlePath, sample());
    for (const historyOnly of [false, true]) {
        let submissions = 0;
        const stateDir = path.join(directory, String(historyOnly));
        const result = await runTransactionBundleImport({
            bundlePath, owner: operationOwner({ stateDir: path.join(directory, 'owners', String(historyOnly)), serverId: 'ho-a', kind: 'import', env: {} }), expectedHo: 'ho-a', endpoint: 'http://private/fhir', credential: 'local-test-credential'.repeat(2),
            stateDir, policy: 'if-empty', emit() {}, beforeSubmit: () => { submissions++; },
            fetchImpl: async (url, options) => {
                assert.notEqual(options.method, 'POST');
                return { ok: true, json: async () => url.includes('/_history')
                    ? { resourceType: 'Bundle', entry: historyOnly ? [{ request: { method: 'DELETE' } }] : [] }
                    : { resourceType: 'Bundle', total: !historyOnly && url.includes('/Condition?') ? 1 : 0 } };
            }
        });
        assert.equal(result.result, 'skipped');
        assert.equal(result.skipReason, historyOnly ? 'target-has-history' : 'target-non-empty');
        assert.equal(submissions, 0);
        assert.equal(fs.existsSync(stateDir), false);
    }
});

test('direct bundle if-empty checks actual HAPI state before mutation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-direct-bundle-'));
    const bundlePath = path.join(directory, 'hmo.source.transaction.json');
    const resource = {
        resourceType: 'Patient',
        meta: { tag: [
            { system: 'urn:hdp-test-bundle:synthetic-dataset', code: '3.0.1' },
            { system: 'urn:hdp-test-bundle:synthetic-source', code: 'hmo' }
        ] },
        identifier: [{ system: 'urn:test:patient', value: 'patient-1' }]
    };
    fs.writeFileSync(bundlePath, JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: [{ fullUrl: 'urn:uuid:00000000-0000-4000-8000-000000000001', resource, request: { method: 'POST', url: 'Patient' } }] }));
    const calls = [];
    const skipped = await require('../loader').runTransactionBundleImport({
        bundlePath, owner: operationOwner({ stateDir: path.join(directory, 'owners'), serverId: 'ho-a', kind: 'import', env: {} }), expectedHo: 'ho-a', endpoint: 'http://clinical-import-hapi:8080/fhir', credential: '0123456789abcdef0123456789abcdef',
        stateDir: path.join(directory, 'state'), policy: 'if-empty', emit: () => {},
        fetchImpl: async url => {
            calls.push(url);
            return { ok: true, json: async () => ({ resourceType: 'Bundle', total: url.includes('/Patient?') ? 7 : 0 }) };
        }
    });
    assert.equal(skipped.result, 'skipped');
    assert.equal(calls.length, require('../transaction-bundle').MANAGED_CLINICAL_RESOURCE_TYPES.length + 1);
    assert.equal(skipped.beforeCounts.Patient, 7);
    assert.equal(skipped.beforeResourceCount, 7);
    fs.rmSync(directory, { recursive: true, force: true });
});

test('private target counts request fresh exact totals with at most three in-flight types', async () => {
    let active = 0;
    let maximum = 0;
    const requests = [];
    const state = await readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async (url, init) => {
        assert.ok(init.signal);
        assert.equal(init.headers['Cache-Control'], 'no-cache');
        requests.push(url);
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        const parsed = new URL(url);
        if (!url.includes('_history')) {
            assert.equal(parsed.searchParams.get('_summary'), 'count');
            assert.equal(parsed.searchParams.has('_elements'), false);
            assert.equal(parsed.searchParams.get('_total'), 'accurate');
        }
        return { ok: true, json: async () => ({ resourceType: 'Bundle', total: url.includes('/Observation?') ? 4010 : 0 }) };
    } });
    assert.equal(state.currentResourceCount, 4010);
    assert.equal(maximum, 3);
    assert.equal(state.diagnostics.requests, MANAGED_CLINICAL_RESOURCE_TYPES.length + 1);
    assert.ok(state.diagnostics.responseBytes > 0);
});

test('private exact paging works when pinned HAPI rejects summaries and explicit totals', async () => {
    const requests = [];
    const state = await readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async url => {
        const parsed = new URL(url);
        requests.push(parsed);
        // Match both observed HAPI-2037/2038 search-policy rejections.
        if (parsed.searchParams.has('_total') || parsed.searchParams.has('_summary')) return { ok: false, status: 400,
            json: async () => ({ resourceType: 'OperationOutcome', issue: [{
                severity: 'error', code: 'processing', diagnostics: 'HAPI-2037: _total=accurate is not permitted on this server'
            }] }) };
        if (!parsed.pathname.endsWith('/DocumentReference')) return { ok: true,
            json: async () => ({ resourceType: 'Bundle', total: 0 }) };
        if (parsed.searchParams.has('page')) return { ok: true,
            json: async () => ({ resourceType: 'Bundle', entry: [{ resource: { id: 'third' } }] }) };
        assert.equal(parsed.searchParams.get('_elements'), 'id');
        return { ok: true, json: async () => ({ resourceType: 'Bundle',
            entry: [{ resource: { id: 'first' } }, { resource: { id: 'second' } }],
            link: [{ relation: 'next', url: 'http://private/fhir/DocumentReference?_elements=id&page=2' }] }) };
    } });
    assert.equal(state.currentResourceCount, 3);
    assert.equal(state.counts.DocumentReference, 3);
    const aggregateProbes = requests.filter(url => url.searchParams.has('_summary'));
    assert.ok(aggregateProbes.length >= 1 && aggregateProbes.length <= 3);
    assert.ok(requests.some(url => url.searchParams.has('page')));
    assert.ok(requests.some(url => url.searchParams.get('_elements') === 'id'));
});

test('malformed aggregate totals and unrelated failures never become zero or trigger paging', async () => {
    for (const body of [
        { resourceType: 'Bundle' },
        { resourceType: 'Bundle', total: -1 },
        { resourceType: 'Bundle', total: 1.5 },
        { resourceType: 'Bundle', total: '0' },
        { resourceType: 'OperationOutcome', total: 0 },
        { resourceType: 'OperationOutcome', issue: {} }
    ]) {
        const calls = [];
        await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async url => {
            calls.push(url); return { ok: true, status: 200, json: async () => body };
        } }), /exact count response is invalid/);
        assert.ok(calls.every(url => url.includes('_summary=count&_total=accurate')));
    }
    for (const status of [400, 401, 403, 500, 503]) {
        const calls = [];
        await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async url => {
            calls.push(url); return { ok: false, status, json: async () => ({ resourceType: 'OperationOutcome',
                issue: [{ diagnostics: 'Unrelated server error' }] }) };
        } }), new RegExp(`HTTP ${status}`));
        assert.ok(calls.every(url => url.includes('_summary=count&_total=accurate')));
    }
});

test('private count partial errors and deadlines are unavailable rather than zero', async () => {
    await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async url => ({
        ok: !url.includes('/Observation?'), status: 503,
        json: async () => ({ resourceType: url.includes('/Observation?') ? 'OperationOutcome' : 'Bundle', total: 0 })
    }) }), /count failed for Observation/);
    await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', timeoutMs: 5,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }) }), /deadline exceeded/);
});

/** Control the shared deadline on the shipped Node 24 runtime and other supported hosts. */
function mockCountClock(t) {
    let now = 0;
    const timers = new Map();
    t.mock.method(Date, 'now', () => now);
    t.mock.method(global, 'setTimeout', (callback, milliseconds) => {
        const id = {}; timers.set(id, { callback, at: now + milliseconds }); return id;
    });
    t.mock.method(global, 'clearTimeout', id => timers.delete(id));
    return { tick(milliseconds) {
        now += milliseconds;
        for (const [id, timer] of timers) {
            if (timer.at <= now) { timers.delete(id); timer.callback(); }
        }
    } };
}

test('default count and history deadline permits a 174-second read', async t => {
    const clock = mockCountClock(t);
    let first = true;
    const state = await readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async url => {
        if (first) { first = false; clock.tick(61000); }
        if (new URL(url).pathname === '/fhir/_history') clock.tick(113000);
        return { ok: true, json: async () => ({ resourceType: 'Bundle', total: url.includes('/Observation?') ? 4010 : 0 }) };
    } });
    assert.equal(state.currentResourceCount, 4010);
    assert.equal(state.hasHistory, false);
    assert.equal(state.diagnostics.elapsedMs, 174000);
});

test('default deadline cancels all pending counts at 175 seconds and preserves its reason', async t => {
    const clock = mockCountClock(t);
    const signals = [];
    const pending = readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async (_url, { signal }) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener('abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true }));
    } });
    const rejected = assert.rejects(pending, /count\/history deadline exceeded after 175000 ms/);
    clock.tick(174999);
    assert.equal(signals.length, 3);
    assert.ok(signals.every(signal => !signal.aborted));
    clock.tick(1);
    await rejected;
    assert.ok(signals.every(signal => signal.aborted));
});

test('the shared deadline includes history body decoding after counts complete', async t => {
    const clock = mockCountClock(t);
    let reachedHistory;
    const historyStarted = new Promise(resolve => { reachedHistory = resolve; });
    const pending = readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async (url, { signal }) => ({
        ok: true,
        json: async () => {
            if (!url.includes('/_history?')) return { resourceType: 'Bundle', total: 0 };
            reachedHistory();
            return new Promise((_resolve, reject) => signal.addEventListener('abort',
                () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true }));
        }
    }) });
    const rejected = assert.rejects(pending, /count\/history deadline exceeded after 175000 ms/);
    await historyStarted;
    clock.tick(175000);
    await rejected;
});

test('private counts preserve caller cancellation and reject invalid deadlines', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Count request disconnected'));
    await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', signal: controller.signal,
        fetchImpl: async () => { assert.fail('Cancelled requests must not reach HAPI'); } }), /Count request disconnected/);
    for (const timeoutMs of [0, -1, 1.5, NaN]) {
        await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', timeoutMs }), /positive integer/);
    }
});

test('ID-only counts without totals reject repeated pages', async () => {
    const calls = [];
    await assert.rejects(readPrivateDataState({ endpoint: 'http://private/fhir', fetchImpl: async url => {
        calls.push(url);
        if (url.includes('_summary=count')) return { ok: false, status: 400, json: async () => ({
            resourceType: 'OperationOutcome', issue: [{ diagnostics: 'HAPI-2038: _summary=count is not permitted on this server' }]
        }) };
        if (!url.includes('/DocumentReference?')) return { ok: true, json: async () => ({ resourceType: 'Bundle', total: 0 }) };
        return { ok: true, json: async () => ({ resourceType: 'Bundle', entry: [{}],
            link: [{ relation: 'next', url: 'http://private/fhir/DocumentReference?page=2' }] }) };
    } }), /repeated a page/);
    assert.ok(calls.some(url => url.includes('DocumentReference?_elements=id')));
});

test('configured target source rejects a different valid bundle before mutation', () => {
    assert.equal(inspectTransactionBundle(sample(), { expectedSource: 'hospital-a' }).source, 'hospital-a');
    assert.throws(() => inspectTransactionBundle(sample(), { expectedSource: 'hospital-b' }), /expected source hospital-b, received hospital-a/);
});

/** Explicit smaller limits still enforce exact byte and entry boundaries. */
test('shared HMO limits retain per-team byte and entry overrides', () => {
    const { DEFAULT_LIMITS } = require('../transaction-bundle');
    assert.deepEqual(DEFAULT_LIMITS, { maxBytes: 805306368, maxEntries: 200000 });
    const buffer = sample();
    assert.equal(inspectTransactionBundle(buffer, { limits: { maxBytes: buffer.length, maxEntries: 2 } }).entries, 2);
    assert.throws(() => inspectTransactionBundle(buffer, { limits: { maxBytes: buffer.length - 1 } }), /MB \(\d+ bytes\)/);
    assert.throws(() => inspectTransactionBundle(buffer, { limits: { maxEntries: 1 } }), /maxEntries 1/);
});

/** Exercise the former byte and resource ceilings with valid synthetic content. */
test('default validation accepts bundles above the former 64 MiB and 20000-entry limits', () => {
    const padded = Buffer.alloc(64 * 1048576 + 1, ' ');
    sample().copy(padded);
    assert.equal(inspectTransactionBundle(padded).entries, 2);
    const template = JSON.parse(sample()).entry[0];
    const entry = Array.from({ length: 20001 }, (_, index) => ({
        ...template,
        fullUrl: `urn:uuid:00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        resource: resource('Patient', `p${index}`)
    }));
    assert.equal(inspectTransactionBundle(Buffer.from(JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry }))).entries, 20001);
});

test('complete-history origin preserves deleted-only versions and malformed history stays unavailable', async () => {
    const state = await readPrivateDataState({ endpoint:'http://private/fhir', fetchImpl:async url => {
        const parsed = new URL(url);
        // Reproduce the native server: implicit system history is empty, while
        // the explicit full-history request includes a deleted-only resource.
        return {ok:true,status:200,json:async()=>({resourceType:'Bundle',
            total:parsed.pathname==='/fhir/_history' && parsed.searchParams.get('_since')==='0001-01-01T00:00:00Z'?1:0})};
    } });
    assert.equal(state.currentResourceCount,0); assert.equal(state.hasHistory,true);
    await assert.rejects(readPrivateDataState({endpoint:'http://private/fhir',fetchImpl:async url=>({ok:true,status:200,
        json:async()=>new URL(url).pathname==='/fhir/_history'?{resourceType:'Bundle',total:'0'}:{resourceType:'Bundle',total:0}})}), /history probe.*malformed/);
});

test('shared import enforcer rejects nonfinite, unsafe and fractional ceilings before parsing', () => {
    for (const field of ['maxBytes', 'maxEntries']) for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
        assert.throws(() => inspectTransactionBundle(sample(), { limits: { [field]: value } }), /safe integer/);
    }
    const raw = sample();
    assert.equal(inspectTransactionBundle(raw, { limits: { maxBytes:raw.length, maxEntries:2 } }).bytes, raw.length);
    assert.throws(() => inspectTransactionBundle(raw, { limits: { maxBytes:raw.length-1, maxEntries:2 } }), /maxBytes/);
    assert.throws(() => inspectTransactionBundle(raw, { limits: { maxBytes:raw.length, maxEntries:1 } }), /maxEntries/);
});
