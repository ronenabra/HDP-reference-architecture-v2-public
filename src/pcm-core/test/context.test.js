/**
 * Tests for fhirContext helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthcareServiceContext, CATALOG_ID_SYSTEM, INSTANCE_ID_SYSTEM } = require('../src/fhir/context');

test('buildHealthcareServiceContext uses instance identifier from service', () => {
    const service = {
        id: 'svc-instance-1',
        identifier: [{
            system: INSTANCE_ID_SYSTEM,
            value: 'PCM-HS-INST-123'
        }]
    };

    const result = buildHealthcareServiceContext(service);

    assert.deepEqual(result, {
        type: 'HealthcareService',
        identifier: {
            system: INSTANCE_ID_SYSTEM,
            value: 'PCM-HS-INST-123'
        }
    });
});

test('buildHealthcareServiceContext prefers instance identifier over canonical catalog identifier', () => {
    const service = {
        id: 'svc-instance-2',
        identifier: [{
            system: INSTANCE_ID_SYSTEM,
            value: 'PCM-HS-INST-987'
        }]
    };
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
            system: INSTANCE_ID_SYSTEM,
            value: 'PCM-HS-INST-987'
        }
    });
});

test('buildHealthcareServiceContext falls back to service id when no instance identifier exists', () => {
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
            system: INSTANCE_ID_SYSTEM,
            value: 'svc-instance-2'
        }
    });
});

test('buildHealthcareServiceContext falls back to canonical id only when service is missing', () => {
    const canonical = { id: 'svc-catalog-3' };

    const result = buildHealthcareServiceContext(null, canonical);

    assert.deepEqual(result, {
        type: 'HealthcareService',
        identifier: {
            system: INSTANCE_ID_SYSTEM,
            value: 'svc-catalog-3'
        }
    });
});
