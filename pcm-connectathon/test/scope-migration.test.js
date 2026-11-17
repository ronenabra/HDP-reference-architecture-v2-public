'use strict';

/** Disposable scope cutover uses the existing checkpoint owner, stopped publication and rollback fence. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const migration = require('../scripts/pcm-ig-041-migration');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const { VERSIONS } = require('../../src/shared/scope-model-versions');
const { REQUIRED_AUTHORIZATION_CONTROLS } = require('../../src/shared/conformance-policy');
const { clinicalTokenFixture } = require('../../test-support/clinical-token-fixture');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const { treeHashes, beforeId, afterId } = require('./pcm-ig-041-migration-fixture');
const read = file => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, checkpoint.encode(value));

/** Produce old inputs explicitly in an owned copy; acknowledge only the actual preview inventory. */
function fixture(t, { legacy = true, preset = 'connectathon-easy', variants = false } = {}) {
    const f = clinicalTokenFixture({ mode: 'one-time' });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-scope-migration-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateDirectory = path.join(directory, 'state'), configPath = path.join(directory, 'team-config.json'), reviewPath = path.join(directory, 'review.json');
    fs.mkdirSync(stateDirectory);
    const selected = require('../../test-support/team-config').buildTeamConfig({}, preset);
    for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) f.config[key] = selected[key];
    f.config.runtime.stateDir = stateDirectory;
    if (legacy) {
        f.config.configVersion = 'pcm-team-config/4'; f.config.conformance.policyVersion = 'pcm-sandbox-policy/3';
        for (const key of REQUIRED_AUTHORIZATION_CONTROLS) f.config.securitySimulation.global[key] = preset === 'strict';
        f.config.securitySimulation.perSource['ho-a'] = { history: false, smartScopes: true };
        f.config.sandbox.grantFullClinicalAccess = true; f.config.security.dsFhirServer.enforceMappedPatients = false;
    }
    if (variants) {
        const expired = f.approve(undefined, f.scope, { approvedEnd: new Date((require('../../test-support/data-grants').NOW + 86400) * 1000).toISOString() });
        const revoked = f.approve();
        f.store.update({ ...revoked, status: 'inactive' });
        const removed = f.approve(); removed.provision.actor = removed.provision.actor.filter(actor => !actor.role?.coding?.some(code => code.code === 'CST'));
        f.store.update(removed);
        for (const origin of ['generated', 'manual']) {
            const legacyRecord = structuredClone(f.store.get('Consent', 'consent-test'));
            legacyRecord.id = 'legacy-' + origin; legacyRecord.identifier[0].value = 'LEGACY-' + origin;
            legacyRecord.extension.push({ url: require('../../src/shared/pcm-contract').SANDBOX_EXTENSIONS.approvedTokenScope,
                valueString: origin === 'manual' ? 'patient/Observation.s?date=ge2000-01-01' : 'patient/Observation.rs' });
            f.store.data.Consent.set(legacyRecord.id, legacyRecord); // Explicit offline legacy migration corpus, never a current public write.
        }
        const V = require('../../test-support/clinical-token-fixture').V;
        const unsupported = f.approve(undefined, `patient/Patient.rs?${V} patient/DocumentReference.s?${V}`);
        f.variantIds = { expired: expired.id, revoked: revoked.id, removed: removed.id, unsupported: unsupported.id };
    }
    save(configPath, f.config);
    for (const namespace of ['first-use-windows', 'access-tokens', 'assertion-replay', 'oauth-authorization', 'source-presence']) {
        fs.mkdirSync(path.join(stateDirectory, namespace));
        save(path.join(stateDirectory, namespace, 'retained.json'), namespace === 'first-use-windows'
            ? { startedAt: 1700000000, expiresAt: 1700003600 } : { consumed: true, scope: 'old token is only evidence of itself' });
    }
    checkpoint.prepare({ store: f.store, configPath, stateDirectory, runtimeId: beforeId });
    const review = { schema: 'pcm-scope-migration-review/1', runtime: { before: beforeId, after: afterId },
        restartAll: true, asOf: '2026-11-08T00:00:00.000Z', versions: VERSIONS, ...(legacy ? {} : { beforeVersions: VERSIONS }),
        artifacts: { pcm: afterId, doctor: afterId, adapter: afterId, hapi: beforeId } };
    save(reviewPath, review);
    const options = { configPath, stateDirectory, reviewPath, workersStopped: true, stoppedAt: new Date(Date.now() - 60000).toISOString() };
    const preview = migration.plan(options);
    review.records = preview.requiredReview; review.retiredControls = preview.retiredControls; save(reviewPath, review);
    return { ...f, directory, review, options, root: path.join(stateDirectory, 'pcm-ig-041') };
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
    test(`scope preview/apply ${preset}: exact approvals, legacy/generated/manual inputs, deadlines and state preserved`, t => {
        const f = fixture(t, { preset }), original = checkpoint.snapshot(f.store, { privateState: true }), before = treeHashes(f.directory);
        const plan = migration.plan(f.options);
        assert.deepEqual(plan.errors, []); assert.deepEqual(treeHashes(f.directory), before);
        assert.ok(plan.inventory.some(item => item.classification === 'renewed-approval'));
        assert.ok(plan.inventory.some(item => item.key === `Consent/${f.consent.id}` && item.classification === 'lossless'));
        assert.ok(plan.inventory.some(item => item.key.startsWith('first-use-windows/') && /Never rename/.test(item.consequence)));
        assert.deepEqual(plan.inventory.filter(item => item.key.startsWith('Consent/')).map(item => item.after), original.Consent);
        const applied = migration.apply({ ...f.options, expectedDigest: plan.digest }); assert.equal(applied.status, 'applied');
        assert.deepEqual(read(path.join(f.root, 'checkpoint.json')), original);
        assert.equal(read(f.options.configPath).configVersion, 'pcm-team-config/5');
        for (const namespace of ['first-use-windows', 'assertion-replay']) assert.equal(treeHashes(f.directory)[`state/${namespace}/retained.json`], before[`state/${namespace}/retained.json`]);
        for (const namespace of ['access-tokens', 'oauth-authorization', 'source-presence']) assert.equal(fs.existsSync(path.join(f.options.stateDirectory, namespace)), false);
        const index = read(path.join(applied.backupDirectory, 'index.json'));
        for (const file of index.files) assert.equal(checkpoint.sha256(fs.readFileSync(file.backup)), file.beforeHash);
        assert.equal(migration.apply({ ...f.options, expectedDigest: plan.digest }).status, 'no-further-work');
        const restored = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: afterId, store: restored });
        assert.deepEqual(checkpoint.snapshot(restored, { privateState: true }), original);
        assert.throws(() => checkpoint.restore({ ...f.options, runtimeId: beforeId, store: new FHIRStore() }), /runtime mismatch/);
    });
}

