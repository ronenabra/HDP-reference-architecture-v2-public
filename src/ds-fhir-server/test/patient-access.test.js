/**
 * Tests for built-in mock FHIR patient mapping enforcement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    allowedMappedPatientSubjects,
    cloneOperationOutcome,
    isMappedPatientEnforcementEnabled,
    isPatientContextResolved
} = require('../src/patient-access');

test('Patient mapping cannot be disabled by an empty or obsolete configuration', () => {
    assert.equal(isMappedPatientEnforcementEnabled({}), true);
    assert.equal(isMappedPatientEnforcementEnabled({ security: { dsFhirServer: { enforceMappedPatients: false } } }), true);
    assert.equal(isPatientContextResolved('Patient/any-local-id', {}), false);
});

test('configured patients are allowed as local patient subjects when enforcement is enabled', () => {
    const config = {
        security: { dsFhirServer: { enforceMappedPatients: true } },
        patients: [
            {
                idSystem: 'http://example.org/patient-id',
                idValue: '000000018',
                display: 'Connectathon Patient'
            }
        ]
    };

    assert.deepEqual([...allowedMappedPatientSubjects(config)], ['Patient/local-000000018']);
    assert.equal(isPatientContextResolved('Patient/local-000000018', config), true);
    assert.equal(isPatientContextResolved('Patient/unmapped', config), false);
});

test('explicit identity mapping overrides take precedence over patient defaults', () => {
    const config = {
        security: { dsFhirServer: { enforceMappedPatients: true } },
        patients: [{ idValue: '000000018' }],
        identityMapping: {
            businessIdOverrides: {
                'http://fhir.health.gov.il/identifier/il-national-id|000000018': 'custom-local-id'
            }
        }
    };

    assert.deepEqual([...allowedMappedPatientSubjects(config)], ['custom-local-id']);
    assert.equal(isPatientContextResolved('custom-local-id', config), true);
    assert.equal(isPatientContextResolved('Patient/local-000000018', config), false);
});

test('unresolved patient operation outcome matches the configured security error', () => {
    assert.deepEqual(cloneOperationOutcome(), {
        resourceType: 'OperationOutcome',
        issue: [
            {
                severity: 'error',
                code: 'security',
                details: {
                    coding: [
                        {
                            system: 'http://fhir.health.gov.il/CodeSystem/operation-outcome-codes',
                            code: 'patient-context-unresolved',
                            display: 'Patient context could not be resolved'
                        }
                    ],
                    text: 'The patient context in the access token could not be resolved to a Patient record on this FHIR server.'
                },
                diagnostics: 'The access token is valid for this server, but the patient context is no longer resolvable. The service provider should contact PCM/support out of band.'
            }
        ]
    });
});

test('legacy Observation capability rejects all presence/workflow contexts even with filters disabled', () => {
    const { permitsClinicalContext, localPatientReference } = require('../src/patient-access');
    for (const kind of ['online-presence', 'batch-presence', 'patient-authentication', 'dependent-discovery', 'sandbox-patient-sample']) assert.equal(permitsClinicalContext({ kind }), false);
    for (const kind of ['data-source-access', 'unfiltered-simulation']) assert.equal(permitsClinicalContext({ kind }), false);
    assert.equal(localPatientReference({ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }, 'legacy-ds', { patients: [{ idValue: '000000018' }] }), 'Patient/local-000000018');
});
