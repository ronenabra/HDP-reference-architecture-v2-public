'use strict';
/** Focused owner-model invariants: independent catalogs, complete pairs and atomic recovery. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { FHIRStore } = require('../src/fhir/store');
const { buildTeamConfig } = require('../../../test-support/team-config');
const model = require('../src/services-admin-model');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const commands = require('../src/sandbox-service-command');
const { exportState } = require('../src/private-records');
const checkpoint = require('../src/migration-checkpoint');
const { EXTENSIONS } = require('../../shared/pcm-contract');

/** A supported complete form; no provider, lifecycle or browser-assigned identity. */
function input(name = 'Independent service') {
    return { name, purpose: 'Review approved source laboratory data', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }] };
}
/** Create a detached registered graph, including a provider outside configured legacy roles. */
function fixture() {
    const config = buildTeamConfig(), store = new FHIRStore();
    for (const resource of require('../src/bootstrap').buildSeedDrafts(config)) require('../src/public-fhir').publishNewResource(store, resource);
    const provider = store.get('Organization', config.organizations.serviceProvider.id);
    store.add({ ...provider, id: 'registered-third', name: 'Third registered provider', identifier: [{ ...provider.identifier[0], value: 'PCM-THIRD' }] });
    const events = [];
    const create = (definition = input()) => model.createCatalog({ store, config, definition, expectedRevision: store.privateState.revision, operator: 'unit-admin', audit: event => events.push(event) });
    const apply = (id, action, expectedVersion = store.get('HealthcareService', id)?.meta.versionId) => commands.applyServiceCommand({ store, config, id, action, expectedVersion, operator: 'unit-admin', audit: event => events.push(event) });
    return { store, config, provider, events, create, apply };
}

test('zero-provider create/validate/approve/disable/enable precedes pending connection and explicit activation', () => {
    const f = fixture(), created = f.create();
    assert.equal(created.registrationCount, 0);
    assert.equal(f.store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === created.id).length, 0);
    assert.equal(model.validateCatalog({ store: f.store, id: created.id, expectedVersion: created.version }).definitionValid, true);
    f.apply(created.id, 'activate'); f.apply(created.id, 'disable'); f.apply(created.id, 'enable');
    const registration = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.provider, request: require('../src/service-definition-form').existingRegistration(created.id) }).instance;
    assert.equal(lifecycle.businessStatus(registration), 'pending');
    assert.equal(lifecycle.serviceIsOperational(f.store, registration), false);
    f.apply(registration.id, 'activate');
    assert.equal(lifecycle.serviceIsOperational(f.store, f.store.get('HealthcareService', registration.id)), true);
    f.apply(registration.id, 'disable'); f.apply(created.id, 'disable'); f.apply(created.id, 'enable');
    assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', registration.id)), 'suspended', 'global restore preserves local pause');
    assert.ok(f.events.every(event => event.visibility === 'diagnostic'));
});

test('duplicate/incomplete/stale and nonoperational activation failures preserve all state', () => {
    const f = fixture(), created = f.create();
    let before = checkpoint.snapshot(f.store, { privateState: true });
    for (const definition of [input(' INDEPENDENT SERVICE '), { ...input('Incomplete'), buckets: [] }, { ...input('Forged'), providedBy: 'registered-third' }]) {
        assert.throws(() => f.create(definition)); assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before);
    }
    assert.throws(() => model.createCatalog({ ...f, definition: input('Stale'), expectedRevision: 0, operator: 'admin', audit() {} }), /revision changed/);
    f.apply(created.id, 'activate');
    const instance = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.provider, request: require('../src/service-definition-form').existingRegistration(created.id) }).instance;
    f.store.update({ ...f.provider, active: false }); before = checkpoint.snapshot(f.store, { privateState: true });
    assert.throws(() => f.apply(instance.id, 'activate'), /operational/);
    assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before);
    assert.throws(() => f.apply(created.id, 'disable', created.version), /changed/);
});

