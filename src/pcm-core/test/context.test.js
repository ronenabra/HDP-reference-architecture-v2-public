/**
 * Tests for fhirContext helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthcareServiceContext, CATALOG_ID_SYSTEM } = require('../src/fhir/context');

test('buildHealthcareServiceContext uses catalog identifier from service', () => {
    const service = {
        id: 'svc-instance-1',
        identifier: [{
            system: CATALOG_ID_SYSTEM,
            value: 'PCM-CAT-123'
        }]
    };

    const result = buildHealthcareServiceContext(service);

    assert.deepEqual(result, {
        type: 'HealthcareService',
        identifier: {
            system: CATALOG_ID_SYSTEM,
            value: 'PCM-CAT-123'
        }
    });
});

test('buildHealthcareServiceContext falls back to canonical catalog identifier', () => {
    const service = { id: 'svc-instance-2' };
    const canonical = {
        id: 'svc-catalog-2',
        identifier: [{
            system: CATALOG_ID_SYSTEM,
            value: 'PCM-CAT-987'
        }]
    };

    const result = buildHealthcareServiceContext(service, canonical);

    assert.deepEqual(result, {
        type: 'HealthcareService',
        identifier: {
            system: CATALOG_ID_SYSTEM,
            value: 'PCM-CAT-987'
        }
    });
});

test('buildHealthcareServiceContext falls back to service id when no catalog identifier exists', () => {
    const service = { id: 'svc-instance-3' };

    const result = buildHealthcareServiceContext(service);

    assert.deepEqual(result, {
        type: 'HealthcareService',
        identifier: {
            system: CATALOG_ID_SYSTEM,
            value: 'svc-instance-3'
        }
    });
});
