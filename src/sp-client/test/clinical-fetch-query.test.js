'use strict';
/** Exact typed Patient lookup never falls back to an unfiltered population search. */
const test = require('node:test'), assert = require('node:assert/strict');
const { clinicalFetchQuery } = require('../src/clinical-fetch-query');
const { IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');
test('standard and ordinary identities preserve exact values and bounded query parameters', () => {
    for (const patient of [{ system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' }, { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' }]) {
        const query = new URL(`https://source.test/${clinicalFetchQuery('Patient', patient)}`);
        assert.equal(query.searchParams.get('identifier'), `${patient.system}|${patient.value}`);
        assert.equal(query.searchParams.get('_count'), '10'); assert.equal([...query.searchParams].length, 2);
    }
    assert.equal(clinicalFetchQuery('Observation', null), 'Observation?_count=10');
});
test('GUID lookup requires its explicit sandbox gate and preserves mixed casing', () => {
    const patient = { system: 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id', value: 'Ab123456-1234-5678-9012-000000000001' };
    assert.throws(() => clinicalFetchQuery('Patient', patient));
    assert.equal(new URL(`https://source.test/${clinicalFetchQuery('Patient', patient, { allowSandboxGuid: true })}`).searchParams.get('identifier'), `${patient.system}|${patient.value}`);
});
test('missing/malformed Patient context and invalid resource paths fail before a request', () => {
    for (const patient of [null, {}, { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000019' }]) assert.throws(() => clinicalFetchQuery('Patient', patient));
    for (const type of ['Patient/one', '../Patient', 'Patient?_count=100', 'patient']) assert.throws(() => clinicalFetchQuery(type, null));
});


test('read-only master scopes never dispatch search or fabricate an empty successful preview', () => {
    const { searchableScopeTypes } = require('../src/clinical-fetch-query');
    assert.deepEqual(searchableScopeTypes('patient/Patient.rs patient/Observation.s patient/Organization.r patient/Practitioner.r'), ['Patient', 'Observation']);
    for (const scope of ['patient/Organization.r patient/Practitioner.r', 'patient/Observation.r', '', 'system/Organization.r']) assert.throws(() => searchableScopeTypes(scope), /logical ID.*search permission/);
});

test('GET override preserves exact encoded suffixes and rejects rewritten or non-path input', () => {
    const { validateGetRequestOverride } = require('../src/clinical-fetch-query');
    for (const path of ['', '/', '/Patient', '/Patient/known-id', '/Observation?_summary=count', '/Observation?code=a%7Cb&code=c+d&_count=21']) {
        assert.equal(validateGetRequestOverride(path), path);
    }
    for (const path of [null, [], {}, 'Patient', 'https://elsewhere/Patient', '//elsewhere/Patient', ' /Patient', '/Patient ', '/Patient#ignored', '/Patient\\one', '/../Patient', '/%2e%2e/Patient']) {
        assert.throws(() => validateGetRequestOverride(path), /must start with/);
    }
});
