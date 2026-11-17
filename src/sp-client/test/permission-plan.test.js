'use strict';
/** Public service intent, complete OAuth grant and bounded query applicability boundaries. */
const test = require('node:test'), assert = require('node:assert/strict');
const { doctorPublicFixture } = require('../../../test-support/doctor-public-fixture');
const { servicePermissions, permissionSummary, planQueries, validateSelection, validateClinicalGrant, TYPES } = require('../src/permission-plan');
const { EXTENSIONS, CODE_SYSTEMS } = require('../../shared/pcm-contract');
test('pinned unmodified public service gives finite app intent, without promising a compiled grant', () => {
    const f = doctorPublicFixture(), summary = servicePermissions(f.canonical);
    assert.equal(summary.ceiling, 'patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs patient/MedicationRequest.rs patient/MedicationStatement.rs patient/MedicationAdministration.rs patient/MedicationDispense.rs');
    assert.equal(summary.duration, '6 months'); assert.equal(summary.access, 'continuous');
    assert.deepEqual(summary.historyInputs, ['laboratoryTests: 2 years', 'medications: 1 years']);
    assert.match(summary.message, /granted permissions are not yet obtained/);
    assert.equal(TYPES.length, 17);
    f.canonical.extension.push({ url: 'urn:pcm:sandbox:service-grant', valueString: 'arbitrary private garbage' });
    assert.equal(servicePermissions(f.canonical).ceiling, summary.ceiling);
});
test('missing and unknown categories are descriptive unknowns and retain explicit Patient context intent', () => {
    assert.equal(servicePermissions(null).ceiling, 'patient/Patient.rs');
    const service = { extension: [{ url: EXTENSIONS.informationBucket, extension: [{ url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code: 'future' }] } }] }] };
    assert.deepEqual(servicePermissions(service).unknown, ['future']);
    assert.equal(servicePermissions(service).ceiling, 'patient/Patient.rs');
});
test('allergy alias is deduplicated in the frozen order before encounter intent', () => {
    const buckets = ['encounterInformation', 'allergies', 'allergiesAndIntolerances'];
    const definition = { extension: buckets.map(code => ({ url: EXTENSIONS.informationBucket, extension: [{ url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code }] } }] })) };
    assert.equal(servicePermissions(definition).ceiling, 'patient/Patient.rs patient/AllergyIntolerance.rs patient/Encounter.rs');
});
test('valid filtered, different and read-only grants do not require Patient.rs or a private compiler exclusion', () => {
    const f = doctorPublicFixture(), summary = permissionSummary(f.scope);
    assert.equal(summary.usable, true);
    const plan = planQueries(summary, 'patient/Observation.rs patient/Condition.r patient/Patient.rs');
    assert.deepEqual(plan.searches.map(value => value.type), ['Observation']);
    assert.deepEqual(plan.skipped.map(value => value.outcome), ['skipped-read-only', 'not-granted']);
    for (const scope of ['patient/*.s', 'patient/Observation.c', 'system/Patient.s', 'patient/Organization.s', 'patient/Binary.r', 'patient/Observation.s?_filter=x', 'patient/Observation.s?subject=Patient/x', 'patient/Observation.s?date=ge2025-02-30']) assert.equal(permissionSummary(scope).usable, false, scope);
    for (const selection of ['patient/Observation.s?status=final', 'patient/Observation.rs patient/Observation.r', 'patient/*.rs', ' patient/Patient.r']) assert.throws(() => validateSelection(selection));
});
test('returned grants match exact public Consent/Patient/service while narrow or broader effective scope is allowed', () => {
    const f = doctorPublicFixture();
    assert.equal(validateClinicalGrant(f.response, f.consent, f.instance).scope, f.scope);
    for (const scope of ['patient/Observation.s', 'patient/Condition.r', 'patient/Patient.rs patient/Observation.rs']) assert.equal(validateClinicalGrant({ ...f.response, scope }, f.consent, f.instance).scope, scope);
    for (const index of [0, 1, 2]) {
        const response = structuredClone(f.response); response.authorization_details[0].fhirContext[index].identifier.value = '000000026';
        assert.throws(() => validateClinicalGrant(response, f.consent, f.instance));
    }
    assert.throws(() => validateClinicalGrant({ ...f.response, scope: 'patient/Observation.s?_filter=arbitrary' }, f.consent, f.instance));
});

test('added master types remain explicit read-only selections and never become search plans or wildcard members', () => {
    for (const type of ['PractitionerRole', 'Location']) {
        const scope = `patient/${type}.r?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V`;
        const summary = permissionSummary(scope);
        assert.equal(summary.usable, true);
        assert.deepEqual(planQueries(summary).searches, []);
        assert.equal(planQueries(summary).skipped[0].outcome, 'skipped-read-only');
        assert.equal(validateSelection(`patient/${type}.r`).usable, true);
        for (const invalid of [`patient/${type}.s`, `patient/${type}.rs`, `system/${type}.r`]) assert.throws(() => validateSelection(invalid));
        assert.ok(!permissionSummary('patient/*.rs').actions.some(action => action.type === type));
    }
});
