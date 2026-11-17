'use strict';
/** Lookup syntax and trusted login eligibility are deliberately separate surfaces. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePatientIdentifier, isPatientLoginEligible, getEffectiveBusinessIdOverrides,
    DEFAULT_PATIENT_ID_SYSTEM: IL, PALESTINIAN_NATIONAL_ID_SYSTEM: PNA,
    SYNTHETIC_TEST_ID_SYSTEM: TEST, SANDBOX_GUID_ID_SYSTEM: GUID } = require('../../shared/identity-mapping');
const USA = 'http://hl7.org/fhir/sid/passport-USA';

test('lookup acceptance never infers foreign passport login eligibility or nationality', () => {
    for (const system of [IL, PNA, USA, 'http://hl7.org/fhir/sid/passport-ISR', TEST]) {
        const identifier = { system, value: system === TEST ? '1' : '000000018' };
        assert.equal(normalizePatientIdentifier(identifier).system, system);
        assert.equal(isPatientLoginEligible(identifier), [IL, PNA].includes(system));
    }
    const passport = { system: USA, value: '00123' };
    assert.equal(isPatientLoginEligible(passport, { foreignPassportEligible: true }), false);
    assert.equal(isPatientLoginEligible(passport, { foreignPassportEligible: true, israeliNationalWithId: false }), true);
    assert.equal(isPatientLoginEligible(passport, { foreignPassportEligible: true, israeliNationalWithId: true }), false);
    assert.equal(isPatientLoginEligible({ ...passport, system: 'http://hl7.org/fhir/sid/passport-ISR' }, { foreignPassportEligible: true, israeliNationalWithId: false }), false);
    const guid = { system: GUID, value: '12345678-1234-1234-1234-123456789abc' };
    assert.equal(normalizePatientIdentifier(guid, { allowSandboxGuid: true }).value, guid.value);
    assert.equal(isPatientLoginEligible(guid), false);
    for (const value of ['1', '2']) assert.equal(isPatientLoginEligible({ system: TEST, value }), false);
});

test('local mapping preserves namespaces and refuses ambiguous shared local targets', () => {
    const patients = [{ idSystem: IL, idValue: '000000018' }, { idSystem: PNA, idValue: '000000018' }];
    assert.throws(() => getEffectiveBusinessIdOverrides({ patients }), /Ambiguous/);
    const mapped = getEffectiveBusinessIdOverrides({ patients, identityMapping: { businessIdOverrides: { [`${PNA}|000000018`]: 'Patient/pna-18' } } });
    assert.equal(mapped['000000018'], 'Patient/local-000000018');
    assert.equal(mapped[`${PNA}|000000018`], 'Patient/pna-18');
});

test('entitled HTEST lookup fixtures retain exact synthetic 1/2 identities without authorizing login', () => {
    const { dataGrantFixture, rar } = require('../../../test-support/data-grants');
    const { resolveGrant } = require('../src/data-grant');
    const f = dataGrantFixture();
    // These are explicitly fabricated HMO lookup fixtures, not authenticated people.
    const patients = ['1', '2'].map(value => ({ resourceType: 'Patient', id: `htest-${value}`,
        meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] },
        identifier: [{ system: TEST, value }] }));
    const identities = patients.map(patient => patient.identifier[0]);
    f.config.systemAuthorization.presenceEligiblePatients = identities;
    const clientId = f.config.oauthClients.presenceOrchestrator.clientId;
    const input = { ...f.request, client: { clientId }, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', identities), scope: 'system/Patient.s' };
    const grant = resolveGrant(input);
    assert.deepEqual(grant.authorization_details[0].fhirContext.filter(item => item.type === 'Patient').map(item => item.identifier), identities);
    assert.equal(grant.scope, `system/Patient.s?identifier=${identities.map(item => `${item.system}|${item.value}`).join(',')}&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics`);
    for (const patient of patients) {
        assert.equal(patient.meta.security[0].code, 'HTEST');
        assert.equal(normalizePatientIdentifier(patient.identifier[0]).synthetic, true);
        assert.equal(isPatientLoginEligible(patient.identifier[0]), false);
    }
    assert.throws(() => resolveGrant({ ...input, client: f.request.client }), /unavailable/);
    f.config.systemAuthorization.presenceEligiblePatients = [identities[0]];
    assert.throws(() => resolveGrant(input), /unavailable/);
    for (const value of ['01', '3']) assert.throws(() => rar('Contract', 'PCM-POLICY-PRESENCE-001', [{ system: TEST, value }]));
});
