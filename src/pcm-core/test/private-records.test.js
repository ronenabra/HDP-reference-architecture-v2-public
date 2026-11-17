'use strict';
/** Owner-private transactions, exact authority, extraction and recoverable checkpoint boundaries. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { clinicalTokenFixture } = require('../../../test-support/clinical-token-fixture');
const { FHIRStore } = require('../src/fhir/store');
const checkpoint = require('../src/migration-checkpoint');
const backup = require('../src/private-checkpoint');
const { exportState, publicBinding } = require('../src/private-records');
const { extractLegacy } = require('../src/private-record-extraction');
const { URL } = require('../../shared/consent-scope-snapshot');
const { SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const runtimeId = `sha256:${'a'.repeat(64)}`;
/** Use actual lifecycle-approved fixtures; typed registration is explicit and never startup conversion. */
function fixture() {
    const f = clinicalTokenFixture(); f.store.getConfigRevision = () => f.config.runtime.revision;
    const snapshot = f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot, owner = f.store.privateRecords;
    // Isolate the repository command under test after the real producer supplied its exact decision.
    delete f.store.privateState.approvals[`Consent/${f.consent.id}`];
    delete f.store.privateState.services[`HealthcareService/${snapshot.service.definitionId}`];
    const definition = f.store.get('HealthcareService', snapshot.service.definitionId);
    owner.services.createDefinition({ serviceId: definition.id, grant: snapshot.service.grant,
        expectedRevision: f.store.privateState.revision, expectedVersions: { [`HealthcareService/${definition.id}`]: definition.meta.versionId } });
    const command = () => ({ consentId: f.consent.id, snapshot, expectedRevision: f.store.privateState.revision,
        expectedVersions: { [`Consent/${f.consent.id}`]: f.store.get('Consent', f.consent.id).meta.versionId,
            [`HealthcareService/${snapshot.service.id}`]: snapshot.service.version, [`HealthcareService/${definition.id}`]: snapshot.service.definitionVersion } });
    return { ...f, snapshot, owner, definition, command };
}
/** Complete, explicitly bound migration candidate; hashes represent owned test inventories only. */
function compatibility() {
    return { privateSchema: 'pcm-private-state/1', publicProjectionSchema: 'pcm-public-fhir/1',
        components: Object.fromEntries(backup.COMPONENTS.map(name => [name, runtimeId])), scopeVersions: require('../../shared/scope-model-versions').VERSIONS,
        bindings: Object.fromEntries(backup.BINDINGS.map(name => [name, 'b'.repeat(64)])) };
}
/** Publish a disposable matching existing checkpoint/manifest without any retained state. */
function diskFixture(store) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-private-02-')), root = path.join(directory, 'pcm-ig-041');
    fs.mkdirSync(root); const configPath = path.join(directory, 'config.json'); fs.writeFileSync(configPath, '{}');
    const bytes = checkpoint.encode(checkpoint.snapshot(store, { privateState: true }));
    fs.writeFileSync(path.join(root, 'checkpoint.json'), bytes);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 'pcm-migration/1', phase: 'applied', runtimeId,
        configHash: checkpoint.sha256(fs.readFileSync(configPath)), checkpointHash: checkpoint.sha256(bytes) }));
    checkpoint.attach(store, directory);
    return { directory, root, configPath, stateDirectory: directory, runtimeId };
}

