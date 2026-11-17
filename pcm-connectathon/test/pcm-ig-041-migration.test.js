'use strict';

/** Focused migration safety: fixtures, immutable backups, restart and later-restriction rollback guards. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { fixture, treeHashes, beforeId, afterId } = require('./pcm-ig-041-migration-fixture');
const migration = require('../scripts/pcm-ig-041-migration');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const { DataOperationRegistry } = require('../../src/pcm-core/src/data-operations');
const { buildEffectivePolicy } = require('../../src/shared/conformance-policy');
const read = file => JSON.parse(fs.readFileSync(file));
const save = (file, value) => fs.writeFileSync(file, checkpoint.encode(value));

/** Refresh test inputs through the same frozen checkpoint manifest, without invoking the migration. */
function alter(f, mutate) {
    const resources = read(path.join(f.root, 'checkpoint.json')); mutate(resources);
    const bytes = checkpoint.encode(resources); fs.writeFileSync(path.join(f.root, 'checkpoint.json'), bytes);
    const manifest = read(path.join(f.root, 'manifest.json')); manifest.checkpointHash = checkpoint.sha256(bytes); save(path.join(f.root, 'manifest.json'), manifest);
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) for (const environment of ['production', 'test']) {
    test(`preview/apply preserve ${preset}/${environment}, explicit limits, source/client and diagnostic policy`, t => {
        const f = fixture(t, { preset, environment, catalog: true });
        const before = treeHashes(f.directory), original = checkpoint.snapshot(f.store), originalConfig = fs.readFileSync(f.options.configPath);
        const preview = migration.plan(f.options);
        assert.deepEqual(preview.errors, []); assert.equal(preview.digest, migration.plan(f.options).digest);
        assert.deepEqual(treeHashes(f.directory), before);
        assert.equal(preview.retired.length, 3);
        const applied = migration.apply({ ...f.options, expectedDigest: preview.digest }); assert.equal(applied.status, 'applied');
        const config = read(f.options.configPath), next = read(path.join(f.root, 'checkpoint.json'));
        assert.equal(config.contract.pcmIgVersion, require('../../src/shared/pcm-contract').PCM_IG.version);
        for (const key of ['conformance', 'security', 'securitySimulation', 'healthOrganizations', 'legacyDataSource', 'sandbox', 'certificates', 'certificateRoles']) assert.deepEqual(config[key], f.config[key], key);
        assert.deepEqual({ ...config.contract, pcmIgVersion: f.config.contract.pcmIgVersion, pcmIgCommit: f.config.contract.pcmIgCommit }, f.config.contract);
        assert.deepEqual(buildEffectivePolicy(config, {}), buildEffectivePolicy(f.config, {}));
        assert.deepEqual(next.Consent, original.Consent);
        assert.deepEqual(next.HealthcareService, original.HealthcareService.filter(value => !preview.retired.includes(value.id)));
        assert.deepEqual(config.presence.sources, f.config.presence.sources); assert.equal(config.presence.batch.maxResponseBytes, 262144);
        assert.equal(treeHashes(f.directory)['clinical/Patient.json'], before['clinical/Patient.json']);
        assert.equal(treeHashes(f.directory)['state/data-operations/completed-import.json'], before['state/data-operations/completed-import.json']);
        for (const namespace of ['assertion-replay', 'first-use-windows']) assert.equal(treeHashes(f.directory)[`state/${namespace}/retained-reservation.json`], before[`state/${namespace}/retained-reservation.json`]);
        const index = read(path.join(applied.backupDirectory, 'index.json'));
        assert.deepEqual(fs.readFileSync(index.files.find(value => value.file === f.options.configPath).backup), originalConfig);
        assert.equal(migration.apply({ ...f.options, expectedDigest: preview.digest }).status, 'no-further-work');
        const store = new FHIRStore(); assert.ok(checkpoint.restore({ store, ...f.options, runtimeId: afterId }));
        assert.deepEqual(checkpoint.snapshot(store, { privateState: true }), next);
        assert.throws(() => checkpoint.restore({ store: new FHIRStore(), ...f.options, runtimeId: beforeId }), /runtime mismatch/);
    });
}