test('missing/forged reviews, inferred approvals and mixed versions never publish', t => {
    for (const mutate of [review => { delete review.records; }, review => { review.records[0].classification = 'inferred'; },
        review => { review.versions = { ...VERSIONS, token: 'pcm-data-grant/5' }; }, review => { review.artifacts.adapter = 'latest'; },
        review => { review.restartAll = false; }, review => { review.retiredControls = []; }, review => { review.beforeVersions = VERSIONS; }, review => { review.artifacts.unreviewed = afterId; }]) {
        const f = fixture(t); mutate(f.review); save(f.options.reviewPath, f.review);
        const before = treeHashes(f.directory), plan = migration.plan(f.options);
        assert.ok(plan.errors.length); assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest }), /Unresolved/);
        assert.deepEqual(treeHashes(f.directory), before);
    }
});

test('partial publication blocks restart, recovers, and detects conflicts without losing original backups', t => {
    const f = fixture(t), plan = migration.plan(f.options);
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest, failAfter: 1 }), /interrupted/);
    assert.throws(() => checkpoint.restore({ ...f.options, runtimeId: afterId, store: new FHIRStore() }), /incomplete/);
    const bytes = fs.readFileSync(f.options.configPath); fs.appendFileSync(f.options.configPath, '\n');
    assert.throws(() => migration.recover(f.options.stateDirectory, { workersStopped: true }), /Recovery conflict/);
    fs.writeFileSync(f.options.configPath, bytes);
    assert.equal(migration.recover(f.options.stateDirectory, { workersStopped: true }).status, 'applied');
    assert.equal(migration.apply({ ...f.options, expectedDigest: plan.digest }).status, 'no-further-work');
});

test('rollback refuses obsolete authority; safe compatible artifact rollback preserves all usage bytes', t => {
    for (const legacy of [true, false]) {
        const f = fixture(t, { legacy }), plan = migration.plan(f.options);
        migration.apply({ ...f.options, expectedDigest: plan.digest });
        const store = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: afterId, store });
        checkpoint.prepare({ ...f.options, runtimeId: afterId, store });
        const usage = fs.readFileSync(path.join(f.options.stateDirectory, 'first-use-windows', 'retained.json'));
        if (legacy) {
            assert.throws(() => migration.rollback(f.options), /UNSAFE RESTORE.*incompatible scope/);
            assert.equal(migration.resumeCurrent(f.options).status, 'resumed-current');
        } else assert.equal(migration.rollback(f.options).status, 'rolled-back');
        assert.deepEqual(fs.readFileSync(path.join(f.options.stateDirectory, 'first-use-windows', 'retained.json')), usage);
    }
});

test('post-backup source removal, cancellation, new decision and policy restriction cannot be rolled back', t => {
    for (const mutate of [store => { const value = store.get('Consent', 'clinical-new-1'); value.status = 'inactive'; store.update(value); },
        store => { const value = store.get('Consent', 'clinical-new-1'); value.provision.actor = value.provision.actor.filter(actor => !actor.role?.coding?.some(code => code.code === 'CST')); store.update(value); },
        store => { const value = store.get('HealthcareService', store.getAll('HealthcareService')[0].id); value.active = false; store.update(value); }]) {
        const f = fixture(t, { legacy: false }), plan = migration.plan(f.options);
        migration.apply({ ...f.options, expectedDigest: plan.digest });
        const store = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: afterId, store }); mutate(store);
        checkpoint.prepare({ ...f.options, runtimeId: afterId, store });
        assert.throws(() => migration.rollback(f.options), /UNSAFE RESTORE/);
        assert.equal(migration.resumeCurrent(f.options).status, 'resumed-current');
    }
});


