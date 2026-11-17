/** Organization create/update lifecycle contract tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FHIRStore } = require('../src/fhir/store');
const { validateWriteRequest } = require('../src/fhir/contract');
const {
    ParticipantLifecycleError,
    createServiceProviderChild,
    organizationIsOperational,
    organizationRole,
    replaceOrganization
} = require('../src/fhir/participant-lifecycle');
const { CODE_SYSTEMS, IDENTIFIER_SYSTEMS, PROFILES, validateSeedResource } = require('../../shared/pcm-contract');

const orgType = code => [{ coding: [{ system: CODE_SYSTEMS.organizationType, code }] }, {
    coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1' }]
}];
const official = value => [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value }];

function fixture() {
    const store = new FHIRStore();
    const parent = store.add({
        resourceType: 'Organization', id: 'parent', active: true, name: 'Parent',
        identifier: official('PCM-ORG-PARENT'), type: orgType('parent-org')
    });
    const sp = store.add({
        resourceType: 'Organization', id: 'sp', active: true, name: 'SP',
        identifier: official('PCM-ORG-SP'), type: orgType('service-provider'),
        partOf: { reference: 'Organization/parent' }, contact: [{ name: { text: 'Old' } }]
    });
    const source = store.add({
        resourceType: 'Organization', id: 'source', active: true, name: 'Source',
        identifier: official('PCM-ORG-SOURCE'), type: orgType('source'),
        partOf: { reference: 'Organization/parent' }, endpoint: [{ reference: 'Endpoint/ep-old' }]
    });
    store.add({
        resourceType: 'Endpoint', id: 'ep-old', status: 'active',
        managingOrganization: { reference: 'Organization/source' }
    });
    return { store, parent, sp, source };
}

test('authorized SP child create derives stable identity, role, parent, state, and response profile', () => {
    const { store, sp } = fixture();
    const created = createServiceProviderChild({
        store,
        callerOrganization: sp,
        request: { resourceType: 'Organization', name: 'New Child', contact: [{ name: { text: 'Operations' } }] },
        idGenerator: () => 'child-1'
    });
    assert.equal(created.id, 'child-1');
    assert.deepEqual(created.identifier, official('PCM-ORG-CHILD-1'));
    assert.equal(created.active, true);
    assert.equal(organizationRole(created), 'service-provider');
    assert.equal(created.partOf.reference, 'Organization/parent');
    assert.deepEqual(created.meta.profile, [PROFILES.organizationServiceProvider]);
    assert.equal(organizationIsOperational(store, created), true);
});

test('Organization create rejects wrong role, cross-parent/type smuggling, duplicate identity, and managed extensions', () => {
    const { store, sp, source } = fixture();
    assert.throws(() => createServiceProviderChild({
        store, callerOrganization: source, request: { name: 'No' }
    }), error => error instanceof ParticipantLifecycleError && error.status === 403);
    const inactive = store.update({ ...sp, active: false });
    assert.throws(() => createServiceProviderChild({
        store, callerOrganization: inactive, request: { name: 'Inactive' }
    }), error => error instanceof ParticipantLifecycleError && error.status === 403);
    for (const field of [
        { partOf: { reference: 'Organization/other' } },
        { type: orgType('source') },
        { active: false },
        { identifier: official('CLAIMED') }
    ]) {
        assert.throws(() => validateWriteRequest(
            { resourceType: 'Organization', name: 'Smuggled', ...field },
            { resourceType: 'Organization', interaction: 'create' }
        ), /Unsupported Organization field/);
    }
    createServiceProviderChild({ store, callerOrganization: sp, request: { name: 'Duplicate' }, idGenerator: () => 'first' });
    assert.throws(() => createServiceProviderChild({
        store, callerOrganization: sp, request: { name: ' duplicate ' }, idGenerator: () => 'second'
    }), error => error.status === 409 && store.get('Organization', 'second') === null);
    assert.throws(() => createServiceProviderChild({
        store,
        callerOrganization: sp,
        request: { name: 'Managed', extension: [{ url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-oauth2-redirect-uri', valueUrl: 'https://evil.example' }] }
    }), /PCM-managed/);
});

test('type-specific Organization update preserves immutable fields and replaces the complete contact set', () => {
    const { store, sp } = fixture();
    const replacementContact = [{ name: { text: 'New' } }];
    const updated = replaceOrganization({
        store,
        callerOrganization: sp,
        existing: sp,
        request: { resourceType: 'Organization', id: 'sp', name: 'SP', contact: replacementContact }
    });
    assert.deepEqual(updated.contact, replacementContact);
    assert.deepEqual(updated.identifier, sp.identifier);
    assert.deepEqual(updated.type, sp.type);
    assert.deepEqual(updated.partOf, sp.partOf);
    assert.equal(updated.active, true);

    const omitted = replaceOrganization({
        store,
        callerOrganization: updated,
        existing: updated,
        request: { resourceType: 'Organization', id: 'sp', name: 'SP' }
    });
    assert.equal(omitted.contact, undefined);
    assert.throws(() => replaceOrganization({
        store, callerOrganization: omitted, existing: omitted,
        request: { resourceType: 'Organization', id: 'sp', name: 'Renamed' }
    }), /unchanged/);
    assert.throws(() => replaceOrganization({
        store, callerOrganization: store.get('Organization', 'source'), existing: omitted,
        request: { resourceType: 'Organization', id: 'sp', name: 'SP' }
    }), error => error.status === 403);
});

test('Data Source Organization requires exactly one owned non-retired Endpoint and supports replacement ordering', () => {
    const { store, source } = fixture();
    store.add({ resourceType: 'Endpoint', id: 'ep-new', status: 'suspended', managingOrganization: { reference: 'Organization/source' } });
    store.add({ resourceType: 'Endpoint', id: 'ep-other', status: 'active', managingOrganization: { reference: 'Organization/sp' } });
    for (const endpoint of [[], [{ reference: 'Endpoint/ep-old' }, { reference: 'Endpoint/ep-new' }], [{ reference: 'Endpoint/ep-other' }]]) {
        assert.throws(() => replaceOrganization({
            store, callerOrganization: source, existing: source,
            request: { resourceType: 'Organization', id: 'source', name: 'Source', endpoint }
        }), ParticipantLifecycleError);
    }
    const replaced = replaceOrganization({
        store, callerOrganization: source, existing: source,
        request: { resourceType: 'Organization', id: 'source', name: 'Source', endpoint: [{ reference: 'Endpoint/ep-new' }] }
    });
    assert.deepEqual(replaced.endpoint, [{ reference: 'Endpoint/ep-new' }]);
});

test('parent inactivity gates child operation without rewriting child active state', () => {
    const { store, parent, sp } = fixture();
    assert.equal(organizationIsOperational(store, sp), true);
    store.update({ ...parent, active: false });
    assert.equal(organizationIsOperational(store, store.get('Organization', 'sp')), false);
    assert.equal(store.get('Organization', 'sp').active, true);
});

test('all imported Organization response examples validate and round-trip through the authoritative store', () => {
    const directory = path.resolve(__dirname, '../../../docs/FHIR-examples');
    const files = fs.readdirSync(directory)
        .filter(name => /^Organization-.*\.json$/.test(name))
        .filter(name => {
            const resource = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
            return resource.meta?.profile?.some(profile => [
                PROFILES.organizationParent,
                PROFILES.organizationServiceProvider,
                PROFILES.organizationSource,
                PROFILES.organizationSystem
            ].includes(profile));
        });
    assert.equal(files.length, 6);
    for (const file of files) {
        const resource = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
        assert.deepEqual(validateSeedResource(resource), [], file);
        const store = new FHIRStore();
        const persisted = store.add(resource);
        assert.deepEqual(store.get('Organization', resource.id), persisted, file);
    }
});