test('empty/partial HMO memberships remain finite; custom labelled sampling is preserved byte for byte', t => {
    for (const empty of [false, true]) {
        const f = fixture(t, { customSampling: true, empty }); const original = read(path.join(f.root, 'checkpoint.json'));
        const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []);
        migration.apply({ ...f.options, expectedDigest: preview.digest });
        const next = read(path.join(f.root, 'checkpoint.json'));
        assert.deepEqual(next.Contract.find(value => value.id === 'custom-sampling-policy'), original.Contract.find(value => value.id === 'custom-sampling-policy'));
        for (const value of next.Contract.filter(value => value.id !== 'custom-sampling-policy')) assert.equal(value.term[0].asset.length, empty ? 0 : 1);
    }
});

test('ongoing/expired/revoked/terminated grant dates and identity survive without renewal', t => {
    for (const status of ['policy', 'revoked', 'terminated', 'entered-in-error']) {
        const f = fixture(t); alter(f, resources => { for (const value of resources.Contract) { value.status = status; value.applies.end = '2025-12-31T23:59:59Z'; } });
        const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []);
        const before = read(path.join(f.root, 'checkpoint.json')); migration.apply({ ...f.options, expectedDigest: preview.digest });
        const after = read(path.join(f.root, 'checkpoint.json'));
        for (const value of before.Contract) {
            const converted = after.Contract.find(item => item.id === value.id);
            assert.deepEqual(converted.identifier, value.identifier); assert.deepEqual(converted.applies, value.applies); assert.equal(converted.issued, value.issued);
            assert.equal(converted.status, status === 'policy' ? 'executed' : status);
        }
    }
});

test('shared system service is retained only after scanning all remaining references', t => {
    const f = fixture(t); alter(f, resources => { resources.Consent[0].extension.push({ url: 'urn:historical-reference', valueReference: { reference: 'HealthcareService/system-service-presence' } }); });
    const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []); assert.deepEqual(preview.retainedShared, ['system-service-presence']);
    assert.equal(preview.retired.length, 2);
});

test('all unresolved unknown-client/recipient/source/time/local-grant mappings report before any write', t => {
    const f = fixture(t); const review = read(f.options.reviewPath);
    review.approvedKeys.push({ clientId: 'unknown-client', file: 'unknown.crt' });
    review.sourceMembership['policy-presence'] = ['not-enrolled']; delete review.sourceMembership['policy-dependent-discovery']; save(f.options.reviewPath, review);
    alter(f, resources => {
        resources.Contract[0].issued = 'invalid-time';
        resources.Contract[1].term[0].offer.party[0].reference.push({ reference: 'Organization/ambiguous' });
        resources.Contract.push({ resourceType: 'Contract', id: 'unknown-local-grant', status: 'policy' });
    });
    const before = treeHashes(f.directory), preview = migration.plan(f.options);
    assert.ok(preview.errors.some(value => value.includes('Unknown client')));
    assert.ok(preview.errors.some(value => value.includes('ineligible source')));
    assert.ok(preview.errors.some(value => value.includes('Unsupported legacy')));
    assert.ok(preview.errors.some(value => value.includes('Explicit reviewed source')));
    assert.ok(preview.errors.some(value => value.includes('Incompatible local')));
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: preview.digest }), /Unresolved migration/); assert.deepEqual(treeHashes(f.directory), before);
});

test('invalid timestamps, suspended services, public-key mismatch, collisions and ambiguous source lists fail closed', t => {
    const mutations = [
        f => alter(f, resources => { resources.Contract[0].applies.start = '2026-02-30T00:00:00Z'; }),
        f => alter(f, resources => { resources.HealthcareService.find(value => value.id === 'system-service-presence').active = false; }),
        f => { const review = read(f.options.reviewPath); review.approvedKeys[0].kid = 'guessed'; save(f.options.reviewPath, review); },
        f => alter(f, resources => { resources.HealthcareService[1].identifier = structuredClone(resources.HealthcareService[0].identifier); }),
        f => { const review = read(f.options.reviewPath); review.sourceMembership['policy-presence'].push(review.sourceMembership['policy-presence'][0]); save(f.options.reviewPath, review); }
    ];
    for (const mutate of mutations) { const f = fixture(t); mutate(f); const before = treeHashes(f.directory), preview = migration.plan(f.options); assert.ok(preview.errors.length); assert.deepEqual(treeHashes(f.directory), before); }
});

