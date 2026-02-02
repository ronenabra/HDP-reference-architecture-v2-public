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
    store.data.VerificationResult = new Map();
    store.data.Consent = new Map();
}

function addPcmOrg() {
    store.add({
        resourceType: 'Organization',
        id: 'org-pcm-system',
        active: true,
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'pcm' }] }]
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
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'parent-org' }] }]
    });

    const handler = getHandler('/Organization/:id', 'put');
    const res = createRes();
    handler({
        params: { id: 'org-target' },
        body: {
            id: 'org-target',
            active: false,
            name: 'Updated Org',
            type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] }]
        },
        user: { organization_id: 'org-pcm-system' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.name, 'Updated Org');
    assert.equal(res.body.type[0].coding[0].code, 'service-provider');
});
