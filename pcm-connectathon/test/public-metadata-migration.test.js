'use strict';

/** Opted-in disposable metadata cutover, exact authority/usage and guarded offline recovery. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const migration = require('../scripts/pcm-ig-041-migration');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const { hash } = require('../../src/shared/migration-hash');
const { artifacts } = require('../../src/shared/public-metadata-compatibility');
const { VERSIONS } = require('../../src/shared/scope-model-versions');
const { clinicalTokenFixture } = require('../../test-support/clinical-token-fixture');
const { treeHashes } = require('./pcm-ig-041-migration-fixture');
const { certificates } = require('../../test-support/certificates');
const publicFHIR = require('../../src/pcm-core/src/public-fhir');
const save = (file, value) => fs.writeFileSync(file, checkpoint.encode(value));
const read = file => JSON.parse(fs.readFileSync(file));
const repositoryRoot = path.resolve(__dirname, '../..');

/** Persist only actual fixture/recovery bindings for the optional private qualification receipt. */
function recoveryEvidence(value) {
    if (process.env.PCM_METADATA_RECOVERY_OUTPUT) fs.appendFileSync(process.env.PCM_METADATA_RECOVERY_OUTPUT, JSON.stringify({ schema: 'pcm-metadata-offline-recovery/1', ...value }) + '\n');
}

/** Explicitly acknowledge a fresh hash-only inventory; no implementation/runtime grants are inferred. */
function review(f) {
    const observed = migration.plan(f.options);
    Object.assign(f.review, { records: observed.requiredReview, components: observed.measuredComponents, bindings: observed.measuredBindings });
    f.review.runtime.after = observed.measuredComponents.pcm;
    save(f.options.reviewPath, f.review);
    return migration.plan(f.options);
}

