'use strict';
/** Actual unbridged historical-memory reconciliation and candidate restart on disposable synthetic state. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), { fork } = require('child_process');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const handoff = require('../scripts/reconcile-pcm-handoff');
const helpers = require('./pcm-ig-041-runtime');

/** Test-only memory oracle/fixture mutation via parent IPC; no runtime route or inspector is added. */
async function child() {
    const root = process.env.PCM04108_RUNTIME_ROOT;
    await require(path.join(root, 'src/pcm-core/src/bootstrap'))();
    const store = require(path.join(root, 'src/pcm-core/src/fhir/store'));
    const policy = store.get('Contract', 'policy-presence'); policy.status = 'revoked'; policy.issued = '2025-01-01T00:00:00Z'; store.update(policy);
    store.add({ resourceType: 'Consent', id: 'live-only-consent', status: 'inactive', extension: [{ url: 'urn:synthetic:decision', valueString: 'live-revocation-never-seeded' }] });
    // A hidden non-authorizing resource proves that filtered reads cannot stand in for complete inventory.
    const hidden = store.get('HealthcareService', require(path.join(root, 'src/pcm-core/src/team-config')).loadTeamConfig().service.id);
    hidden.id = 'hidden-terminal-service'; hidden.active = false; hidden.identifier[0].value = 'SYNTHETIC-ARCHIVED-HIDDEN-SERVICE';
    hidden.meta.tag.push({ system: 'urn:pcm:sandbox:patient-sampler', code: 'archived' }); store.add(hidden);
    const { createApiApp } = require(path.join(root, 'src/pcm-core/src/index'));
    const api = require('https').createServer({ cert: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.crt')), key: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.key')) }, createApiApp());
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    process.send({ api: api.address().port, inventory: checkpoint.snapshot(store), pid: process.pid });
    process.on('message', async message => { if (message === 'stop') { await new Promise(resolve => api.close(resolve)); process.exit(0); } });
}

