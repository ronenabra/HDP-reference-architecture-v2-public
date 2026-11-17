'use strict';
/** Exact wildcard, real provisioning choices and retained review/restore boundaries. */
const test = require('node:test'), assert = require('node:assert/strict');
const { fullAccessFixture } = require('../../../test-support/sandbox-full-access-fixture');
const { PRESETS, NOW, EXACT } = require('../../../test-support/consent-request-fixture');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const participant = require('../src/fhir/participant-lifecycle');
const checkpoint = require('../src/migration-checkpoint');
const { FHIRStore } = require('../src/fhir/store');
const { inspectScope, FULL_PATIENT_SCOPE, PATIENT_TYPES } = require('../../shared/service-grant');
const { resolveGrant } = require('../src/data-grant');
const catalog = require('../src/catalog-bootstrap');

/** Invoke an ordinary owner transition against the current version. */
function transition(f, id, state) {
    const existing = f.store.get('HealthcareService', id);
    return lifecycle.transitionHealthcareService({ store: f.store, callerOrganization: f.store.get('Organization', lifecycle.ownerId(existing)), existing,
        request: { extension: [lifecycle.statusExtension(state)] } });
}
/** A registered child has its own exact ID; enrollment occurs inside real creation. */
function child(f, id) {
    return participant.createServiceProviderChild({ store: f.store, callerOrganization: f.store.get('Organization', f.client.organizationId),
        request: { name: `Registered provider ${id}` }, idGenerator: () => id });
}
/** Select one provider's complete registration history. */
function connections(f, providerId) {
    return f.store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === lifecycle.BUILTIN_CATALOG_ID && lifecycle.ownerId(item) === providerId);
}
test('actual fresh bootstrap enrolls every registered provider and never recreates an explicitly detached missing seed', async t => {
    const config = require('../../../test-support/team-config').installTestRuntime({ serviceCatalog: {
        file: 'config/demo-services.json', bindings: ['serviceProvider', 'hospitalBServiceProvider'].map((providerRole, index) => ({
            providerRole, application: `full18-${index}`, serviceKey: 'sandbox-full-access', instanceId: `full18-seed-${index}`, instanceIdentifier: `FULL18-SEED-${index}` }))
    }, conformance: { preset: 'connectathon-mtls' } });
    const store = require('../src/fhir/store'); store.reset(); t.after(() => store.reset());
    const seeds = require('../src/bootstrap').buildSeedDrafts(config);
    for (const draft of seeds.filter(item => item.resourceType === 'Organization')) require('../src/public-fhir').publishNewResource(store, draft);
    const provider = store.get('Organization', config.organizations.serviceProvider.id);
    participant.createServiceProviderChild({ store, callerOrganization: provider, request: { name: 'Preexisting third provider' }, idGenerator: () => 'fresh-third18' });
    await require('../src/bootstrap')();
    for (const providerId of [provider.id, config.organizations.hospitalBServiceProvider.id, 'fresh-third18']) {
        assert.equal(connections({ store }, providerId).length, 1);
        assert.equal(store.privateRecords.services.getProviderDefaults(providerId).services[lifecycle.BUILTIN_CATALOG_ID].initialized, true);
    }
    const f = { store }, detached = 'full18-seed-1';
    transition(f, detached, 'suspended'); transition(f, detached, 'cancelled'); store.remove('HealthcareService', detached);
    await require('../src/bootstrap')();
    assert.equal(store.get('HealthcareService', detached), null);
    assert.equal(store.privateRecords.services.getProviderDefaults(config.organizations.hospitalBServiceProvider.id).services[lifecycle.BUILTIN_CATALOG_ID].override, 'disconnected');
    const later = participant.createServiceProviderChild({ store, callerOrganization: provider, request: { name: 'Later fourth provider' }, idGenerator: () => 'later-fourth18' });
    assert.equal(connections(f, later.id).length, 1);
});
for (const preset of PRESETS) test(`${preset}: exact whole default, token and active inspection retain wildcard bytes and original clocks`, () => {
    const f = fullAccessFixture({ preset, mode: 'one-time' });
    const definition = f.store.privateRecords.services.getDefinition(f.service.id).grant;
    assert.equal(definition.scope, FULL_PATIENT_SCOPE);
    assert.equal(require('../src/service-scope-authoring').previewDefinition(require('../src/service-definition-form').serviceDefinitionDraft(definition.authoring,
        { now: Date.parse(definition.anchor) / 1000 })).savedScope, FULL_PATIENT_SCOPE);
    const snapshot = f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot;
    assert.equal(snapshot.scope, FULL_PATIENT_SCOPE); assert.equal(snapshot.choice, 'service-provided'); assert.equal(snapshot.usable, true);
    const grant = resolveGrant(f.request); assert.equal(grant.scope, FULL_PATIENT_SCOPE);
    const { createTokenService } = require('../src/token-service');
    const { evaluateSubjectToken } = require('../src/introspection-service');
    let record;
    const policy = require('../../shared/conformance-policy').buildEffectivePolicy(f.config, {});
    const issue = createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore,
        tokenStore: { issue(kind, claims, lifetime) { record = { ...claims, kind, iat: NOW, exp: NOW + lifetime }; return { token: 'opaque-wildcard', record }; } },
        authenticate: req => { req.mtls = { thumbprint: f.client.mtlsThumbprint }; return { client: f.client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: f.client.assertionThumbprint }; },
        getIssuer: () => f.config.contract.operational.oauthBase, getConfig: () => f.config, getPolicy: () => policy, getLifetime: () => 300, clock: () => NOW, logger: { info() {}, warn() {} } });
    const response = issue({ body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'owned-unit', resource: f.source.endpoint, scope: 'patient/Observation.s', authorization_details: JSON.stringify(f.request.requested.details) } });
    assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body.scope, FULL_PATIENT_SCOPE); assert.equal(f.windows.size, 0);
    const inspect = () => evaluateSubjectToken({ token: record, store: f.store, config: f.config, now: NOW, firstUseStore: f.firstUseStore,
        caller: { clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id }, controls: policy.simulation.controls, findClient: id => id === f.client.clientId ? f.client : { role: 'data-source', clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id } });
    assert.equal(inspect().scope, FULL_PATIENT_SCOPE); const windows = JSON.stringify([...f.windows]);
    assert.equal(inspect().scope, FULL_PATIENT_SCOPE); assert.equal(JSON.stringify([...f.windows]), windows);
    const doctor = require('../../sp-client/src/permission-plan').validateClinicalGrant(response.body, f.consent, f.service);
    assert.equal(doctor.scope, FULL_PATIENT_SCOPE); assert.equal(doctor.summary.usable, true);
    assert.deepEqual(new Set(doctor.summary.actions.map(item => item.type)), new Set(PATIENT_TYPES));
    assert.ok(!doctor.summary.actions.some(item => ['Organization', 'Practitioner'].includes(item.type)));
});