/** Create retained-like state through real current producers, optionally serialize exact legacy copies offline. */
function fixture(t, { legacy = false, preset = 'connectathon-easy' } = {}) {
    const f = clinicalTokenFixture({ mode: 'one-time' });
    f.store.data.Consent = new Map([[f.consent.id, f.consent]]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-metadata-07-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateDirectory = path.join(directory, 'state'), configPath = path.join(directory, 'team.json'), reviewPath = path.join(directory, 'review.json');
    fs.mkdirSync(stateDirectory);
    const selected = require('../../test-support/team-config').buildTeamConfig({}, preset);
    for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) f.config[key] = selected[key];
    if (preset === 'connectathon-balanced') f.config.security.pcmApi.allowServiceProviderOwnTokenIntrospection = false;
    f.config.runtime.stateDir = stateDirectory;
    const certsDirectory = path.join(directory, 'certs'); fs.cpSync(certificates(), certsDirectory, { recursive: true });
    f.config.runtime.certsDir = certsDirectory;
    // Retained local catalog is an independent owner; no definitions are regenerated from it.
    f.config.serviceCatalog = { ...f.config.serviceCatalog, file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: f.config.service.id, instanceIdentifier: 'PCM-HS-INST-0001' }] };
    fs.mkdirSync(path.join(directory, 'config'));
    save(path.join(directory, 'config/demo-services.json'), require('../../config/demo-services.json'));
    f.config.sandboxSampling = { sourceIds: ['ho-a'] };
    f.config.systemAuthorization.clientEntitlements[f.config.organizations.serviceProvider.clientId] = ['sandbox-patient-sample'];
    for (const resource of require('../../src/pcm-core/src/fhir/sampling-policy').samplingResourceDrafts(f.config)) publicFHIR.publishNewResource(f.store, resource);
    save(configPath, f.config);
    for (const namespace of ['first-use-windows', 'assertion-replay', 'data-operations']) fs.mkdirSync(path.join(stateDirectory, namespace));
    save(path.join(stateDirectory, 'first-use-windows', hash('original-opaque-key') + '.json'), { startedAt: 1700000000, expiresAt: 1700003600 });
    save(path.join(stateDirectory, 'assertion-replay', 'consumed.json'), { consumedAt: 1700000000 });
    save(path.join(stateDirectory, 'data-operations', 'completed.json'), { id: 'old-import', phase: 'succeeded' });
    const ordinary = f.store.get('Consent', f.consent.id);
    ordinary.extension.push({ url: 'urn:third-party:ordinary', extension: [{ url: 'label', valueString: 'Retained ordinary field' }] });
    f.store.update(ordinary); f.consent = f.store.get('Consent', f.consent.id);
    f.store.authorityState.generations.set('source:original-revoked', 7);
    const runtimeId = artifacts(repositoryRoot).pcm;
    checkpoint.prepare({ store: f.store, configPath, stateDirectory, runtimeId });
    const root = path.join(stateDirectory, 'pcm-ig-041');
    if (legacy) {
        const original = checkpoint.snapshot(f.store, { privateState: true });
        const approval = original._private.approvals[`Consent/${f.consent.id}`].snapshot;
        original.Consent[0].extension.push({ url: require('../../src/shared/consent-scope-snapshot').URL, valueString: JSON.stringify(approval) },
            { url: require('../../src/shared/pcm-contract').SANDBOX_EXTENSIONS.approvedTokenScope, valueString: approval.scope },
            { url: require('../../src/shared/pcm-contract').SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, valueString: `${approval.origin}: ${approval.choice}` });
        for (const service of original.HealthcareService) {
            const result = f.store.privateRecords.services.getDefinition(service.id);
            if (result.status === 'ok') service.extension.push({ url: require('../../src/shared/service-grant').URL, valueString: JSON.stringify(result.grant) });
        }
        for (const [type, values] of Object.entries(original).filter(([key]) => key !== '_private')) for (const value of values) {
            const provisioning = f.store.privateRecords.provisioning.get(type, value.id);
            if (provisioning?.seedTags?.length) (value.meta.tag ||= []).push(...structuredClone(provisioning.seedTags));
            if (provisioning?.bookkeeping?.length) (value.extension ||= []).push(...structuredClone(provisioning.bookkeeping));
        }
        for (const table of require('../../src/pcm-core/src/private-records').TABLES) original._private[table] = {};
        const bytes = checkpoint.encode(original); fs.writeFileSync(path.join(root, 'checkpoint.json'), bytes);
        const manifest = read(path.join(root, 'manifest.json')); manifest.checkpointHash = checkpoint.sha256(bytes); save(path.join(root, 'manifest.json'), manifest);
    }
    const options = { configPath, stateDirectory, reviewPath, certsDirectory, workersStopped: true, stoppedAt: new Date(Date.now() - 60000).toISOString() };
    const result = { ...f, directory, root, options, review: { schema: 'pcm-public-metadata-review/1', optIn: true, restartAll: true, action: 'relocate',
        repositoryRoot, runtime: { before: runtimeId, after: runtimeId }, privateSchema: 'pcm-private-state/1', publicProjectionSchema: publicFHIR.SCHEMA, scopeVersions: VERSIONS } };
    save(reviewPath, result.review); review(result);
    return result;
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
    test(`${preset}: clean preview/apply, complete private backup and separate-process restart preserve authority and clocks`, t => {
        const f = fixture(t, { preset }), before = treeHashes(f.directory), plan = migration.plan(f.options);
        assert.deepEqual(plan.errors, []);
        assert.deepEqual(treeHashes(f.directory), before);
        assert.ok(plan.inventory.every(item => item.outcome === 'unchanged'));
        const original = read(path.join(f.root, 'checkpoint.json'));
        const result = migration.apply({ ...f.options, expectedDigest: plan.digest });
        assert.equal(result.status, 'applied');
        assert.equal(checkpoint.sha256(fs.readFileSync(f.options.configPath)), plan.compatibility.bindings.config);
        const backup = read(path.join(result.backupDirectory, 'private-checkpoint.json'));
        assert.deepEqual(backup.state, original);
        require('../../src/pcm-core/src/private-checkpoint').validateCandidate(backup, plan.compatibility);
        const restarted = new FHIRStore(); checkpoint.restore({ ...f.options, store: restarted, runtimeId: plan.runtime.after });
        assert.deepEqual(checkpoint.snapshot(restarted, { privateState: true }), original);
        assert.equal(restarted.authorityState.generations.get('source:original-revoked'), 7);
        const sampling = require('../../src/pcm-core/src/fhir/sampling-policy');
        const contract = restarted.getAll('Contract').find(sampling.isSamplingPolicy);
        const validated = sampling.validateSamplingPolicy(restarted, contract, f.config.organizations.pcm.id);
        assert.ok(validated.clients.includes(f.config.organizations.serviceProvider.clientId));
        assert.equal(Boolean(sampling.evaluateSamplingPolicy({ store: restarted, config: f.config, contract, clientId: f.config.organizations.serviceProvider.clientId,
            targetOrganizationId: f.config.healthOrganizations[0].dataSourceOrganization.id, now: Math.floor(Date.now() / 1000) })), preset !== 'strict');
        for (const [file, digest] of Object.entries(before).filter(([file]) => /first-use-windows|assertion-replay|data-operations/.test(file))) assert.equal(treeHashes(f.directory)[file], digest);
        const child = require('node:child_process').spawnSync(process.execPath, ['-e', `const c=require('./src/pcm-core/src/migration-checkpoint');const {FHIRStore}=require('./src/pcm-core/src/fhir/store');const s=new FHIRStore();c.restore({...JSON.parse(process.argv[1]),store:s});process.stdout.write(JSON.stringify(c.snapshot(s,{privateState:true})));`, JSON.stringify({ ...f.options, runtimeId: plan.runtime.after })], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), original);
        assert.equal(migration.apply({ ...f.options, expectedDigest: plan.digest }).status, 'no-further-work');
    });
}