test('one atomic public/private decision commit preserves detached grant bytes and immutable definition history', () => {
    const f = fixture(), revision = f.store.privateState.revision;
    const decision = f.store.transaction(() => {
        const current = f.store.get('Consent', f.consent.id); current.text = { status: 'generated', div: '<div>Public description</div>' };
        const saved = f.store.update(current);
        f.owner.provisioning.put({ type: 'Consent', id: saved.id, value: { owner: 'owned-test', publication: saved.meta.versionId },
            expectedRevision: f.store.privateState.revision, expectedVersions: { [`Consent/${saved.id}`]: saved.meta.versionId } });
        return f.owner.approvals.createDecision(f.command());
    });
    assert.equal(f.store.privateState.revision, revision + 1);
    assert.equal(f.owner.provisioning.get('Consent', f.consent.id).owner, 'owned-test');
    assert.equal(decision.snapshot.scope, f.snapshot.scope); assert.equal(f.owner.approvals.getDecision(f.consent.id).status, 'ok');
    decision.snapshot.scope = 'forged'; assert.equal(f.owner.approvals.getDecision(f.consent.id).snapshot.scope, f.snapshot.scope);
    const definition = f.store.get('HealthcareService', f.definition.id); definition.name = 'Later template description'; f.store.update(definition);
    assert.equal(f.owner.services.getDefinition(f.snapshot.service.id).definitionVersion, f.definition.meta.versionId);
    assert.equal(f.owner.approvals.getDecision(f.consent.id).snapshot.scope, f.snapshot.scope);
    assert.throws(() => f.owner.services.createDefinition({ serviceId: definition.id, grant: f.snapshot.service.grant,
        expectedRevision: f.store.privateState.revision, expectedVersions: { [`HealthcareService/${definition.id}`]: f.definition.meta.versionId } }), /version changed/);
});

test('duplicate/concurrent reviews and stale public/private versions cannot approve twice', async () => {
    const f = fixture(), command = f.command();
    const results = await Promise.allSettled([Promise.resolve().then(() => f.owner.approvals.createDecision(command)), Promise.resolve().then(() => f.owner.approvals.createDecision(command))]);
    assert.deepEqual(results.map(value => value.status), ['fulfilled', 'rejected']);
    assert.throws(() => f.owner.approvals.createDecision(f.command()), /already/);
    assert.throws(() => f.store.transaction(() => {}, { expectedRevision: f.store.privateState.revision, expectedConfigRevision: 'changed' }), /config|Configuration/);
    const g = fixture(), stale = g.command(); g.store.update(g.store.get('Consent', g.consent.id)); stale.expectedRevision = g.store.privateState.revision;
    assert.throws(() => g.owner.approvals.createDecision(stale), /version changed/);
    const h = fixture(), before = checkpoint.snapshot(h.store, { privateState: true });
    const bad = h.command(); bad.snapshot = { ...bad.snapshot, scope: 'forged' };
    assert.throws(() => h.owner.approvals.createDecision(bad), /snapshot/);
    assert.deepEqual(checkpoint.snapshot(h.store, { privateState: true }), before);
});

test('partial coupled writes, private audit and generations roll back; async commands are refused before execution', () => {
    const f = fixture(), before = checkpoint.snapshot(f.store, { privateState: true }); let notified = false;
    assert.throws(() => f.store.transaction(() => {
        f.owner.approvals.createDecision(f.command());
        f.owner.lifecycle.command({ type: 'Consent', id: f.consent.id, resource: f.store.get('Consent', f.consent.id),
            expectedRevision: f.store.privateState.revision, expectedVersions: { [`Consent/${f.consent.id}`]: f.consent.meta.versionId }, event: { kind: 'reviewed' }, state: { exactSourceMembership: true } });
        f.store.afterCommit(() => { notified = true; }); throw Error('partial failure');
    }), /partial failure/);
    assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before); assert.equal(notified, false);
    assert.throws(() => f.store.transaction(async () => { throw Error('never called'); }), /synchronous/);
    assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before);
});

