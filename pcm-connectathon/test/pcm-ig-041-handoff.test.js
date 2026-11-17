'use strict';
/** Focused first-handoff refusal, provenance, exact-decision and no-seed regressions. */
const test = require('node:test'), assert = require('assert/strict'), fs = require('fs'), path = require('path');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const handoff = require('../scripts/reconcile-pcm-handoff');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const { fixture, treeHashes, beforeId } = require('./pcm-ig-041-migration-fixture');

/** A complete independent synthetic inventory with a revoked source grant and live-only decision. */
function setup(t) {
    const f = fixture(t), resources = checkpoint.snapshot(f.store);
    resources.Contract[0].status = 'revoked'; resources.Contract[0].issued = '2022-01-01T00:00:00Z';
    resources.Consent.push({ resourceType: 'Consent', id: 'live-only', status: 'inactive', meta: { versionId: '7', lastUpdated: '2024-01-01T00:00:00Z' } });
    fs.rmSync(f.root, { recursive: true }); fs.rmSync(path.join(f.options.stateDirectory, 'pcm-ig-041-maintenance'));
    const artifact = { files: {}, bridgeSourceFiles: {}, sourceCommit: 'test-only-independent-runtime' }, id = `sha256:${handoff.hash(artifact)}`;
    const descriptor = path.join(f.directory, 'runtime.json'); fs.writeFileSync(descriptor, checkpoint.encode({ id, root: f.directory, artifact }));
    const spec = { schema: 'pcm-handoff-observation/1', ...f.options, runtimeId: id, runtimeDescriptor: descriptor, apiBase: 'https://pcm.test/api/fhir-service/r4',
        writersIsolatedAt: '2020-01-01T00:00:00Z', isolationEvidence: 'test isolated process and stopped workers', processIdentity: 'test-original-pid' };
    const observation = { schema: 'pcm-visible-observation/1', observedAt: '2020-01-01T00:01:00Z', processIdentity: spec.processIdentity, bindings: handoff.bindings(spec), visible: structuredClone(resources) };
    const review = { schema: 'pcm-handoff-review/1', approved: true, reviewedBy: 'synthetic-independent-reviewer', reviewedAt: '2020-01-02T00:00:00Z', observationHash: handoff.hash(observation), inventoryHash: handoff.hash(resources),
        completeFiveTypeInventory: true, noSeedReconstruction: true, inventoryProvenance: 'Synthetic authoritative owner records; never seeds', processIdentity: spec.processIdentity, isolationMaintainedUntilStopped: true, hiddenResources: [] };
    return { f, spec, observation, resources, review, stopped: { workersStopped: true, stoppedAt: '2020-01-01T00:02:00Z' } };
}

for (const kind of ['missing', 'malformed', 'partial', 'bad-hash', 'unapproved']) test(`retained bridge refuses ${kind} handoff without seeds or writes`, t => {
    const { f, spec } = setup(t);
    if (kind !== 'missing') {
        fs.mkdirSync(f.root);
        const resources = { Organization: [] };
        fs.writeFileSync(path.join(f.root, 'checkpoint.json'), checkpoint.encode(resources));
        fs.writeFileSync(path.join(f.root, 'manifest.json'), kind === 'malformed' ? '{' : checkpoint.encode({ schema: 'pcm-migration/1', phase: 'rolled-back', runtimeId: spec.runtimeId,
            configHash: checkpoint.sha256(fs.readFileSync(spec.configPath)), checkpointHash: kind === 'bad-hash' ? 'bad' : checkpoint.sha256(checkpoint.encode(resources)), ...(kind === 'unapproved' ? { handoff: {} } : {}) }));
    }
    const before = treeHashes(f.directory), env = { ...process.env };
    Object.assign(process.env, { STATE_DIR: spec.stateDirectory, TEAM_CONFIG_PATH: spec.configPath, PCM_MIGRATION_RUNTIME_ID: spec.runtimeId });
    try { assert.throws(() => require('../../src/pcm-core/src/migration-legacy-bridge').install(f.directory)); }
    finally { process.env = env; }
    assert.deepEqual(treeHashes(f.directory), before);
});

test('ordinary fresh startup restore returns false; explicit migration requires authority', t => {
    const { spec } = setup(t), store = new FHIRStore();
    assert.equal(checkpoint.restore({ ...spec, runtimeId: undefined, store }), false);
    assert.throws(() => checkpoint.restore({ ...spec, store }), /handoff missing/);
    assert.throws(() => checkpoint.restore({ ...spec, store, required: true }), /handoff missing/);
    assert.deepEqual(checkpoint.snapshot(store), Object.fromEntries(Object.keys(store.data).map(type => [type, []])));
});

test('approved import preserves revoked/terminal decisions and exact versions/history/reservations', t => {
    const { f, spec, observation, resources, review, stopped } = setup(t), before = handoff.bindings(spec);
    handoff.importHandoff(spec, observation, resources, review, stopped);
    const store = new FHIRStore(); checkpoint.restore({ ...spec, store, required: true });
    assert.deepEqual(checkpoint.snapshot(store), resources);
    assert.equal(store.get('Contract', resources.Contract[0].id).status, 'revoked');
    for (const [namespace, values] of Object.entries(before.reservations)) assert.deepEqual(handoff.tree(path.join(f.options.stateDirectory, namespace)), values);
    fs.writeFileSync(path.join(f.root, 'handoff-review.json'), checkpoint.encode({ ...review, approved: false }));
    assert.throws(() => checkpoint.restore({ ...spec, store: new FHIRStore(), required: true }), /Unapproved/);
});