test('unambiguous legacy relocation preserves IDs/public facts/exact grant, generation tombstones and nested ordinary extensions', t => {
    const f = fixture(t, { legacy: true }), plan = migration.plan(f.options);
    assert.deepEqual(plan.errors, []);
    assert.ok(plan.inventory.some(item => item.outcome === 'changed'));
    const before = read(path.join(f.root, 'checkpoint.json'));
    migration.apply({ ...f.options, expectedDigest: plan.digest });
    const after = read(path.join(f.root, 'checkpoint.json'));
    assert.deepEqual(after._private.authority, before._private.authority);
    for (const [type, values] of Object.entries(after).filter(([key]) => key !== '_private')) for (const value of values) {
        publicFHIR.assertPublic(value); const old = before[type].find(item => item.id === value.id);
        assert.deepEqual(value.identifier, old.identifier); assert.deepEqual(value.meta.versionId, old.meta.versionId);
    }
    assert.deepEqual(after._private.approvals[`Consent/${f.consent.id}`].snapshot, f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot);
    const samplerOwner = new FHIRStore(); checkpoint.hydrate(samplerOwner, after);
    const sampling = require('../../src/pcm-core/src/fhir/sampling-policy');
    sampling.validateSamplingPolicy(samplerOwner, samplerOwner.getAll('Contract').find(sampling.isSamplingPolicy), f.config.organizations.pcm.id);
    const backupIndex = read(path.join(f.root, `backup-${plan.digest}`, 'index.json'));
    const raw = backupIndex.files.find(item => item.file.endsWith('checkpoint.json'));
    assert.deepEqual(read(raw.backup), before);
});

test('ambiguous/missing/nested legacy authority, audit and trust conflicts reject without changing any input', t => {
    for (const mutate of [
        state => { state.Consent[0].extension.push(structuredClone(state.Consent[0].extension.find(item => item.url === require('../../src/shared/consent-scope-snapshot').URL))); },
        state => { state.Consent[0].extension = state.Consent[0].extension.filter(item => item.url !== require('../../src/shared/consent-scope-snapshot').URL); },
        state => { delete state._private; },
        state => { (state.Consent[0].meta.tag ||= []).push({ system: 'urn:pcm:sandbox:consent-cancellation', display: '{broken' }); },
        state => { state.Consent[0].extension.push({ url: 'urn:ordinary', valueString: JSON.stringify({ authoring: { secret: 'never-public' } }) }); },
        state => { state.Endpoint[0].extension.push({ url: require('../../src/shared/pcm-contract').EXTENSIONS.dataSourceServerTrust, extension: [{ url: 'mode', valueCode: 'insecure-skip-verify' }] }); }
    ]) {
        const f = fixture(t, { legacy: true }), state = read(path.join(f.root, 'checkpoint.json')); mutate(state);
        save(path.join(f.root, 'checkpoint.json'), state); const manifest = read(path.join(f.root, 'manifest.json'));
        manifest.checkpointHash = checkpoint.sha256(fs.readFileSync(path.join(f.root, 'checkpoint.json'))); save(path.join(f.root, 'manifest.json'), manifest);
        const plan = review(f), before = treeHashes(f.directory);
        assert.ok(plan.errors.length); assert.ok(plan.inventory.every(item => item.outcome === 'rejected'));
        if (plan.errors.some(error => error.includes('audit is unrecorded'))) assert.ok(plan.errors.some(error => error.includes(`Consent/${f.consent.id}`)));
        assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest }), /Unresolved/);
        assert.deepEqual(treeHashes(f.directory), before);
    }
});