test('clean public replacements keep private immutable binding across add/create/update/hydrate and source/status versions', () => {
    const f = fixture(); f.owner.approvals.createDecision(f.command());
    const all = checkpoint.snapshot(f.store, { privateState: true }), raw = all.Consent.find(value => value.id === f.consent.id);
    raw.extension = raw.extension.filter(item => ![URL, SANDBOX_EXTENSIONS.approvedTokenScope, SANDBOX_EXTENSIONS.approvedTokenScopeOrigin].includes(item.url));
    const store = new FHIRStore(); checkpoint.hydrate(store, all);
    const value = store.get('Consent', raw.id); value.provision.actor = value.provision.actor.filter(item => !item.role?.coding?.some(code => code.code === 'CST')); value.status = 'inactive';
    store.update(value);
    assert.equal(store.privateRecords.approvals.getDecision(raw.id).status, 'ok');
    assert.equal(store.privateRecords.approvals.getDecision(raw.id).publicVersionAtDecision, f.consent.meta.versionId);
    for (const method of ['add', 'update']) {
        const forged = store.get('Consent', raw.id); forged.patient.identifier.value = 'different';
        assert.throws(() => store[method](forged), /read-only/);
    }
    assert.throws(() => store.create(raw, () => {}, { id: raw.id }), /already exists/);
    const malformedCreate = structuredClone(f.consent); malformedCreate.extension.push({ url: URL, valueString: '{bad' });
    assert.throws(() => store.create(malformedCreate, () => {}, { id: 'malformed-create' }), /snapshot|Private PCM metadata/);
    assert.equal(store.get('Consent', 'malformed-create'), null);
    assert.throws(() => checkpoint.hydrate(store, checkpoint.snapshot(store)), /Unsafe restore/);
    const malformed = checkpoint.snapshot(store, { privateState: true }); malformed.Consent.find(value => value.id === raw.id).patient.identifier.value = 'forged';
    const before = checkpoint.snapshot(store, { privateState: true }); assert.throws(() => checkpoint.hydrate(store, malformed), /Inconsistent/);
    assert.deepEqual(checkpoint.snapshot(store, { privateState: true }), before);
    assert.equal(store.privateRecords.approvals.getDecision('unknown').status, 'missing');
    const definitions = structuredClone(store.privateState.services); store.privateState.services = {};
    assert.equal(store.privateRecords.approvals.getDecision(raw.id).status, 'invalid'); store.privateState.services = definitions;
    store.data.Consent.get(raw.id).patient.identifier.value = 'corrupt';
    assert.equal(store.privateRecords.approvals.getDecision(raw.id).status, 'invalid');
});

test('checkpoint restart preserves private decisions/audit/generations and standalone deletion tombstones', () => {
    const f = fixture(), disk = diskFixture(f.store);
    try {
        f.owner.approvals.createDecision(f.command());
        f.store.add({ resourceType: 'Organization', id: 'owned-unused', name: 'Unused' });
        f.store.remove('Organization', 'owned-unused');
        const before = checkpoint.snapshot(f.store, { privateState: true }), restored = new FHIRStore();
        assert.equal(checkpoint.restore({ ...disk, store: restored }), true);
        assert.deepEqual(checkpoint.snapshot(restored, { privateState: true }), before);
        const restarted = require('node:child_process').spawnSync(process.execPath, ['-e',
            "const cp=require('./src/pcm-core/src/migration-checkpoint');const store=new(require('./src/pcm-core/src/fhir/store').FHIRStore)();cp.restore({store,stateDirectory:process.argv[1],configPath:process.argv[2],runtimeId:process.argv[3]});process.stdout.write(JSON.stringify(cp.snapshot(store,{privateState:true})))",
            disk.directory, disk.configPath, runtimeId], { encoding: 'utf8', cwd: path.resolve(__dirname, '../../..') });
        assert.equal(restarted.status, 0, restarted.stderr); assert.deepEqual(JSON.parse(restarted.stdout), before);
        assert.equal(restored.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope, f.snapshot.scope);
        assert.equal(restored.privateRecords.lifecycle.getState('Organization', 'owned-unused').deleted, true);
        assert.throws(() => restored.remove('HealthcareService', f.definition.id), /referenced/);
    } finally { fs.rmSync(disk.directory, { recursive: true, force: true }); }
});

test('durable publication failure rolls back all memory, emits no diagnostics, fences restart and recovers exact reviewed bytes', () => {
    const f = fixture(), disk = diskFixture(f.store), before = checkpoint.snapshot(f.store, { privateState: true }); let delivered = false;
    const rename = fs.renameSync;
    try {
        fs.renameSync = (from, to) => { if (to === path.join(disk.root, 'manifest.json')) throw Error('disk publication failed'); return rename(from, to); };
        assert.throws(() => f.store.transaction(() => { f.owner.approvals.createDecision(f.command()); f.store.afterCommit(() => { delivered = true; }); }), /uncertain/);
        fs.renameSync = rename;
        assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before); assert.equal(delivered, false);
        assert.throws(() => checkpoint.restore({ ...disk, store: new FHIRStore() }), /incomplete/);
        const handoff = require('../../../pcm-connectathon/scripts/reconcile-pcm-handoff');
        const journal = JSON.parse(fs.readFileSync(path.join(disk.root, 'checkpoint-mutation.json')));
        assert.throws(() => handoff.recoverMutation({ ...disk, workersStopped: true, expectedDigest: 'wrong' }), /review/);
        handoff.recoverMutation({ ...disk, workersStopped: true, expectedDigest: handoff.hash(journal) });
        const restored = new FHIRStore(); checkpoint.restore({ ...disk, store: restored });
        assert.equal(restored.privateRecords.approvals.getDecision(f.consent.id).status, 'ok');
        assert.equal(restored.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope, f.snapshot.scope);
        assert.equal(delivered, false);
    } finally { fs.renameSync = rename; fs.rmSync(disk.directory, { recursive: true, force: true }); }
});

