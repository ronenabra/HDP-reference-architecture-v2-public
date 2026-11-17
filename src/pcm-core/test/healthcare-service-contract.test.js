require('../../../test-support/team-config').installTestRuntime();
/** Public HealthcareService routing and Consent service-reference tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/pcm-core-test-logs';

const store = require('../src/fhir/store');
const fhirRouter = require('../src/routes/fhir');
const { businessStatus, statusExtension } = require('../src/fhir/healthcare-service-lifecycle');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');

const examples = path.resolve(__dirname, '../../../docs/FHIR-examples');
const read = name => JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));
const CONSENT_SCOPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/consentscope';
const CONSENT_CATEGORY_ACT_CODE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';

function resetStore() {
    store.reset();
}

function getHandler(routePath, method) {
    const layer = fhirRouter.stack.find(item =>
        item.route && item.route.path === routePath && item.route.methods[method]);
    return layer?.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        type(value) { this.headers['content-type'] = value; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

function addOrg(id, role = 'service-provider') {
    if (role === 'pcm') {
        return store.add({
            resourceType: 'Organization', id, active: true,
            identifier: [{ use: 'official', system: 'http://institutions.health.gov.il/Institutions', value: 'PCM' }],
            type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'pcm' }] }]
        });
    }
    const parentId = `parent-${id}`;
    store.add({
        resourceType: 'Organization', id: parentId, active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-${parentId}` }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'parent-org' }] }]
    });
    return store.add({
        resourceType: 'Organization', id, active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-${id}` }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: role }] }],
        partOf: { reference: `Organization/${parentId}` }
    });
}

function addCatalog(id = 'catalog', status = 'active') {
    const catalog = read('HealthcareService-svc-catalog-cross-org-summary.json');
    catalog.id = id;
    catalog.identifier[0].value = `PCM-${id}`;
    catalog.extension = [statusExtension(status), ...catalog.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)];
    catalog.active = status === 'active';
    const saved = store.add(catalog);
    store.privateRecords.services.createDefinition({ serviceId: saved.id,
        ...require('../src/public-service-definition').definitionFromPublic(saved, new Date('2026-01-05T08:20:00Z')),
        expectedRevision: store.privateState.revision, expectedVersions: { [`HealthcareService/${saved.id}`]: saved.meta.versionId } });
    return saved;
}

function addInstance(id, owner, status = 'active', catalogId = 'catalog') {
    const instance = read('HealthcareService-svc-instance-hosp-a-cross-org-summary.json');
    instance.id = id;
    instance.identifier[0].value = `PCM-${id}`;
    instance.providedBy.reference = `Organization/${owner}`;
    instance.extension = [statusExtension(status), ...instance.extension
        .filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)
        .map(item => item.url === EXTENSIONS.basedOnCanonicalHealthcareService
            ? { ...item, valueReference: { reference: `HealthcareService/${catalogId}` } }
            : item)];
    instance.active = status === 'active';
    return store.add(instance);
}

function updateBody(id, status) {
    return { resourceType: 'HealthcareService', id, extension: [statusExtension(status)] };
}

test('HealthcareService search uses authoritative state and includes caller-owned inactive instances', () => {
    resetStore();
    addOrg('org-sp');
    addOrg('org-other');
    addCatalog('catalog-active');
    addCatalog('catalog-inactive', 'suspended');
    addInstance('instance-active-other', 'org-other', 'active', 'catalog-active');
    addInstance('instance-inactive-own', 'org-sp', 'suspended', 'catalog-active');
    addInstance('instance-inactive-other', 'org-other', 'suspended', 'catalog-active');

    const handler = getHandler('/HealthcareService', 'get');
    let res = createRes();
    handler({ query: {}, user: { organization_id: 'org-sp' }, protocol: 'https', get: () => 'pcm.test' }, res);
    assert.deepEqual(res.body.entry.map(entry => entry.resource.id).sort(), [
        'catalog-active', 'instance-active-other', 'instance-inactive-own'
    ]);
    res = createRes();
    handler({ query: { active: 'false' }, user: { organization_id: 'org-sp' }, protocol: 'https', get: () => 'pcm.test' }, res);
    assert.deepEqual(res.body.entry.map(entry => entry.resource.id), ['instance-inactive-own']);
});

test('HealthcareService routes implement both registration modes and persisted owner transitions', () => {
    resetStore();
    addOrg('org-sp');
    addCatalog('svc-catalog-cross-org-summary');
    const create = getHandler('/HealthcareService', 'post');
    let res = createRes();
    create({
        body: read('HealthcareService-svc-instance-hosp-a-cross-org-summary-submit.json'),
        user: { organization_id: 'org-sp' }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(businessStatus(res.body), 'pending');
    assert.equal(res.body.active, false);
    const instanceId = res.body.id;

    const pending = store.get('HealthcareService', instanceId);
    store.update({ ...pending, ...updateBody(instanceId, 'active'), active: true,
        extension: [statusExtension('active'), ...pending.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)] });
    const update = getHandler('/HealthcareService/:id', 'put');
    res = createRes();
    update({ params: { id: instanceId }, body: updateBody(instanceId, 'suspended'), user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(businessStatus(res.body), 'suspended');
    res = createRes();
    update({ params: { id: instanceId }, body: updateBody(instanceId, 'active'), user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.active, true);

    const request = read('HealthcareService-svc-instance-hosp-a-new-service-submit.json');
    request.name = 'Distinct New Service';
    res = createRes();
    create({ body: request, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(store.getAll('HealthcareService').filter(service => service.name === request.name).length, 2);
});

test('canonical PUT and client classification or definition smuggling return OperationOutcome without mutation', () => {
    resetStore();
    addOrg('org-sp');
    const catalog = addCatalog('catalog');
    const update = getHandler('/HealthcareService/:id', 'put');
    let res = createRes();
    update({ params: { id: catalog.id }, body: updateBody(catalog.id, 'suspended'), user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.resourceType, 'OperationOutcome');
    assert.equal(store.get('HealthcareService', catalog.id).active, true);

    const create = getHandler('/HealthcareService', 'post');
    res = createRes();
    create({
        body: { resourceType: 'HealthcareService', name: 'Direct', meta: { tag: [{ system: CODE_SYSTEMS.metaTag, code: 'catalog' }] } },
        user: { organization_id: 'org-sp' }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.resourceType, 'OperationOutcome');
});

function consentRequest(serviceId) {
    return {
        resourceType: 'Consent',
        status: 'proposed',
        scope: { coding: [{ system: CONSENT_SCOPE_SYSTEM, code: 'patient-privacy' }] },
        category: [{ coding: [{ system: CONSENT_CATEGORY_ACT_CODE_SYSTEM, code: 'INFA' }] }],
        patient: { identifier: { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' } },
        extension: [{ url: EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${serviceId}` } }],
        policy: [{
            authority: 'https://www.gov.il/',
            uri: 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024'
        }]
    };
}

test('Consent creation requires an operational instance and its active canonical', () => {
    resetStore();
    addOrg('org-sp');
    addCatalog('catalog');
    addInstance('active-instance', 'org-sp', 'active');
    addInstance('suspended-instance', 'org-sp', 'suspended');
    const handler = getHandler('/Consent', 'post');

    let res = createRes();
    handler({ body: consentRequest('suspended-instance'), user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.issue[0].diagnostics, /operational HealthcareService instance/);
    res = createRes();
    handler({ body: consentRequest('catalog'), user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.issue[0].diagnostics, /instance/);
    res = createRes();
    handler({ body: consentRequest('active-instance'), user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 201);
});

test('Consent creation validates fixed submit status, scope, and category', () => {
    resetStore();
    addOrg('org-sp');
    addCatalog('catalog');
    addInstance('active-instance', 'org-sp', 'active');
    const handler = getHandler('/Consent', 'post');
    const valid = consentRequest('active-instance');
    for (const [patch, diagnostic] of [
        [{ status: 'active' }, /status=proposed/],
        [{ scope: undefined }, /patient-privacy/],
        [{ category: undefined }, /fixed INFA/]
    ]) {
        const res = createRes();
        handler({ body: { ...valid, ...patch }, user: { organization_id: 'org-sp' } }, res);
        assert.equal(res.statusCode, 400);
        assert.match(res.body.issue[0].diagnostics, diagnostic);
    }
});

test('VerificationResult remains absent from routes and source state', () => {
    assert.equal(getHandler('/VerificationResult', 'get'), undefined);
    assert.equal(getHandler('/VerificationResult', 'post'), undefined);
    assert.equal(getHandler('/VerificationResult/:id', 'get'), undefined);
    assert.equal(store.data.VerificationResult, undefined);
});