for (const fault of ['unapproved', 'partial', 'changed-live', 'hidden-without-provenance', 'reservation-drift', 'config-drift', 'runtime-drift', 'writers-not-stopped']) test(`reconciliation refuses ${fault} without publication`, t => {
    const { f, spec, observation, resources, review, stopped } = setup(t);
    if (fault === 'unapproved') review.approved = false;
    if (fault === 'partial') { delete resources.Endpoint; review.inventoryHash = handoff.hash(resources); }
    if (fault === 'changed-live') { resources.Contract[0].status = 'policy'; review.inventoryHash = handoff.hash(resources); }
    if (fault === 'hidden-without-provenance') { observation.visible.Consent.pop(); review.observationHash = handoff.hash(observation); }
    if (fault === 'reservation-drift') fs.writeFileSync(path.join(spec.stateDirectory, 'first-use-windows/later.json'), '{}');
    if (fault === 'config-drift') fs.appendFileSync(spec.configPath, '\n');
    if (fault === 'runtime-drift') spec.runtimeId = beforeId;
    if (fault === 'writers-not-stopped') stopped.workersStopped = false;
    const before = treeHashes(f.directory);
    assert.throws(() => handoff.importHandoff(spec, observation, resources, review, stopped)); assert.deepEqual(treeHashes(f.directory), before);
});

test('repeated authenticated reads reject drift and incomplete pagination', async t => {
    const { spec, resources } = setup(t); let calls = 0;
    const get = async (_spec, url) => { const type = url.split('/').pop(); calls++; return { resourceType: 'Bundle', type: 'searchset', total: resources[type].length, entry: resources[type].map(resource => ({ resource, search: { mode: 'match' } })) }; };
    const observed = await handoff.observe(spec, get); assert.deepEqual(observed.visible, Object.fromEntries(Object.entries(resources).map(([type, rows]) => [type, [...rows].sort((a, b) => a.id.localeCompare(b.id))]))); assert.equal(calls, 10);
    await assert.rejects(handoff.observe(spec, async (s, url) => { const bundle = await get(s, url); if (calls > 15 && url.endsWith('Consent')) bundle.entry[0].resource = { ...bundle.entry[0].resource, status: 'active' }; return bundle; }), /changed/);
    await assert.rejects(handoff.visible(spec, async () => ({ resourceType: 'Bundle', type: 'searchset', total: 1, entry: [] })), /Incomplete/);
});

test('checkpoint/manifest publication gap fences memory and restart until exact reviewed recovery', t => {
    const { f, spec, observation, resources, review, stopped } = setup(t);
    handoff.importHandoff(spec, observation, resources, review, stopped);
    const store = new FHIRStore(); checkpoint.restore({ ...spec, store, required: true });
    const before = checkpoint.snapshot(store), original = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === path.join(f.root, 'manifest.json')) throw new Error('Injected manifest disk failure'); return original(from, to); };
    try { assert.throws(() => store.update({ ...store.get('Consent', 'live-only'), status: 'rejected' }), /publication uncertain/); }
    finally { fs.renameSync = original; }
    assert.deepEqual(checkpoint.snapshot(store), before);
    assert.throws(() => checkpoint.restore({ ...spec, store: new FHIRStore(), required: true }), /incomplete/);
    assert.throws(() => require('../../src/shared/migration-maintenance').assertAvailable(spec.stateDirectory), /maintenance/);
    const journal = JSON.parse(fs.readFileSync(path.join(f.root, 'checkpoint-mutation.json'))), digest = handoff.hash(journal), hashes = treeHashes(f.directory);
    assert.throws(() => handoff.recoverMutation({ ...spec, workersStopped: true, expectedDigest: 'unreviewed' }), /explicitly review/); assert.deepEqual(treeHashes(f.directory), hashes);
    handoff.recoverMutation({ ...spec, workersStopped: true, expectedDigest: digest });
    const restored = new FHIRStore(); checkpoint.restore({ ...spec, store: restored, required: true });
    assert.equal(restored.get('Consent', 'live-only').status, 'rejected');
});

test('reviewed hidden supplements preserve exact bytes; changed team catalog refuses import', t => {
    const { f, spec, observation, resources, review, stopped } = setup(t);
    const hidden = observation.visible.Consent.pop();
    review.observationHash = handoff.hash(observation);
    review.hiddenResources = [{ identity: `Consent/${hidden.id}`, hash: handoff.hash(hidden), provenance: 'Independent synthetic decision audit record' }];
    const config = JSON.parse(fs.readFileSync(spec.configPath)); config.serviceCatalog = { file: 'independent-catalog.json' };
    fs.writeFileSync(path.join(f.directory, 'independent-catalog.json'), '{}'); fs.writeFileSync(spec.configPath, checkpoint.encode(config));
    observation.bindings = handoff.bindings(spec); review.observationHash = handoff.hash(observation);
    fs.writeFileSync(path.join(f.directory, 'independent-catalog.json'), '{"changed":true}');
    const before = treeHashes(f.directory);
    assert.throws(() => handoff.importHandoff(spec, observation, resources, review, stopped), /mismatch/); assert.deepEqual(treeHashes(f.directory), before);
    fs.writeFileSync(path.join(f.directory, 'independent-catalog.json'), '{}');
    handoff.importHandoff(spec, observation, resources, review, stopped);
    const store = new FHIRStore(); checkpoint.restore({ ...spec, store, required: true }); assert.deepEqual(checkpoint.snapshot(store), resources);
});
