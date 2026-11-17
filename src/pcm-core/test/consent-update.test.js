require('../../../test-support/team-config').installTestRuntime();
/** Public Consent deactivation route authorization and projection tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/pcm-core-consent-update-tests';

const store = require('../src/fhir/store');
const fhirRouter = require('../src/routes/fhir');
const { validateWriteRequest } = require('../src/fhir/contract');
const { consentBusinessStatus } = require('../src/fhir/consent-lifecycle');
const { CODE_SYSTEMS, IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');

const examples = path.resolve(__dirname, '../../../docs/FHIR-examples');
const read = name => JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));

function resetStore() {
    store.reset();
    store.add({
        resourceType: 'Organization', id: 'parent', active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'PCM-PARENT' }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'parent-org' }] }]
    });
    for (const id of ['org-sp', 'org-other']) store.add({
        resourceType: 'Organization', id, active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-${id}` }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }],
        partOf: { reference: 'Organization/parent' }
    });
}

function getConsentPutHandler() {
    const layer = fhirRouter.stack.find(item =>
        item.route && item.route.path === '/Consent/:id' && item.route.methods.put);
    return layer.route.stack.at(-1).handle;
}

function responseDouble() {
    return {
        statusCode: 200, body: null, headers: {},
        status(code) { this.statusCode = code; return this; },
        type(value) { this.headers['content-type'] = value; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

function lifecycleResources() {
    const parameters = read('Parameters-parameters-consent-hosp-a-lifecycle.json');
    return Object.fromEntries(parameters.parameter.map(parameter => [parameter.name, parameter.resource]));
}

test('requesting provider can terminally deactivate proposed or active Consent with the closed DTO', () => {
    for (const sourceName of ['created', 'approved']) {
        resetStore();
        const { deactivationRequest, [sourceName]: source } = lifecycleResources();
        source.provision.actor.find(actor => actor.role.coding[0].code === 'IRCP').reference.reference = 'Organization/org-sp';
        const existing = store.add(source);
        deactivationRequest.id = existing.id;
        const res = responseDouble();
        getConsentPutHandler()({
            params: { id: existing.id }, body: deactivationRequest,
            user: { organization_id: 'org-sp' }, protocol: 'https', get: () => 'pcm.test'
        }, res);
        assert.equal(res.statusCode, 200, sourceName);
        assert.equal(res.body.status, 'inactive', sourceName);
        assert.equal(consentBusinessStatus(res.body), 'service-provider-cancelled', sourceName);
        assert.equal(res.body.patient.identifier.value, source.patient.identifier.value, sourceName);
    }
});

test('deactivation rejects wrong owner, non-request states, malformed policy, and server-field smuggling', () => {
    resetStore();
    const { approved, deactivationRequest } = lifecycleResources();
    approved.provision.actor.find(actor => actor.role.coding[0].code === 'IRCP').reference.reference = 'Organization/org-sp';
    const existing = store.add(approved);
    deactivationRequest.id = existing.id;

    let res = responseDouble();
    getConsentPutHandler()({
        params: { id: existing.id }, body: deactivationRequest,
        user: { organization_id: 'org-other' }
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.resourceType, 'OperationOutcome');

    const wrongPolicy = JSON.parse(JSON.stringify(deactivationRequest));
    wrongPolicy.policy[0].uri = 'https://example.invalid/policy';
    res = responseDouble();
    getConsentPutHandler()({ params: { id: existing.id }, body: wrongPolicy, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 400);

    assert.throws(() => validateWriteRequest({
        ...deactivationRequest,
        patient: approved.patient
    }, { resourceType: 'Consent', interaction: 'update', id: existing.id }), /Unsupported Consent field/);
});

test('terminal Consent cannot reactivate and PCM admin has no public full-resource update bypass', () => {
    resetStore();
    const { deactivated, deactivationRequest } = lifecycleResources();
    deactivated.provision.actor.find(actor => actor.role.coding[0].code === 'IRCP').reference.reference = 'Organization/org-sp';
    const existing = store.add(deactivated);
    deactivationRequest.id = existing.id;
    let res = responseDouble();
    getConsentPutHandler()({ params: { id: existing.id }, body: deactivationRequest, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.versionId, existing.meta.versionId);

    store.add({
        resourceType: 'Organization', id: 'org-pcm-system', active: true,
        identifier: [{ use: 'official', system: 'http://institutions.health.gov.il/Institutions', value: 'PCM' }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'pcm' }] }]
    });
    res = responseDouble();
    getConsentPutHandler()({ params: { id: existing.id }, body: deactivationRequest, user: { organization_id: 'org-pcm-system' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.resourceType, 'OperationOutcome');
});