test('stale component/binding/version/record reviews and incomplete certificate inventory stop before publication', t => {
    for (const mutate of [
        f => { f.review.components.native = 'sha256:' + '0'.repeat(64); },
        f => { f.review.scopeVersions = { ...VERSIONS, token: 'obsolete' }; },
        f => { f.review.records[0].version = 'stale'; },
        f => { f.review.bindings.firstUse = '0'.repeat(64); },
        f => { f.review.optIn = false; },
        f => { fs.rmSync(path.join(f.options.certsDirectory, 'rootCA.crt')); },
        f => { const file = path.join(f.root, 'checkpoint.json'); fs.renameSync(file, file + '.original'); fs.symlinkSync(file + '.original', file); }
    ]) {
        const f = fixture(t); mutate(f); save(f.options.reviewPath, f.review);
        const plan = migration.plan(f.options), before = treeHashes(f.directory);
        assert.ok(plan.errors.length); assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest }), /Unresolved/);
        assert.deepEqual(treeHashes(f.directory), before);
    }
    const f = fixture(t), plan = migration.plan(f.options);
    save(path.join(f.options.stateDirectory, 'first-use-windows', 'new-key.json'), { startedAt: 1 });
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest }), /Stale preview/);
});

test('interrupted publication fences restart and verifies all source/usage/operation/certificate inputs before recovery', t => {
    const f = fixture(t, { legacy: true }), plan = migration.plan(f.options);
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: plan.digest, failAfter: 1 }), /interrupted/);
    assert.throws(() => checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: new FHIRStore() }), /incomplete/);
    const additional = path.join(f.options.stateDirectory, 'first-use-windows', 'unexpected.json'); save(additional, { consumed: true });
    assert.throws(() => migration.recover(f.options.stateDirectory, { workersStopped: true }), /Recovery conflict/);
    fs.rmSync(additional);
    const journal = read(path.join(f.root, 'journal.json')), envelopePath = journal.manifest.privateBackup;
    const envelopeBytes = fs.readFileSync(envelopePath); fs.appendFileSync(envelopePath, '\n');
    assert.throws(() => migration.recover(f.options.stateDirectory, { workersStopped: true }), /private backup/);
    fs.writeFileSync(envelopePath, envelopeBytes);
    const material = path.join(f.options.certsDirectory, 'rootCA.crt'), original = fs.readFileSync(material); fs.appendFileSync(material, '\n');
    assert.throws(() => migration.recover(f.options.stateDirectory, { workersStopped: true }), /Recovery conflict/);
    fs.writeFileSync(material, original);
    assert.equal(migration.recover(f.options.stateDirectory, { workersStopped: true }).status, 'applied');
    checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: new FHIRStore() });
    recoveryEvidence({ scenario: 'interrupted-apply-roll-forward', fixture: f.directory, digest: plan.digest, compatibility: plan.compatibility,
        manifest: read(path.join(f.root, 'manifest.json')), backupIndexHash: checkpoint.sha256(fs.readFileSync(path.join(journal.backupDirectory, 'index.json'))),
        originalStateFiles: plan.preservedStateFiles, afterStateFiles: Object.fromEntries(Object.keys(plan.preservedStateFiles).map(file => [file, checkpoint.sha256(fs.readFileSync(file))])),
        enforcedRefusals: ['restart-before-recovery', 'unexpected-usage-membership', 'changed-private-envelope', 'changed-certificate'] });
});