test('all states/unassigned catalogs and three-provider pairs page with exact completeness and stale fences', () => {
    const f = fixture(), ids = [];
    for (const state of ['pending', 'active', 'frozen', 'rejected', 'cancelled']) {
        const created = f.create(input(`Inventory ${state}`)); ids.push(created.id);
        const resource = f.store.get('HealthcareService', created.id);
        f.store.update({ ...resource, active: state === 'active', extension: [lifecycle.statusExtension(state), ...resource.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)] });
    }
    const all = model.catalogInventory(f);
    assert.ok(ids.every(id => all.items.some(item => item.id === id && item.registrationCount === 0)));
    const first = model.catalogInventory({ ...f, query: { limit: '1' } }); assert.equal(first.complete, false); assert.equal(first.total, all.total);
    assert.throws(() => model.catalogInventory({ ...f, query: { offset: '1' } }), /revision/);
    const group = model.providerInventory({ ...f, catalogId: ids[1] });
    assert.equal(group.total, 3); assert.equal(group.complete, true);
    const third = group.items.find(item => item.id === 'registered-third');
    assert.equal(third.connection, 'not-connected'); assert.equal(third.standardManagement, false); assert.match(third.unavailableReason, /credentials/);
    const registration = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.provider, request: require('../src/service-definition-form').existingRegistration(ids[1]) }).instance;
    const withdrawn = lifecycle.transitionHealthcareService({ store: f.store, callerOrganization: f.provider, existing: registration, request: { extension: [lifecycle.statusExtension('cancelled')] } });
    const next = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.provider, request: require('../src/service-definition-form').existingRegistration(ids[1]) }).instance;
    const pairs = model.providerInventory({ ...f, catalogId: ids[1] }).items.find(item => item.id === f.provider.id);
    assert.equal(pairs.registrations.length, 2); assert.equal(pairs.connection, 'registered'); assert.ok(pairs.registrations.some(item => item.id === withdrawn.id)); assert.ok(pairs.registrations.some(item => item.id === next.id));
    f.store.remove('Organization', f.provider.id);
    const orphan = model.providerInventory({ ...f, catalogId: ids[1] }).items.find(item => item.id === f.provider.id);
    assert.equal(orphan.registered, false); assert.equal(orphan.registrations.length, 2); assert.equal(orphan.standardManagement, false);
    assert.throws(() => model.catalogInventory({ ...f, query: { offset: '1', revision: String(first.revision) } }), /changed/);
    assert.throws(() => model.catalogInventory({ ...f, query: { limit: '51' } }), /bounded/);
    delete f.store.privateState.services[`HealthcareService/${ids[1]}`]; // Deliberately missing owner authority cannot appear usable.
    assert.match(model.catalogInventory(f).items.find(item => item.id === ids[1]).availability, /private service definition is missing/);
    assert.throws(() => model.validateCatalog({ store: f.store, id: ids[1], expectedVersion: f.store.get('HealthcareService', ids[1]).meta.versionId }), /missing or invalid/);
});

test('authoritative audit failure rolls back create/status/delete together with private authority and generations', () => {
    const f = fixture();
    const original = f.store.privateRecords.append.bind(f.store.privateRecords);
    let before = checkpoint.snapshot(f.store, { privateState: true });
    f.store.privateRecords.append = () => { throw Error('owned authoritative audit failure'); };
    assert.throws(() => f.create(), /audit failure/); assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before);
    f.store.privateRecords.append = original; const created = f.create(); before = checkpoint.snapshot(f.store, { privateState: true });
    f.store.privateRecords.append = () => { throw Error('owned authoritative audit failure'); };
    for (const action of ['activate', 'delete']) { assert.throws(() => f.apply(created.id, action), /audit failure/); assert.deepEqual(checkpoint.snapshot(f.store, { privateState: true }), before); }
    f.store.privateRecords.append = original;
    const resource = f.store.get('HealthcareService', created.id); f.apply(created.id, 'delete');
    assert.equal(f.store.get('HealthcareService', created.id), null);
    assert.equal(f.store.privateRecords.lifecycle.getState('HealthcareService', created.id).deleted, true);
    assert.throws(() => f.store.add(resource), /revived/);
});

