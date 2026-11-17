/** HealthcareService registration and persisted lifecycle contract tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FHIRStore } = require('../src/fhir/store');
const {
    HealthcareServiceLifecycleError,
    businessStatus,
    classifyRegistrationRequest,
    registerHealthcareService,
    serviceIsOperational,
    serviceKind,
    statusExtension,
    transitionHealthcareService
} = require('../src/fhir/healthcare-service-lifecycle');
const {
    CODE_SYSTEMS,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    PROFILES,
    validateSeedResource
} = require('../../shared/pcm-contract');

const examples = path.resolve(__dirname, '../../../docs/FHIR-examples');
const officialOrg = value => [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value }];
const tag = code => [{ system: CODE_SYSTEMS.metaTag, code, display: code === 'catalog' ? 'Catalog' : 'Instance' }];

function fixture() {
    const ids = ['catalog-new', 'instance-new', 'extra'];
    const store = new FHIRStore({
        idGenerator: () => ids.shift(),
        clock: () => new Date('2026-01-01T00:00:00.000Z')
    });
    const parent = store.add({
        resourceType: 'Organization', id: 'parent', active: true,
        identifier: officialOrg('PCM-PARENT'),
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'parent-org' }] }]
    });
    const sp = store.add({
        resourceType: 'Organization', id: 'sp', active: true,
        identifier: officialOrg('PCM-SP'),
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }],
        partOf: { reference: `Organization/${parent.id}` }
    });
    const other = store.add({
        resourceType: 'Organization', id: 'other', active: true,
        identifier: officialOrg('PCM-OTHER'),
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }],
        partOf: { reference: `Organization/${parent.id}` }
    });
    const catalog = require('../src/public-fhir').publishNewResource(store, JSON.parse(fs.readFileSync(path.join(
        examples,
        'HealthcareService-svc-catalog-cross-org-summary.json'
    ), 'utf8')));
    const definition = require('../src/public-service-definition').definitionFromPublic(catalog);
    store.privateRecords.services.createDefinition({ serviceId: catalog.id, ...definition, expectedRevision: store.privateState.revision, expectedVersions: { [`HealthcareService/${catalog.id}`]: catalog.meta.versionId } });
    return { store, parent, sp, other, catalog };
}

function existingRequest(catalogId = 'svc-catalog-cross-org-summary') {
    return {
        resourceType: 'HealthcareService',
        extension: [{
            url: EXTENSIONS.basedOnCanonicalHealthcareService,
            valueReference: { reference: `HealthcareService/${catalogId}` }
        }]
    };
}

function newRequest() {
    const request = JSON.parse(fs.readFileSync(path.join(
        examples,
        'HealthcareService-svc-instance-hosp-a-new-service-submit.json'
    ), 'utf8'));
    delete request.id;
    return request;
}

function instanceResource({ id = 'instance', owner = 'sp', canonical = 'svc-catalog-cross-org-summary', status = 'active' } = {}) {
    const source = JSON.parse(fs.readFileSync(path.join(
        examples,
        'HealthcareService-svc-instance-hosp-a-cross-org-summary.json'
    ), 'utf8'));
    source.id = id;
    source.identifier = [{
        use: 'official', system: IDENTIFIER_SYSTEMS.healthcareServiceInstance, value: `PCM-${id}`
    }];
    source.providedBy = { reference: `Organization/${owner}` };
    source.extension = [
        statusExtension(status),
        ...source.extension.filter(extension => extension.url !== EXTENSIONS.serviceBusinessStatus)
    ].map(extension => extension.url === EXTENSIONS.basedOnCanonicalHealthcareService
        ? { ...extension, valueReference: { reference: `HealthcareService/${canonical}` } }
        : extension);
    source.active = status === 'active';
    return source;
}

function updateRequest(id, status) {
    return { resourceType: 'HealthcareService', id, extension: [statusExtension(status)] };
}

test('request mode discriminator is closed and requires exact new-service extensions', () => {
    assert.equal(classifyRegistrationRequest(existingRequest()), 'existing-catalog');
    assert.equal(classifyRegistrationRequest(newRequest()), 'new-service');
    assert.throws(() => classifyRegistrationRequest({
        ...existingRequest(), name: 'Smuggled definition'
    }), /prohibited definition/);
    assert.throws(() => classifyRegistrationRequest({
        ...existingRequest(), extension: [...existingRequest().extension, ...existingRequest().extension]
    }), /exactly one basedOn/);
    assert.throws(() => classifyRegistrationRequest({ ...newRequest(), meta: { tag: tag('catalog') } }), /PCM-managed/);
    const modified = newRequest();
    modified.extension[0].modifierExtension = [];
    assert.throws(() => classifyRegistrationRequest(modified), /modifierExtension/);
    for (const value of [undefined, 'true', null]) {
        const request = newRequest();
        const extension = request.extension.find(item => item.url === EXTENSIONS.allowPatientBucketChange);
        extension.valueBoolean = value;
        assert.throws(() => classifyRegistrationRequest(request), /explicit boolean/);
    }
    for (const mutate of [
        request => { request.type[0].coding[0].code = 'WRONG'; },
        request => { request.extension.find(item => item.url === EXTENSIONS.accessMode).valueCode = 'sometimes'; },
        request => { request.extension.find(item => item.url === EXTENSIONS.accessDuration).valueDuration.system = 'urn:not-ucum'; },
        request => {
            const bucket = request.extension.find(item => item.url === EXTENSIONS.informationBucket);
            request.extension.push(JSON.parse(JSON.stringify(bucket)));
        }
    ]) {
        const request = newRequest();
        mutate(request);
        assert.throws(() => classifyRegistrationRequest(request));
    }
});

test('existing-catalog registration inherits the canonical definition and rejects duplicates atomically', () => {
    const { store, sp, catalog } = fixture();
    const result = registerHealthcareService({
        store, callerOrganization: sp, request: existingRequest(), idGenerator: () => 'existing-instance',
        clock: () => new Date('2026-02-01T00:00:00.000Z')
    });
    assert.equal(result.mode, 'existing-catalog');
    assert.equal(result.canonical.id, catalog.id);
    assert.equal(serviceKind(result.instance), 'instance');
    assert.equal(businessStatus(result.instance), 'pending');
    assert.equal(result.instance.active, false);
    assert.deepEqual(result.instance.category, catalog.category);
    assert.deepEqual(result.instance.type, catalog.type);
    assert.equal(result.instance.name, catalog.name);
    assert.equal(result.instance.providedBy.reference, 'Organization/sp');
    assert.equal(result.instance.extension.find(item => item.url === EXTENSIONS.approvalWindow).valuePeriod.end, '2026-03-03T00:00:00.000Z');
    assert.throws(() => registerHealthcareService({
        store, callerOrganization: sp, request: existingRequest(), idGenerator: () => 'duplicate'
    }), error => error.status === 409);
    assert.equal(store.get('HealthcareService', 'duplicate'), null);
});

test('new-service registration atomically creates distinct pending catalog and instance identities', () => {
    const { store, sp } = fixture();
    const result = registerHealthcareService({
        store, callerOrganization: sp, request: newRequest(),
        idGenerator: (() => { const ids = ['catalog-created', 'instance-created']; return () => ids.shift(); })(),
        clock: () => new Date('2026-01-10T00:00:00.000Z')
    });
    assert.equal(result.mode, 'new-service');
    assert.equal(serviceKind(result.canonical), 'catalog');
    assert.equal(serviceKind(result.instance), 'instance');
    assert.equal(businessStatus(result.canonical), 'pending');
    assert.equal(businessStatus(result.instance), 'pending');
    assert.equal(result.canonical.active, false);
    assert.equal(result.instance.active, false);
    assert.notEqual(result.canonical.identifier[0].system, result.instance.identifier[0].system);
    assert.equal(result.instance.extension.filter(item => item.url === EXTENSIONS.allowPatientBucketChange).length, 1);
    assert.throws(() => registerHealthcareService({
        store, callerOrganization: sp, request: newRequest(), idGenerator: () => 'unused'
    }), error => error.status === 409);
    assert.equal(store.get('HealthcareService', 'unused'), null);
});

test('registration requires an operational Service Provider and an active canonical target', () => {
    const { store, parent, sp, other, catalog } = fixture();
    store.update({ ...parent, active: false });
    assert.throws(() => registerHealthcareService({
        store, callerOrganization: sp, request: existingRequest()
    }), error => error.status === 403);
    store.update({ ...parent, active: true });
    store.update({ ...catalog, active: false, extension: [
        statusExtension('suspended'),
        ...catalog.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)
    ] });
    assert.throws(() => registerHealthcareService({
        store, callerOrganization: other, request: existingRequest()
    }), /active, registrable/);
});

test('owner transition table is persisted, derives active, preserves approval window, and is idempotent', () => {
    for (const [from, to, allowed] of [
        ['pending', 'cancelled', true], ['pending', 'active', false], ['pending', 'suspended', false],
        ['active', 'suspended', true], ['active', 'cancelled', false],
        ['suspended', 'active', true], ['suspended', 'cancelled', true],
        ['cancelled', 'active', false], ['cancelled', 'suspended', false],
        ['frozen', 'active', false], ['rejected', 'cancelled', false]
    ]) {
        const { store, sp } = fixture();
        const start = store.add(instanceResource({ id: `${from}-${to}`, status: from }));
        const approval = start.extension.find(item => item.url === EXTENSIONS.approvalWindow);
        if (allowed) {
            const result = transitionHealthcareService({ store, callerOrganization: sp, existing: start, request: updateRequest(start.id, to) });
            assert.equal(businessStatus(result), to, `${from}->${to}`);
            assert.equal(result.active, to === 'active', `${from}->${to}`);
            assert.deepEqual(result.extension.find(item => item.url === EXTENSIONS.approvalWindow), approval);
        } else {
            assert.throws(() => transitionHealthcareService({
                store, callerOrganization: sp, existing: start, request: updateRequest(start.id, to)
            }), error => error instanceof HealthcareServiceLifecycleError && error.status === 409, `${from}->${to}`);
        }
    }
    const { store, sp } = fixture();
    const active = store.add(instanceResource({ id: 'same-active' }));
    const retry = transitionHealthcareService({ store, callerOrganization: sp, existing: active, request: updateRequest(active.id, 'active') });
    assert.equal(retry.meta.versionId, active.meta.versionId);
});

test('pending withdrawal cancels only its coupled pending canonical and cross-owner updates fail', () => {
    const { store, sp, other } = fixture();
    const request = newRequest();
    request.name = 'Unique Pending Service';
    const { canonical, instance } = registerHealthcareService({
        store, callerOrganization: sp, request,
        idGenerator: (() => { const ids = ['pending-catalog', 'pending-instance']; return () => ids.shift(); })()
    });
    assert.throws(() => transitionHealthcareService({
        store, callerOrganization: other, existing: instance, request: updateRequest(instance.id, 'cancelled')
    }), error => error.status === 403);
    transitionHealthcareService({ store, callerOrganization: sp, existing: instance, request: updateRequest(instance.id, 'cancelled') });
    assert.equal(businessStatus(store.get('HealthcareService', canonical.id)), 'cancelled');
    assert.equal(store.get('HealthcareService', canonical.id).active, false);
});

test('service operational state requires authoritative active instance and active canonical', () => {
    const { store, catalog } = fixture();
    const instance = store.add(instanceResource());
    assert.equal(serviceIsOperational(store, instance), true);
    store.update({ ...catalog, active: false, extension: [
        statusExtension('suspended'),
        ...catalog.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)
    ] });
    assert.equal(serviceIsOperational(store, store.get('HealthcareService', instance.id)), false);
});

test('all imported HealthcareService submit/response examples enter their authoritative contract path', () => {
    const files = fs.readdirSync(examples).filter(name => /^HealthcareService-.*\.json$/.test(name));
    assert.equal(files.length, 8);
    for (const file of files) {
        const resource = JSON.parse(fs.readFileSync(path.join(examples, file), 'utf8'));
        const profile = resource.meta?.profile?.[0] || '';
        if (profile.endsWith('pcm-system-healthcareservice')) {
            assert.equal(resource.meta.tag.filter(tag => tag.system === CODE_SYSTEMS.metaTag && tag.code === 'system-service').length, 1);
            continue;
        }
        if (profile.endsWith('-submit')) {
            assert.doesNotThrow(() => classifyRegistrationRequest(resource), file);
        } else {
            assert.deepEqual(validateSeedResource(resource), [], file);
            assert.ok(serviceKind(resource), file);
            const store = new FHIRStore();
            const persisted = store.add(resource);
            assert.deepEqual(store.get('HealthcareService', resource.id), persisted, file);
        }
    }
});

test('0.4.2 zero, one and plural taggedDetails survive registration, read and restored store', () => {
    const { SENSITIVITY_LABELS } = require('../../shared/information-buckets');
    for (const count of [0, 1, 2, SENSITIVITY_LABELS.length]) {
        const { store, sp } = fixture();
        const request = newRequest();
        const bucket = request.extension.find(part => part.url === EXTENSIONS.informationBucket);
        bucket.extension = bucket.extension.filter(part => part.url !== 'taggedDetails');
        const tags = SENSITIVITY_LABELS.slice(0, count).map(coding => ({ url: 'taggedDetails', valueCodeableConcept: { coding: [coding] } }));
        bucket.extension.push(...tags);
        const result = registerHealthcareService({ store, callerOrganization: sp, request });
        for (const resource of [result.canonical, result.instance]) {
            const restored = new FHIRStore(); restored.add(JSON.parse(JSON.stringify(store.get('HealthcareService', resource.id))));
            assert.deepEqual(restored.get('HealthcareService', resource.id).extension.find(part => part.url === EXTENSIONS.informationBucket).extension.filter(part => part.url === 'taggedDetails'), tags);
        }
    }
});

test('0.4.2 invalid bucket structure and sensitivity coding reject atomically', () => {
    for (const mutate of [
        parts => parts.push({ url: 'taggedDetails', valueCodeableConcept: { coding: [{ system: 'urn:unknown', code: 'HIV' }] } }),
        parts => parts.push({ url: 'taggedDetails', valueCodeableConcept: { coding: [{ system: 'http://fhir.health.gov.il/cs/il-core-sensitivity-labels', code: 'unknown' }] } }),
        parts => parts.push({ url: 'taggedDetails', valueCodeableConcept: { coding: [] } }),
        parts => parts.push({ url: 'taggedDetails', valueString: 'HIV' }),
        parts => parts.push(structuredClone(parts[0])),
        parts => parts.push(structuredClone(parts[1])),
        parts => parts.splice(0, 1),
        parts => parts.splice(1, 1)
    ]) {
        const { store, sp } = fixture(); const request = newRequest();
        mutate(request.extension.find(part => part.url === EXTENSIONS.informationBucket).extension);
        const before = store.getAll('HealthcareService');
        assert.throws(() => registerHealthcareService({ store, callerOrganization: sp, request }));
        assert.deepEqual(store.getAll('HealthcareService'), before);
    }
});