test('only the exact qualified wildcard changes applicability; malformed and ordinary finite grants still deny', () => {
    assert.deepEqual(inspectScope(FULL_PATIENT_SCOPE).diagnostics, { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] });
    for (const value of ['patient/*.r', 'patient/*.rs?status=final', 'patient/*.cruds', ' patient/*.rs', 'patient/Patient.rs', 'system/*.rs']) {
        assert.ok(Object.values(inspectScope(value).diagnostics).some(item => ['invalid', 'unsupported'].includes(item)), value);
        const f = fullAccessFixture(); const bad = f.approve(value);
        assert.equal(f.store.privateRecords.approvals.getDecision(bad.id).status, 'invalid');
    }
});

test('real fresh/later provider provisioning is idempotent and pause/detach survive reload, seed and checkpoint restore', () => {
    const f = fullAccessFixture({ preset: 'connectathon-mtls' });
    const second = child(f, 'later-two'), third = child(f, 'later-three');
    const paused = connections(f, second.id)[0], detached = connections(f, third.id)[0];
    transition(f, paused.id, 'suspended'); transition(f, detached.id, 'suspended'); transition(f, detached.id, 'cancelled');
    const saved = checkpoint.snapshot(f.store, { privateState: true });
    const restarted = new FHIRStore(); checkpoint.hydrate(restarted, saved); f.store = restarted;
    for (let iteration = 0; iteration < 2; iteration++) {
        for (const provider of f.store.getAll('Organization')) lifecycle.enrollProviderDefault({ store: f.store, provider });
        catalog.publishCatalog(f.store, require('../src/bootstrap').buildSeedDrafts(f.config).filter(item => item.resourceType === 'HealthcareService'));
    }
    assert.equal(connections(f, second.id).length, 1); assert.equal(connections(f, third.id).length, 1);
    assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', paused.id)), 'suspended');
    assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', detached.id)), 'cancelled');
    const defaults = id => f.store.privateRecords.services.getProviderDefaults(id).services[lifecycle.BUILTIN_CATALOG_ID];
    assert.equal(defaults(second.id).override, 'paused'); assert.equal(defaults(third.id).override, 'disconnected');
    const cmd = require('../src/sandbox-service-command');
    for (const action of ['disable', 'enable']) cmd.applyServiceCommand({ store: f.store, config: f.config, id: lifecycle.BUILTIN_CATALOG_ID,
        action, expectedVersion: f.store.get('HealthcareService', lifecycle.BUILTIN_CATALOG_ID).meta.versionId, operator: 'owned', audit() {} });
    assert.equal(defaults(second.id).override, 'paused'); assert.equal(defaults(third.id).override, 'disconnected');
    const result = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: third, request: require('../src/service-definition-form').existingRegistration(lifecycle.BUILTIN_CATALOG_ID) });
    assert.notEqual(result.instance.id, detached.id); assert.equal(lifecycle.businessStatus(result.instance), 'pending');
    assert.equal(defaults(third.id).override, 'none'); assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', detached.id)), 'cancelled');
    assert.throws(() => checkpoint.hydrate(f.store, saved), /Unsafe restore/);
});