test('builtin fixed identity, seed, active, terminal Consent and frozen approval history prevent deletion', () => {
    const f = fixture(), created = f.create(); f.apply(created.id, 'activate');
    assert.throws(() => f.apply(created.id, 'delete'), /Disable/); f.apply(created.id, 'disable');
    f.store.add({ resourceType: 'Consent', id: 'terminal-history', status: 'inactive', extension: [{ url: EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${created.id}` } }] });
    assert.throws(() => f.apply(created.id, 'delete'), /Consent history references this service/);
    const authored = require('../src/service-definition-form').serviceDefinitionCommand(input('Built-in fixture'));
    const builtin = lifecycle.createCatalogDefinition({ store: f.store, request: authored.resource, privateDefinition: authored.definition, idGenerator: () => model.BUILTIN_CATALOG_ID });
    f.store.update({ ...builtin, active: false, name: 'Renamed ordinary service', extension: [lifecycle.statusExtension('cancelled'), ...builtin.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)] });
    assert.match(commands.serviceActions({ ...f, service: f.store.get('HealthcareService', builtin.id) }).deleteReason, /built-in service is protected/);
    assert.throws(() => f.apply(builtin.id, 'delete'), /built-in service is protected/);
    const ordinary = f.create(input('Unreferenced inactive')); f.apply(ordinary.id, 'delete');
    const seeded = f.store.getAll('HealthcareService').find(item => item.id !== builtin.id && lifecycle.serviceKind(item) === 'catalog');
    assert.equal(commands.serviceActions({ ...f, service: seeded }).dependencies.seeded, true);
    const g = require('../../../test-support/clinical-token-fixture').clinicalTokenFixture();
    const consent = g.store.get('Consent', g.consent.id);
    g.store.remove('Consent', consent.id); // Existing private immutable approval/tombstone remains after public deletion.
    const definitionId = g.store.privateRecords.approvals.getDecision(consent.id).snapshot?.service.definitionId || Object.values(g.store.privateState.approvals)[0].snapshot.service.definitionId;
    assert.ok(commands.dependencies({ store: g.store, config: g.config, service: g.store.get('HealthcareService', definitionId) }).approvals.length);
});

test('reserved provider preferences survive exact checkpoint restore and never create registrations or authority', () => {
    const f = fixture(), providerId = 'registered-third', revision = f.store.privateState.revision, before = f.store.getAll('HealthcareService'), generations = new Map(f.store.authorityState.generations);
    const value = { serviceDefaults: { schema: 'pcm-provider-service-defaults/1', services: { [model.BUILTIN_CATALOG_ID]: { initialized: true, override: 'disconnected' } } } };
    const put = value => f.store.privateRecords.provisioning.put({ type: 'Organization', id: providerId, expectedRevision: f.store.privateState.revision, expectedVersions: { [`Organization/${providerId}`]: f.store.get('Organization', providerId).meta.versionId }, value });
    put(value); assert.equal(f.store.privateState.revision, revision + 1); assert.deepEqual(f.store.getAll('HealthcareService'), before); assert.deepEqual(f.store.authorityState.generations, generations);
    const snapshot = checkpoint.snapshot(f.store, { privateState: true }), restored = new FHIRStore();
    checkpoint.hydrate(restored, snapshot);
    assert.deepEqual(restored.privateRecords.services.getProviderDefaults(providerId), value.serviceDefaults);
    assert.equal(exportState(restored).schema, 'pcm-private-state/1');
    assert.throws(() => put({ serviceDefaults: { ...value.serviceDefaults, permission: 'patient/*.rs' } }), /Invalid provider/);
});
