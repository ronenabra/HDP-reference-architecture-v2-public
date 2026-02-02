/**
 * Tests for PCM in-memory FHIR store.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/fhir/store');

const EXT_PCM_SERVICE = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service';
const EXT_APPLICABLE_CERTS = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates';

function resetStore() {
    store.data.Organization = new Map();
    store.data.Endpoint = new Map();
    store.data.HealthcareService = new Map();
    store.data.VerificationResult = new Map();
    store.data.Consent = new Map();
}

test('FHIRStore search supports common parameters', () => {
    resetStore();

    const org = {
        resourceType: 'Organization',
        id: 'org-1',
        active: true,
        name: 'Hospital A',
        type: [{ coding: [{ system: 'http://fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] }]
    };

    const endpoint = {
        resourceType: 'Endpoint',
        id: 'ep-1',
        address: 'https://example.org/fhir',
        extension: [{
            url: EXT_APPLICABLE_CERTS,
            extension: [{ url: 'thumbprint', valueString: 'thumb-123' }]
        }]
    };

    const service = {
        resourceType: 'HealthcareService',
        id: 'svc-1',
        active: true,
        name: 'Summary',
        category: [{ coding: [{ code: '35' }] }],
        type: [{ coding: [{ code: 'INFA' }] }],
        providedBy: { reference: 'Organization/org-1' }
    };

    const consent = {
        resourceType: 'Consent',
        id: 'consent-1',
        status: 'active',
        patient: { identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '123' } },
        extension: [{ url: EXT_PCM_SERVICE, valueReference: { reference: 'HealthcareService/svc-1' } }]
    };

    store.add(org);
    store.add(endpoint);
    store.add(service);
    store.add(consent);

    assert.equal(store.search('Organization', { type: 'service-provider' }).length, 1);
    assert.equal(store.search('Organization', { name: 'Hospital' }).length, 1);
    assert.equal(store.search('Endpoint', { thumbprint: 'thumb-123' }).length, 1);
    assert.equal(store.search('HealthcareService', { providedBy: 'Organization/org-1' }).length, 1);
    assert.equal(store.search('HealthcareService', { category: '35' }).length, 1);
    assert.equal(store.search('Consent', { status: 'active' }).length, 1);
    assert.equal(store.search('Consent', { 'patient.identifier': 'http://fhir.health.gov.il/identifier/il-national-id|123' }).length, 1);
    assert.equal(store.search('Consent', { patient: 'http://fhir.health.gov.il/identifier/il-national-id|123' }).length, 1);
    assert.equal(store.search('Consent', { 'pcm-service': 'HealthcareService/svc-1' }).length, 1);
});