test('old generated/manual/missing approval records, expired/revoked decisions and removed sources never become renewed authority', t => {
    const f = fixture(t, { variants: true }), before = checkpoint.snapshot(f.store, { privateState: true }), plan = migration.plan(f.options);
    assert.deepEqual(plan.errors, []);
    for (const id of ['consent-test', 'legacy-generated', 'legacy-manual']) {
        const entry = plan.inventory.find(item => item.key === 'Consent/' + id);
        assert.equal(entry.classification, 'renewed-approval'); assert.match(entry.eligibility.after, /unusable/);
        assert.deepEqual(entry.before, entry.after);
    }
    assert.match(plan.inventory.find(item => item.key === 'Consent/' + f.variantIds.expired).eligibility.after, /outside unchanged/);
    assert.match(plan.inventory.find(item => item.key === 'Consent/' + f.variantIds.revoked).eligibility.after, /non-active/);
    migration.apply({ ...f.options, expectedDigest: plan.digest });
    assert.deepEqual(read(path.join(f.root, 'checkpoint.json')), before);
    const store = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: afterId, store });
    const { resolveGrant } = require('../../src/pcm-core/src/data-grant');
    for (const id of ['consent-test', 'legacy-generated', 'legacy-manual', ...Object.values(f.variantIds)]) {
        const consent = store.get('Consent', id);
        assert.throws(() => resolveGrant({ ...f.request, store, now: Date.parse(f.review.asOf) / 1000,
            requested: require('../../test-support/data-grants').rar('Consent', consent.identifier[0].value) }));
    }
});

test('partial recovery refuses changed/deleted consumed usage bytes and never replaces them with backup values', t => {
    const f = fixture(t), plan = migration.plan(f.options);
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest, failAfter: 1 }), /interrupted/);
    const file = path.join(f.options.stateDirectory, 'first-use-windows', 'retained.json'), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n');
    assert.throws(() => migration.recover(f.options.stateDirectory, { workersStopped: true }), /preserved usage/);
    assert.notDeepEqual(fs.readFileSync(file), original);
    fs.writeFileSync(file, original); assert.equal(migration.recover(f.options.stateDirectory, { workersStopped: true }).status, 'applied');
});


test('actual --scope-model CLI previews without cert fallback, applies only reviewed digest and rejects a mixed persisted boundary', t => {
    const f = fixture(t), before = treeHashes(f.directory), { spawnSync } = require('node:child_process');
    const args = ['pcm-connectathon/scripts/migrate-team-config.js', '--scope-model', '--config', f.options.configPath, '--state', f.options.stateDirectory, '--review', f.options.reviewPath];
    const preview = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr); assert.deepEqual(treeHashes(f.directory), before);
    const parsed = JSON.parse(preview.stdout); assert.equal(parsed.schema, 'pcm-scope-migration-plan/1'); assert.equal(parsed.publications, undefined);
    const applied = spawnSync(process.execPath, [...args, '--apply', '--expected-digest', parsed.digest, '--workers-stopped', '--stopped-at', f.options.stoppedAt], { encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).status, 'applied');
    const bootScript = "require('./src/pcm-core/src/bootstrap')().then(() => console.log(JSON.stringify(require('./src/pcm-core/src/fhir/store').getAll('Consent')))).catch(error => { console.error(error.message); process.exitCode = 1; })";
    const bootEnvironment = { ...process.env, TEAM_CONFIG_PATH: f.options.configPath, STATE_DIR: f.options.stateDirectory,
        LOG_DIR: path.join(f.directory, 'logs'), PCM_MIGRATION_RUNTIME_ID: afterId };
    const reboot = spawnSync(process.execPath, ['-e', bootScript], { encoding: 'utf8', env: bootEnvironment });
    assert.equal(reboot.status, 1, 'scope-only migration cannot adopt incompatible public/private metadata');
    assert.match(reboot.stderr, /Retained active Consent lacks compatible private authority/);
    assert.deepEqual(read(path.join(f.root, 'checkpoint.json')), checkpoint.snapshot(f.store, { privateState: true }), 'refused startup never converts retained authority');
    const manifestPath = path.join(f.root, 'manifest.json'), manifest = read(manifestPath);
    manifest.scopeBoundary.versions.localToken = 'pcm-ds-local-token/4'; save(manifestPath, manifest);
    const store = new FHIRStore(); assert.throws(() => checkpoint.restore({ ...f.options, runtimeId: afterId, store }), /Mixed scope versions/);
    assert.equal(store.getAll('Consent').length, 0);
    const incompatibleBoot = spawnSync(process.execPath, ['-e', bootScript], { encoding: 'utf8', env: bootEnvironment });
    assert.notEqual(incompatibleBoot.status, 0); assert.match(incompatibleBoot.stderr, /Mixed scope versions/);
});