test('provisioning failure rolls back organization, preference, association and authority; retry creates exactly one', () => {
    const f = fullAccessFixture(), before = checkpoint.snapshot(f.store, { privateState: true });
    const original = f.store.privateRecords.provisioning.put;
    f.store.privateRecords.provisioning.put = command => { if (command.id === 'retry-provider') throw new Error('owned durable preference failure'); return original(command); };
    assert.throws(() => child(f, 'retry-provider'), /owned durable/);
    assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before);
    f.store.privateRecords.provisioning.put = original;
    const provider = child(f, 'retry-provider'); lifecycle.enrollProviderDefault({ store: f.store, provider });
    assert.equal(connections(f, provider.id).length, 1);
    assert.throws(() => child(f, 'retry-provider'), /already exists/);
    assert.equal(connections(f, provider.id).length, 1);
});

test('built-in canonical deletion is guarded after rename, disable, dependency removal and forged command', () => {
    const f = fullAccessFixture({ preset: 'connectathon-mtls' }), command = require('../src/sandbox-service-command');
    f.store = new FHIRStore();
    for (const draft of require('../src/bootstrap').buildSeedDrafts(f.config)) require('../src/public-fhir').publishNewResource(f.store, draft);
    const renamed = f.store.get('HealthcareService', lifecycle.BUILTIN_CATALOG_ID); renamed.name = 'Ordinary renamed display'; f.store.update(renamed);
    for (const state of ['active', 'frozen']) {
        f.store.update({ ...f.store.get('HealthcareService', renamed.id), active: state === 'active', extension: [lifecycle.statusExtension(state), ...renamed.extension.filter(item => item.url !== require('../../shared/pcm-contract').EXTENSIONS.serviceBusinessStatus)] });
        assert.throws(() => command.applyServiceCommand({ store: f.store, config: f.config, id: renamed.id, action: 'delete', expectedVersion: f.store.get('HealthcareService', renamed.id).meta.versionId, operator: 'owned', audit() {} }), /built-in service is protected/);
    }
});