test('retained plural sensitivity and exact service type changes require explicit review; collisions remain errors', t => {
    const f = fixture(t, { catalog: true }); const catalogPath = path.join(f.directory, f.config.serviceCatalog.file), catalog = read(catalogPath);
    catalog.clinicalServices[0].buckets[0].taggedDetail = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'HIV' }; save(catalogPath, catalog);
    const review = read(f.options.reviewPath); review.catalogReconciliation = false; save(f.options.reviewPath, review);
    assert.ok(migration.plan(f.options).errors.some(value => value.includes('plural')));
    review.catalogReconciliation = true; save(f.options.reviewPath, review); assert.deepEqual(migration.plan(f.options).errors, []);
});

test('active, uncertain and initializing import/maintenance operations fence checkpoint/apply; finished ledger is untouched', t => {
    for (const operation of [{ phase: 'loading' }, { phase: 'failed', needsReconciliation: true }]) {
        const f = fixture(t); save(path.join(f.options.stateDirectory, 'data-operations', 'uncertain.json'), { id: 'uncertain', ...operation });
        assert.ok(migration.plan(f.options).errors.some(value => value.includes('active/uncertain')));
    }
    const f = fixture(t); fs.writeFileSync(path.join(f.options.stateDirectory, 'data-operations', 'lock-ho-a'), '');
    assert.ok(migration.plan(f.options).errors.some(value => value.includes('reservation')));
    const registry = new DataOperationRegistry({ directory: path.join(f.options.stateDirectory, 'data-operations') }); assert.throws(() => registry.create('ho-b', 'import'), /maintenance/);
});

test('stale preview/public material/ledger and missing stop/drain boundary never publish', t => {
    const f = fixture(t), preview = migration.plan(f.options), before = fs.readFileSync(f.options.configPath);
    assert.throws(() => migration.apply({ ...f.options, workersStopped: false, expectedDigest: preview.digest }), /workers-stopped/);
    assert.throws(() => migration.apply({ ...f.options, stoppedAt: new Date().toISOString(), expectedDigest: preview.digest }), /31 seconds/);
    fs.appendFileSync(f.options.reviewPath, '\n'); assert.throws(() => migration.apply({ ...f.options, expectedDigest: preview.digest }), /Stale/);
    assert.deepEqual(fs.readFileSync(f.options.configPath), before);
});

test('interrupted publication refuses startup and recovers atomically/idempotently without replay', t => {
    const f = fixture(t), preview = migration.plan(f.options);
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: preview.digest, failAfter: 1 }), /interrupted/);
    assert.throws(() => checkpoint.restore({ store: new FHIRStore(), ...f.options, runtimeId: afterId }), /incomplete/);
    assert.equal(migration.recover(f.options.stateDirectory, { workersStopped: true }).status, 'applied');
    assert.equal(migration.apply({ ...f.options, expectedDigest: preview.digest }).status, 'no-further-work');
    const index = read(path.join(read(path.join(f.root, 'manifest.json')).backupDirectory, 'index.json'));
    for (const value of index.files) assert.equal(checkpoint.sha256(fs.readFileSync(value.backup)), value.beforeHash);
});