test('coordinated compatible restore succeeds; later cancellation/source/generation changes prevent revoked rollback', t => {
    for (const variant of ['cancellation', 'source-removal', 'generation']) {
        const f = fixture(t), plan = migration.plan(f.options), result = migration.apply({ ...f.options, expectedDigest: plan.digest });
        const restored = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: restored });
        checkpoint.prepare({ ...f.options, runtimeId: plan.runtime.after, store: restored });
        assert.throws(() => migration.rollback(f.options), /Metadata rollback requires/);
        const backupPath = path.join(result.backupDirectory, 'private-checkpoint.json');
        Object.assign(f.review, { action: 'restore', backupPath, reviewedBackupHash: read(backupPath).hash });
        let restorePlan = review(f); assert.deepEqual(restorePlan.errors, []);
        const successfulRestoreDigest = restorePlan.digest;
        migration.apply({ ...f.options, expectedDigest: restorePlan.digest });
        const current = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: current });
        if (variant === 'cancellation') current.update({ ...current.get('Consent', f.consent.id), status: 'inactive' });
        else if (variant === 'generation') current.authorityState.generations.set('source:original-revoked', 8);
        else {
            const resource = current.get('Consent', f.consent.id);
            resource.provision.actor = resource.provision.actor.filter(actor => !actor.role?.coding?.some(code => code.code === 'CST'));
            current.update(resource);
        }
        const restricted = checkpoint.snapshot(current, { privateState: true });
        checkpoint.prepare({ ...f.options, runtimeId: plan.runtime.after, store: current });
        restorePlan = review(f); assert.ok(restorePlan.errors.some(error => /Unsafe restore|revocation|lineage|revision/.test(error)));
        assert.throws(() => migration.apply({ ...f.options, expectedDigest: restorePlan.digest }), /Unresolved/);
        assert.equal(migration.resumeCurrent({ ...f.options }).status, 'resumed-current');
        const final = new FHIRStore(); checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: final });
        assert.deepEqual(checkpoint.snapshot(final, { privateState: true }), restricted);
        recoveryEvidence({ scenario: 'compatible-restore-and-revoked-rollback-refusal', variant, fixture: f.directory,
            appliedDigest: plan.digest, successfulRestoreDigest, rejectedPreviewDigest: restorePlan.digest, backupHash: read(backupPath).hash,
            compatibility: plan.compatibility, currentRestrictionsHash: hash(restricted), resumedRestrictionsHash: hash(checkpoint.snapshot(final, { privateState: true })),
            rejectedErrors: restorePlan.errors, outcome: 'resumed-current-with-restrictions' });
    }
});


test('restart rejects every mismatched component/schema and lost original first-use bytes; CLI preview/status reveal no snapshots', t => {
    const f = fixture(t), plan = migration.plan(f.options);
    const cli = require('node:child_process').spawnSync(process.execPath, ['pcm-connectathon/scripts/migrate-team-config.js', '--public-metadata', '--config', f.options.configPath,
        '--state', f.options.stateDirectory, '--certs', f.options.certsDirectory, '--review', f.options.reviewPath], { cwd: repositoryRoot, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); const preview = JSON.parse(cli.stdout);
    assert.equal(preview.digest, plan.digest); assert.equal(Object.hasOwn(preview, 'publications'), false);
    assert.doesNotMatch(cli.stdout, /BEGIN PRIVATE|"snapshot":|"authoring":|"startedAt":|"expiresAt":/);
    migration.apply({ ...f.options, expectedDigest: plan.digest });
    const manifestPath = path.join(f.root, 'manifest.json'), original = read(manifestPath);
    for (const component of Object.keys(plan.measuredComponents)) {
        const altered = structuredClone(original); altered.metadataBoundary.components[component] = 'sha256:' + '0'.repeat(64); save(manifestPath, altered);
        assert.throws(() => checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: new FHIRStore() }), /component\/schema mismatch/);
    }
    save(manifestPath, original);
    const usage = Object.keys(plan.preservedStateFiles).find(file => file.includes('first-use-windows'));
    fs.rmSync(usage);
    assert.throws(() => checkpoint.restore({ ...f.options, runtimeId: plan.runtime.after, store: new FHIRStore() }), /first-use bytes/);
    const status = checkpoint.observedStatus(f.options.stateDirectory);
    assert.equal(status.phase, 'applied'); assert.equal(status.summary.rejected, 0);
    save(path.join(f.root, 'journal.json'), {}); assert.match(checkpoint.observedStatus(f.options.stateDirectory).phase, /Interrupted publication/);
    fs.writeFileSync(manifestPath, '{broken'); assert.match(checkpoint.observedStatus(f.options.stateDirectory).phase, /Unreadable checkpoint/);
});