test('private backup scope binds all components/external usage, denies rollback and retains first-use bytes', () => {
    const f = fixture(); f.owner.approvals.createDecision(f.command());
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-private-backup-'));
    try {
        const windows = new (require('../src/state-store').FileFirstUseWindowStore)(directory);
        const first = windows.getOrStart(`${f.consent.id}\u0000source`, 3600, 100), file = fs.readdirSync(directory)[0], bytes = fs.readFileSync(path.join(directory, file));
        const vector = compatibility(); vector.bindings.firstUse = checkpoint.sha256(bytes);
        const saved = backup.exportPrivateCheckpoint(f.store, vector);
        assert.deepEqual(Object.keys(saved).sort(), ['compatibility', 'hash', 'schema', 'state']);
        assert.equal(JSON.stringify(saved).includes('access_token'), false);
        const mixed = structuredClone(vector); mixed.components.doctor = `sha256:${'c'.repeat(64)}`;
        assert.throws(() => backup.validateCandidate(saved, mixed), /Mixed/);
        const tampered = structuredClone(saved); tampered.state._private.approvals[`Consent/${f.consent.id}`].snapshot.scope = 'changed';
        assert.throws(() => backup.validateCandidate(tampered, vector), /hash/);
        fs.writeFileSync(require('../../shared/migration-maintenance').fencePath(directory), 'owned-maintenance');
        const restored = new FHIRStore(); backup.restorePrivateCheckpoint(restored, saved, { compatibility: vector, reviewedHash: saved.hash, workersStopped: true, stateDirectory: directory });
        assert.equal(restored.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope, f.snapshot.scope);
        assert.notEqual(restored.authorityState.epoch, f.store.authorityState.epoch);
        assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes); assert.equal(windows.getOrStart(`${f.consent.id}\u0000source`, 3600, 10000).expiresAt, first.expiresAt);
        const revoked = f.store.get('Consent', f.consent.id); revoked.status = 'inactive'; f.store.update(revoked);
        assert.throws(() => backup.assertRestrictionsPreserved(f.store, backup.validateCandidate(saved, vector)), /Unsafe restore/);
        f.store.remove('Consent', f.consent.id);
        assert.throws(() => f.store.add(f.consent), /cannot be revived/);
        assert.throws(() => backup.assertRestrictionsPreserved(f.store, backup.validateCandidate(saved, vector)), /Unsafe restore/);
        const current = backup.exportPrivateCheckpoint(f.store, vector), target = new FHIRStore();
        backup.restorePrivateCheckpoint(target, current, { compatibility: vector, reviewedHash: current.hash, workersStopped: true, stateDirectory: directory });
        assert.equal(target.privateRecords.lifecycle.getState('Consent', f.consent.id).deleted, true);
        assert.equal(target.privateRecords.approvals.getDecision(f.consent.id).status, 'invalid');
        const epoch = target.authorityState.epoch; target.reset();
        assert.notEqual(target.authorityState.epoch, epoch); assert.deepEqual(target.privateState.approvals, {});
        assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('legacy extraction is read-only, preserves exact optional inputs, and rejects conflicting seed/snapshot copies', () => {
    const f = fixture(), resources = checkpoint.snapshot(f.store);
    // A deliberately small complete graph avoids unrelated historical retained records.
    resources.Consent = [f.consent]; resources.HealthcareService = resources.HealthcareService.filter(value => [f.snapshot.service.id, f.definition.id].includes(value.id));
    // Explicit legacy corpus is confined to the read-only migration extractor.
    resources.Consent[0].extension.push({ url: URL, valueString: JSON.stringify(f.snapshot) },
        { url: SANDBOX_EXTENSIONS.approvedTokenScope, valueString: f.snapshot.scope },
        { url: SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, valueString: `${f.snapshot.origin}: ${f.snapshot.choice}` });
    const legacyCanonical = resources.HealthcareService.find(value => value.id === f.definition.id);
    legacyCanonical.extension.push({ url: require('../../shared/service-grant').URL, valueString: JSON.stringify(f.snapshot.service.grant) });
    // Legacy registration copies must agree; this fixture's canonical and instance already share grants.
    const service = resources.HealthcareService.find(value => value.id === f.snapshot.service.id), canonical = resources.HealthcareService.find(value => value.id === f.definition.id);
    const privateUrls = [require('../../shared/service-grant').URL, 'urn:pcm:sandbox:approval-scope-option', 'urn:pcm:sandbox:service-master-data', 'urn:pcm:sandbox:service-confidentiality-policy'];
    service.extension = [...service.extension.filter(value => !privateUrls.includes(value.url)), ...structuredClone(canonical.extension.filter(value => privateUrls.includes(value.url)))];
    canonical.meta.tag = (canonical.meta.tag || []).filter(value => value.system !== 'urn:pcm:sandbox:seed-definition');
    service.meta.tag = (service.meta.tag || []).filter(value => value.system !== 'urn:pcm:sandbox:seed-definition');
    canonical.meta.versionId = String(Number(canonical.meta.versionId) + 1);
    const before = structuredClone(resources), extracted = extractLegacy(Object.fromEntries([['Consent', resources.Consent], ...Object.entries(resources).filter(([type]) => type !== 'Consent')]));
    assert.equal(extracted.valid, true, JSON.stringify(extracted.disagreements)); assert.deepEqual(resources, before);
    assert.equal(extracted.privateState.services[`HealthcareService/${canonical.id}`].currentVersion, canonical.meta.versionId);
    assert.equal(extracted.privateState.approvals[`Consent/${f.consent.id}`].snapshot.scope, f.snapshot.scope);
    assert.deepEqual(extracted.privateState.approvals[`Consent/${f.consent.id}`].snapshot.service.grant.authoring, f.snapshot.service.grant.authoring);
    assert.deepEqual(publicBinding(extracted.publicCandidate.Consent[0]), publicBinding(f.consent));
    for (const mutation of [
        data => { data.Consent[0].extension.find(item => item.url === SANDBOX_EXTENSIONS.approvedTokenScope).valueString = 'conflict'; },
        data => { data.Consent[0].extension.find(item => item.url === URL).valueString = '{broken'; },
        data => { data.Consent[0].extension = data.Consent[0].extension.filter(item => item.url !== URL); },
        data => { data.HealthcareService[0].meta.tag.push({ system: 'urn:pcm:sandbox:seed-definition', code: 'hash', display: '{bad' }); },
        data => { const old = structuredClone(data.HealthcareService[0]); old.extension = []; data.HealthcareService[0].meta.tag.push({ system: 'urn:pcm:sandbox:seed-definition', code: 'hash', display: JSON.stringify(old) }); }
    ]) { const changed = structuredClone(resources); mutation(changed); assert.equal(extractLegacy(changed).valid, false); }
});

test('config adapters read the validated owner with detached revisions, never Endpoint fallback', () => {
    const config = require('../../../test-support/team-config').buildTeamConfig();
    const access = require('../src/private-config-access').createConfigAccess({ getConfig: () => config });
    const id = config.healthOrganizations[0].dataSourceOrganization.id;
    const found = access.connections.get(id); assert.equal(found.origin, 'validated-team-config'); found.value.endpoint = 'changed';
    assert.notEqual(access.connections.get(id).value.endpoint, 'changed');
    assert.equal(access.registrations.get(config.organizations.serviceProvider.clientId).value.id, config.organizations.serviceProvider.id);
    assert.equal(access.workflowConfig.get(id).value.source.id, id);
    assert.throws(() => access.connections.get('unknown'), /Unknown/); assert.throws(() => access.registrations.get('unknown'), /Unknown/);
    const broken = require('../src/private-config-access').createConfigAccess({ getConfig: () => ({}) }); assert.throws(() => broken.connections.get(id));
});