test('rollback restores exact scoped config/policy while retaining newer Consent decisions and clearing live tokens', t => {
    const f = fixture(t), original = read(path.join(f.root, 'checkpoint.json')), originalConfig = fs.readFileSync(f.options.configPath), preview = migration.plan(f.options);
    migration.apply({ ...f.options, expectedDigest: preview.digest });
    const store = new FHIRStore(); checkpoint.restore({ store, ...f.options, runtimeId: afterId });
    const consent = store.get('Consent', 'retained-consent'); consent.extension.push({ url: 'urn:decision-after-cutover', valueString: 'retain' }); store.update(consent);
    fs.mkdirSync(path.join(f.options.stateDirectory, 'access-tokens')); fs.writeFileSync(path.join(f.options.stateDirectory, 'access-tokens', 'must-not-return'), 'synthetic-token');
    checkpoint.prepare({ store, ...f.options, runtimeId: afterId });
    assert.equal(migration.rollback(f.options).status, 'rolled-back');
    assert.deepEqual(fs.readFileSync(f.options.configPath), originalConfig);
    const restored = read(path.join(f.root, 'checkpoint.json')); assert.deepEqual(restored.Contract, original.Contract); assert.deepEqual(restored.HealthcareService, original.HealthcareService);
    assert.equal(restored.Consent[0].extension.at(-1).valueString, 'retain'); assert.equal(fs.existsSync(path.join(f.options.stateDirectory, 'access-tokens')), false);
    assert.ok(checkpoint.restore({ store: new FHIRStore(), ...f.options, runtimeId: beforeId }));
});

for (const restriction of ['revoke', 'remove-source', 'shorten-validity']) test(`post-apply ${restriction} survives restart and precisely blocks unsafe rollback`, t => {
    const f = fixture(t), preview = migration.plan(f.options); migration.apply({ ...f.options, expectedDigest: preview.digest });
    const store = new FHIRStore(); checkpoint.restore({ store, ...f.options, runtimeId: afterId });
    const contract = store.get('Contract', 'policy-presence');
    if (restriction === 'revoke') contract.status = 'revoked';
    if (restriction === 'remove-source') contract.term[0].asset = [];
    if (restriction === 'shorten-validity') contract.applies.end = '2026-10-01T00:00:00Z';
    store.update(contract);
    const restarted = new FHIRStore(); checkpoint.restore({ store: restarted, ...f.options, runtimeId: afterId }); assert.deepEqual(restarted.get('Contract', contract.id), store.get('Contract', contract.id));
    checkpoint.prepare({ store: restarted, ...f.options, runtimeId: afterId }); const before = treeHashes(f.directory);
    assert.throws(() => migration.rollback(f.options), /UNSAFE RESTORE.*--resume-current/); assert.deepEqual(treeHashes(f.directory), before);
    assert.equal(migration.resumeCurrent(f.options).runtimeId, afterId);
    const resumed = new FHIRStore(); checkpoint.restore({ store: resumed, ...f.options, runtimeId: afterId }); assert.deepEqual(resumed.get('Contract', contract.id), restarted.get('Contract', contract.id));
});

test('disk publication failure restores the store transaction and private authority state', t => {
    const f = fixture(t), preview = migration.plan(f.options); migration.apply({ ...f.options, expectedDigest: preview.digest });
    const store = new FHIRStore(); checkpoint.restore({ store, ...f.options, runtimeId: afterId }); const before = checkpoint.snapshot(store), epoch = store.authorityState.epoch;
    fs.renameSync(f.root, `${f.root}.offline`);
    assert.throws(() => store.transaction(() => { const value = store.get('Contract', 'policy-presence'); value.status = 'revoked'; store.update(value); }), /ENOENT/);
    assert.deepEqual(checkpoint.snapshot(store), before); assert.equal(store.authorityState.epoch, epoch);
});

test('retained transport/assertion overrides retain meaning; retired native authorization controls require scope migration', t => {
    const f = fixture(t, { preset: 'connectathon-balanced' }), config = read(f.options.configPath);
    config.securitySimulation.global.clientAssertionAudience = false;
    config.securitySimulation.perSource['ho-a'] = { clientAssertionReplay: false };
    save(f.options.configPath, config);
    const manifest = read(path.join(f.root, 'manifest.json')); manifest.configHash = checkpoint.sha256(fs.readFileSync(f.options.configPath)); save(path.join(f.root, 'manifest.json'), manifest);
    const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []); migration.apply({ ...f.options, expectedDigest: preview.digest });
    assert.deepEqual(read(f.options.configPath).securitySimulation, config.securitySimulation);
    assert.deepEqual(buildEffectivePolicy(read(f.options.configPath), {}), buildEffectivePolicy(config, {}));
});

