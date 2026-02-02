/**
 * Tests for Consent update authorization rules.
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

function getConsentPutHandler() {
    const layer = fhirRouter.stack.find(l =>
        l.route && l.route.path === '/Consent/:id' && l.route.methods.put
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

test('Consent update allows requestor to set status=inactive only', () => {
    resetStore();
    const consent = {
        resourceType: 'Consent',
        id: 'consent-1',
        status: 'proposed',
        provision: {
            actor: [
                {
                    role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] },
                    reference: { reference: 'Organization/org-sp' }
                }
            ]
        }
    };
    store.add(consent);

    const handler = getConsentPutHandler();
    const req = {
        params: { id: 'consent-1' },
        body: { id: 'consent-1', status: 'inactive' },
        user: { organization_id: 'org-sp' }
    };
    const res = createRes();

    handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'inactive');
    assert.equal(store.get('Consent', 'consent-1').status, 'inactive');
});

test('Consent update rejects non-requestor and non-inactive status', () => {
    resetStore();
    const consent = {
        resourceType: 'Consent',
        id: 'consent-2',
        status: 'active',
        provision: {
            actor: [
                {
                    role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] },
                    reference: { reference: 'Organization/org-sp' }
                }
            ]
        }
    };
    store.add(consent);

    const handler = getConsentPutHandler();

    const resWrongOrg = createRes();
    handler({
        params: { id: 'consent-2' },
        body: { id: 'consent-2', status: 'inactive' },
        user: { organization_id: 'org-other' }
    }, resWrongOrg);
    assert.equal(resWrongOrg.statusCode, 403);

    const resBadStatus = createRes();
    handler({
        params: { id: 'consent-2' },
        body: { id: 'consent-2', status: 'active' },
        user: { organization_id: 'org-sp' }
    }, resBadStatus);
    assert.equal(resBadStatus.statusCode, 403);
});

test('Consent update allows PCM admin to modify full resource', () => {
    resetStore();
    addPcmOrg();
    const consent = {
        resourceType: 'Consent',
        id: 'consent-3',
        status: 'active'
    };
    store.add(consent);

    const handler = getConsentPutHandler();
    const res = createRes();
    handler({
        params: { id: 'consent-3' },
        body: { id: 'consent-3', status: 'inactive', note: [{ text: 'Admin update' }] },
        user: { organization_id: 'org-pcm-system' }
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'inactive');
    assert.equal(res.body.note[0].text, 'Admin update');
});