/** Run only this component's first boundary; other 08 runtime rows remain separately retained evidence. */
async function main() {
    const artifacts = JSON.parse(fs.readFileSync(process.env.PCM04108_ARTIFACTS)), { fixture, treeHashes } = require('./pcm-ig-041-migration-fixture');
    const migration = require('../scripts/pcm-ig-041-migration'), f = fixture(null, { preset: 'connectathon-balanced' });
    let original, bridge, candidate;
    const rows = [], record = row => { rows.push(row); console.log(JSON.stringify(row)); };
    try {
        const { config, certRoot } = helpers.prepareFixture(f, artifacts);
        // The disposable PCM owner uses an actual EC fixture certificate, supported by historical ES256.
        for (const [source, target] of [['presence-orchestrator-assertion.crt', 'pcm-core.crt'], ['presence-orchestrator-assertion.key', 'pcm-core.key']]) fs.copyFileSync(path.join(certRoot, source), path.join(f.options.certsDirectory, target));
        fs.rmSync(f.root, { recursive: true }); // Actual historical bootstrap starts unbridged; there is no manufactured handoff.
        const beforeReservations = Object.fromEntries(['assertion-replay', 'first-use-windows'].map(name => [name, handoff.tree(path.join(f.options.stateDirectory, name))]));
        original = fork(__filename, ['--child'], { silent: true, env: { ...process.env, PCM04108_RUNTIME_ROOT: artifacts.before.root,
            TEAM_CONFIG_PATH: f.options.configPath, STATE_DIR: f.options.stateDirectory, CERTS_DIR: f.options.certsDirectory,
            LOG_DIR: path.join(f.directory, 'logs'), SHARED_LOGS_DIR: path.join(f.directory, 'logs') } });
        let output = ''; original.stdout.on('data', value => { output += value; }); original.stderr.on('data', value => { output += value; });
        const live = await new Promise((resolve, reject) => { original.once('message', resolve); original.once('exit', code => reject(new Error(`Unbridged process exited ${code}: ${output.slice(-2000)}`))); });
        assert.equal(fs.existsSync(f.root), false);
        const issued = await helpers.token(live, config, config.organizations.pcm.clientId, path.join(certRoot, 'presence-orchestrator-assertion.key'), { legacy: true });
        assert.equal(issued.status, 200, issued.text);
        const tokenFile = path.join(f.directory, 'private-management-token'); fs.writeFileSync(tokenFile, issued.json.access_token, { mode: 0o600 });
        const descriptorFile = path.join(f.directory, 'historical-artifact.json'); fs.writeFileSync(descriptorFile, checkpoint.encode(artifacts.before));
        const spec = { schema: 'pcm-handoff-observation/1', ...f.options, runtimeId: artifacts.before.id, runtimeDescriptor: descriptorFile, bridgeRoot: '/workspace',
            apiBase: `https://127.0.0.1:${live.api}/api/fhir-service/r4`, caFile: path.join(certRoot, 'rootCA.crt'), tokenFile,
            writersIsolatedAt: new Date().toISOString(), isolationEvidence: 'Disposable: loopback-only listener, no UI listener, no adapters/workers, only parent management GETs; test-only mutation finished before ready', processIdentity: `container-disposable-pid:${live.pid}` };
        record({ name: 'genuine-unbridged-memory-before-handoff', noManifest: true, revoked: live.inventory.Contract.find(row => row.id === 'policy-presence').status, liveConsent: live.inventory.Consent.find(row => row.id === 'live-only-consent'), runtimeId: artifacts.before.id });
        await new Promise(resolve => setTimeout(resolve, 31050));
        const observation = await handoff.observe(spec);
        assert.equal(observation.visible.HealthcareService.some(row => row.id === 'hidden-terminal-service'), false);
        const resources = live.inventory;
        // The independent input is the test owner oracle's exact live memory, never buildSeedResources/config/defaults.
        const hiddenResources = Object.entries(resources).flatMap(([type, values]) => values.filter(value => !observation.visible[type].some(row => row.id === value.id)).map(value => ({ identity: `${type}/${value.id}`, hash: handoff.hash(value), provenance: 'Independent test owner IPC exact pre-observation live-memory oracle; no production extraction endpoint' })));
        const review = { schema: 'pcm-handoff-review/1', approved: true, reviewedBy: 'disposable-test-independent-inventory-review', reviewedAt: new Date().toISOString(),
            observationHash: handoff.hash(observation), inventoryHash: handoff.hash(resources), completeFiveTypeInventory: true, noSeedReconstruction: true,
            inventoryProvenance: 'Independent fixture owner exact live memory oracle via test-only IPC; no historical seed/config reconstruction', processIdentity: spec.processIdentity, isolationMaintainedUntilStopped: true, hiddenResources };
        const stopped = new Promise(resolve => original.once('exit', resolve)); original.send('stop'); await stopped; original = null;
        const stoppedAt = new Date().toISOString(); await new Promise(resolve => setTimeout(resolve, 31050));
        const beforeImport = treeHashes(f.directory);
        assert.throws(() => handoff.importHandoff(spec, observation, resources, { ...review, approved: false }, { workersStopped: true, stoppedAt }), /approval/);
        assert.deepEqual(treeHashes(f.directory), beforeImport);
        const imported = handoff.importHandoff(spec, observation, resources, review, { workersStopped: true, stoppedAt });
        record({ name: 'reviewed-reconciliation-import', visibleCounts: Object.fromEntries(Object.entries(observation.visible).map(([type, values]) => [type, values.length])), fullCounts: Object.fromEntries(Object.entries(resources).map(([type, values]) => [type, values.length])), hiddenResources, checkpointHash: imported.checkpointHash, reviewHash: imported.handoff.reviewHash, stoppedAt });
        bridge = await helpers.start(f, artifacts.before.root, artifacts.before.id, true);
        const restored = JSON.parse(fs.readFileSync(path.join(f.root, 'checkpoint.json'))); assert.deepEqual(restored, resources);
        assert.equal((await helpers.request(bridge.ui, '/admin/migration/checkpoint', { plain: true, admin: true, body: {} })).status, 200);
        await bridge.stop(); bridge = null;
        const beforePreview = treeHashes(f.directory), preview = migration.plan(f.options);
        assert.deepEqual(preview.errors, []); assert.deepEqual(treeHashes(f.directory), beforePreview);
        record({ name: 'bridged-restart-exact-live-decisions-preserved', checkpointHash: checkpoint.sha256(checkpoint.encode(restored)),
            liveConsentExact: handoff.hash(restored.Consent.find(row => row.id === 'live-only-consent')) === handoff.hash(resources.Consent.find(row => row.id === 'live-only-consent')) });
        const applyStoppedAt = new Date().toISOString(); await new Promise(resolve => setTimeout(resolve, 31050));
        const applied = migration.apply({ ...f.options, stoppedAt: applyStoppedAt, expectedDigest: preview.digest }); assert.equal(applied.status, 'applied');
        candidate = await helpers.start(f, artifacts.after.root, artifacts.after.id, false);
        const migrated = JSON.parse(fs.readFileSync(path.join(f.root, 'checkpoint.json')));
        assert.equal(migrated.Contract.find(row => row.id === 'policy-presence').status, 'revoked');
        assert.deepEqual(migrated.Consent, resources.Consent);
        assert.deepEqual(migrated.HealthcareService.find(row => row.id === 'hidden-terminal-service'), resources.HealthcareService.find(row => row.id === 'hidden-terminal-service'));
        const backup = JSON.parse(fs.readFileSync(path.join(applied.backupDirectory, 'index.json')));
        record({ name: 'candidate-preview-apply-restart-preserves-live-revocation-consent-and-hidden-terminal-state', digest: preview.digest,
            backup: backup.files.map(row => ({ file: path.basename(row.file), beforeHash: row.beforeHash, verified: checkpoint.sha256(fs.readFileSync(row.backup)) === row.beforeHash })),
            configHash: checkpoint.sha256(fs.readFileSync(f.options.configPath)), checkpointHash: checkpoint.sha256(checkpoint.encode(migrated)), runtimeId: artifacts.after.id });
        await candidate.stop(); candidate = null;
        for (const [namespace, records] of Object.entries(beforeReservations)) for (const [file, digest] of Object.entries(records)) assert.equal(handoff.tree(path.join(f.options.stateDirectory, namespace))[file], digest);
        fs.writeFileSync(process.env.PCM04108_RESULT, checkpoint.encode({ status: 'passed', artifacts, rows, limitation: 'Independent inventory comes from the test owner memory oracle, not filtered reads; real operators need separately reviewed authoritative records or must refuse replacement.' }));
    } finally { original?.kill('SIGKILL'); bridge?.processChild.kill('SIGKILL'); candidate?.processChild.kill('SIGKILL'); fs.rmSync(f.directory, { recursive: true, force: true }); }
}
if (require.main === module) (process.argv.includes('--child') ? child() : main()).catch(error => { console.error(error.stack); process.exitCode = 1; });