test('typed local identity collisions report explicit resolution instead of collapsing namespaces', t => {
    const f = fixture(t), config = read(f.options.configPath);
    config.identityMapping ||= {};
    config.identityMapping.businessIdOverrides = { 'http://fhir.health.gov.il/identifier/il-national-id|000000018': 'Patient/collision', 'http://fhir.health.gov.il/identifier/pna-national-id|000000018': 'Patient/collision' };
    save(f.options.configPath, config); const preview = migration.plan(f.options);
    assert.ok(preview.errors.some(value => value.includes('Ambiguous patient mapping')));
});

test('retained resource plural tags and fixed service type reconcile only through explicit reviewed shapes', t => {
    const f = fixture(t);
    alter(f, resources => {
        const service = resources.HealthcareService[0]; service.type = [{ text: 'old ambiguous type' }];
        service.extension.find(value => value.url.endsWith('ext-information-bucket')).extension.push({ url: 'taggedDetail', valueCodeableConcept: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'HIV' }] } });
    });
    assert.ok(migration.plan(f.options).errors.some(value => value.includes('INFA type reconciliation')));
    const resources = read(path.join(f.root, 'checkpoint.json')), service = resources.HealthcareService[0], review = read(f.options.reviewPath);
    review.serviceTypes = [{ id: service.id, before: service.type, after: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA', display: 'information access' }] }] }]; save(f.options.reviewPath, review);
    const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []); migration.apply({ ...f.options, expectedDigest: preview.digest });
    const converted = read(path.join(f.root, 'checkpoint.json')).HealthcareService.find(value => value.id === service.id);
    assert.equal(converted.type[0].coding[0].code, 'INFA');
    assert.equal(converted.extension.find(value => value.url.endsWith('ext-information-bucket')).extension.at(-1).url, 'taggedDetails');
});

test('changed approved public bytes or newly reserved imports invalidate an already reviewed digest', t => {
    for (const target of ['public-key', 'ledger']) {
        const f = fixture(t), preview = migration.plan(f.options);
        if (target === 'public-key') fs.appendFileSync(path.join(f.options.certsDirectory, f.review.approvedKeys[0].file), '\n');
        else save(path.join(f.options.stateDirectory, 'data-operations', 'later.json'), { id: 'later', phase: 'queued' });
        assert.throws(() => migration.apply({ ...f.options, expectedDigest: preview.digest }), /Stale/);
    }
});

test('checkpoint mutex/maintenance reject uncertain configuration writers and delayed in-flight FHIR mutation', t => {
    const f = fixture(t), resources = checkpoint.snapshot(f.store);
    assert.throws(() => f.store.update({ ...f.store.get('Contract', 'policy-presence'), status: 'revoked' }), /maintenance/);
    assert.deepEqual(checkpoint.snapshot(f.store), resources);
    fs.mkdirSync(path.join(f.options.stateDirectory, 'configuration-mutation'));
    assert.ok(migration.plan(f.options).errors.some(value => value.includes('Configuration publication is active/uncertain')));
});

test('recovery refuses unknown partially edited bytes and keeps every entry point fenced', t => {
    const f = fixture(t), preview = migration.plan(f.options);
    assert.throws(() => migration.apply({ ...f.options, expectedDigest: preview.digest, failAfter: 1 }), /interrupted/);
    fs.appendFileSync(f.options.configPath, 'changed-outside-journal');
    assert.throws(() => migration.recover(f.options.stateDirectory, { workersStopped: true }), /Recovery conflict/);
    assert.throws(() => checkpoint.restore({ store: new FHIRStore(), ...f.options, runtimeId: afterId }), /incomplete/);
});

test('fresh process codecs reject old continuation signatures independently of token-file deletion', () => {
    const { SearchPageCodec } = require('../../src/pcm-core/src/fhir/search');
    const oldCodec = new SearchPageCodec(), newCodec = new SearchPageCodec();
    const token = oldCodec.encode({ offset: 1 }); assert.deepEqual(oldCodec.decode(token), { offset: 1 });
    assert.throws(() => newCodec.decode(token), /Invalid or expired/);
});