test('reviewed retained narrow migration creates a definition version only; old approvals stay exact and unsafe restore refuses', t => {
    const f = fullAccessFixture();
    const current = f.store.get('HealthcareService', lifecycle.BUILTIN_CATALOG_ID);
    // Disposable historical package is constructed through the trusted producer before any built-in approval.
    const oldGrant = structuredClone(require('../../../config/demo-services.json').clinicalServices.find(item => item.key === 'sandbox-full-access').serviceGrant);
    oldGrant.scope = EXACT; oldGrant.authoring.approvalScope = EXACT; oldGrant.diagnostics = inspectScope(EXACT).diagnostics;
    f.store.privateState.services[`HealthcareService/${current.id}`].versions[current.meta.versionId].grant = oldGrant;
    // Drop only this owned fixture's newly-created full approval; create the actual old narrow approval.
    for (const record of f.store.getAll('Consent').filter(item => require('../src/fhir/consent-lifecycle').consentServiceId(item) === f.service.id)) { f.store.remove('Consent', record.id); delete f.store.privateState.approvals[`Consent/${record.id}`]; }
    const narrow = f.approve(); const before = JSON.stringify(f.store.privateRecords.approvals.getDecision(narrow.id));
    const proposed = require('../src/bootstrap').buildSeedDrafts(f.config).filter(item => item.id === lifecycle.BUILTIN_CATALOG_ID);
    const preview = catalog.previewCatalog(f.store, proposed); assert.equal(preview.fullAccessMigration.newScope, FULL_PATIENT_SCOPE);
    assert.throws(() => catalog.reconcileCatalog(f.store, proposed, preview.versions, () => {}), /preview digest/);
    let backup;
    assert.throws(() => catalog.reconcileCatalog(f.store, proposed, preview.versions, () => {}, { fullAccessReview: preview.fullAccessMigration.digest }), /stopped checkpoint/);
    const fs = require('node:fs'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pcm-full18-unit-fence-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(require('../../shared/migration-maintenance').fencePath(directory), 'owned stopped fixture');
    const repositoryRoot = path.resolve(__dirname, '../../..');
    catalog.reconcileCatalog(f.store, proposed, preview.versions, value => { backup = value; }, { fullAccessReview: preview.fullAccessMigration.digest,
        offlineReview: { workersStopped: true, stateDirectory: directory, repositoryRoot, components: require('../../shared/public-metadata-compatibility').artifacts(repositoryRoot) } });
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(narrow.id)), before);
    assert.equal(f.store.privateRecords.approvals.getDecision(f.approve().id).snapshot.scope, FULL_PATIENT_SCOPE);
    const restored = new FHIRStore(); checkpoint.hydrate(restored, checkpoint.snapshot(f.store, { privateState: true }));
    assert.equal(restored.privateRecords.approvals.getDecision(narrow.id).snapshot.scope, EXACT);
    const consent = f.store.get('Consent', narrow.id); f.store.update({ ...consent, status: 'inactive' });
    assert.throws(() => checkpoint.hydrate(f.store, backup), /Unsafe restore/);
});

for (const preset of PRESETS) test(`${preset}: wildcard retains independent invalid/expired/revoked/context/lifecycle/provider denials`, () => {
    for (const damage of ['invalid', 'expired', 'revoked', 'catalog', 'paused', 'detached', 'provider', 'source', 'audience', 'client', 'legacy']) {
        const f = fullAccessFixture({ preset });
        const request = { ...f.request };
        if (damage === 'invalid') f.store.privateState.approvals[`Consent/${f.consent.id}`].snapshot.scope = 'forged';
        if (damage === 'expired') request.now = Date.parse(f.consent.provision.period.end) / 1000;
        if (damage === 'revoked') f.store.update({ ...f.consent, status: 'inactive' });
        if (damage === 'catalog') f.store.update({ ...f.store.get('HealthcareService', lifecycle.BUILTIN_CATALOG_ID), active: false });
        if (['paused', 'detached'].includes(damage)) {
            transition(f, f.service.id, 'suspended');
            if (damage === 'detached') transition(f, f.service.id, 'cancelled');
        }
        if (damage === 'provider') f.store.update({ ...f.store.get('Organization', f.client.organizationId), active: false });
        if (damage === 'source') request.resource = f.config.healthOrganizations[1].endpoint;
        if (damage === 'audience') request.resource = 'https://unregistered.example/fhir';
        if (damage === 'client') request.client = { ...f.client, organizationId: f.config.organizations.hospitalBServiceProvider.id };
        if (damage === 'legacy') request.resource = f.config.legacyDataSource.internalFhirBaseUrl;
        assert.throws(() => resolveGrant(request), undefined, damage);
    }
});


test('an uninitialized record cannot disguise a deliberate override and trigger re-enrollment', () => {
    const f = fullAccessFixture(), provider = f.store.get('Organization', f.client.organizationId);
    assert.throws(() => f.store.privateRecords.provisioning.put({ type: 'Organization', id: provider.id,
        value: { serviceDefaults: { schema: 'pcm-provider-service-defaults/1', services: { [lifecycle.BUILTIN_CATALOG_ID]: { initialized: false, override: 'disconnected' } } } },
        expectedRevision: f.store.privateState.revision, expectedVersions: { [`Organization/${provider.id}`]: provider.meta.versionId } }), /Invalid provider service override/);
});
