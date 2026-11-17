require('../../../test-support/team-config').installTestRuntime();
/**
 * Tests for PCM admin authorization rules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/fhir/store');
const fhirRouter = require('../src/routes/fhir');

function resetStore() {
    store.data.Organization = new Map();
    store.data.Endpoint = new Map();
    store.data.HealthcareService = new Map();
    store.data.Consent = new Map();
}

function addPcmOrg() {
    store.add({
        resourceType: 'Organization',
        id: 'org-pcm-system',
        active: true,
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'pcm' }] }]
    });
}

function getHandler(path, method) {
    const layer = fhirRouter.stack.find(l =>
        l.route && l.route.path === path && l.route.methods[method]
    );
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

test('PCM admin can update organization fields', () => {
    resetStore();
    addPcmOrg();
    store.add({
        resourceType: 'Organization',
        id: 'org-target',
        active: true,
        name: 'Target Org',
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'parent-org' }] }]
    });

    const handler = getHandler('/Organization/:id', 'put');
    const res = createRes();
    handler({
        params: { id: 'org-target' },
        body: {
            id: 'org-target',
            active: false,
            name: 'Updated Org',
            type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] }]
        },
        user: { organization_id: 'org-pcm-system' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, 'Updated Org');
    assert.equal(res.body.type[0].coding[0].code, 'service-provider');
});

test('source Organization and Endpoint reads are limited to sources selected on active consent', () => {
    resetStore();
    store.add({
        resourceType: 'Organization',
        id: 'org-sp',
        active: true,
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] }]
    });
    for (const id of ['selected', 'unselected']) {
        store.add({
            resourceType: 'Organization',
            id: `org-${id}`,
            active: true,
            name: id,
            type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'source' }] }],
            endpoint: [{ reference: `Endpoint/endpoint-${id}` }]
        });
        store.add({
            resourceType: 'Endpoint',
            id: `endpoint-${id}`,
            status: 'active',
            address: `https://${id}.example/fhir`,
            managingOrganization: { reference: `Organization/org-${id}` }
        });
    }
    store.add({
        resourceType: 'Consent',
        id: 'consent-1',
        status: 'active',
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status',
            valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-consent-business-status', code: 'active' }
        }],
        provision: {
            period: { start: '2020-01-01T00:00:00Z', end: '2030-01-01T00:00:00Z' },
            actor: [
                { role: { coding: [{ code: 'IRCP' }] }, reference: { reference: 'Organization/org-sp' } },
                { role: { coding: [{ code: 'CST' }] }, reference: { reference: 'Organization/org-selected' } }
            ]
        }
    });

    const orgHandler = getHandler('/Organization/:id', 'get');
    const endpointHandler = getHandler('/Endpoint/:id', 'get');

    let res = createRes();
    orgHandler({ params: { id: 'org-selected' }, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 200);

    res = createRes();
    orgHandler({ params: { id: 'org-unselected' }, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 404);

    res = createRes();
    endpointHandler({ params: { id: 'endpoint-selected' }, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 200);

    res = createRes();
    endpointHandler({ params: { id: 'endpoint-unselected' }, user: { organization_id: 'org-sp' } }, res);
    assert.equal(res.statusCode, 404);
});
