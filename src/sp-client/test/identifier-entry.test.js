'use strict';
/** Manual namespaces use shared policy and backend rejection cannot reuse a chosen patient. */
const test = require('node:test'), assert = require('node:assert/strict');
const { patientChoice, patientErrorField } = require('../src/patient-choice');
const m = require('../../shared/identity-mapping');
const national = m.DEFAULT_PATIENT_ID_SYSTEM, passport = 'http://hl7.org/fhir/sid/passport-USA', guid = m.SANDBOX_GUID_ID_SYSTEM;
const config = preset => ({ conformance: { mode: 'connectathon', preset } });

test('manual namespaces retain exact bytes, full-token precedence and the exact test exception', () => {
    for (const [system, value] of [[national, '000000018'], [m.PALESTINIAN_NATIONAL_ID_SYSTEM, '00123'], [passport, '00AbC'], [m.SYNTHETIC_TEST_ID_SYSTEM, '1'], [m.SYNTHETIC_TEST_ID_SYSTEM, '2']]) {
        const result = patientChoice(` ${value} `, ` ${system} `, config('strict'));
        assert.equal(result.key, `${system}|${value}`);
        assert.equal(result.synthetic, system === m.SYNTHETIC_TEST_ID_SYSTEM);
    }
    for (const value of ['1', '2']) assert.equal(patientChoice(value, passport, config('strict')).synthetic, false);
    assert.equal(patientChoice(` ${passport} | 00AbC `, national, config('strict')).key, `${passport}|00AbC`);
    assert.equal(patientChoice(`${national}|000000018`, '', config('strict')).system, national);
    assert.equal(patientChoice(' | 000000018 ', national, config('strict')).system, national);
    for (const [system, value, field] of [['', '000000018', 'system'], ['  ', '1', 'system'], ['urn:unknown', '000000018', 'system'], [passport.toLowerCase(), '1', 'system'], [national, '000000019', 'value'], [national, '', 'value'], [national, '   ', 'value'], [m.SYNTHETIC_TEST_ID_SYSTEM, '01', 'value']]) {
        assert.throws(() => patientChoice(value, system, config('strict')), error => patientErrorField(error) === field);
    }
    assert.throws(() => patientChoice('urn:unknown|000000018', national, config('strict')), /subset/);
});

test('GUID casing and preset fences remain in the shared validator', () => {
    const value = 'C0FFEE00-1234-5678-9ABC-ABCDEF012345';
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) assert.equal(patientChoice(value, guid, config(preset)).value, value);
    for (const value of ['00000000-0000-0000-0000-000000000000', 'not-a-guid']) assert.throws(() => patientChoice(value, guid, config('connectathon-easy')), /non-nil/);
    assert.throws(() => patientChoice(value, guid, config('strict')), /connectathon/);
    assert.throws(() => patientChoice(value, guid, { conformance: { mode: 'strict' } }), /connectathon/);
});

test('actual selection/create routes reject missing or unsupported systems without participant create', async () => {
    const fixture = await require('../../../test-support/doctor-public-server').startDoctorPublicServer();
    try {
        const post = (route, data) => fetch(fixture.doctorBase + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: 'hospital-a', ...data }), redirect: 'manual' });
        const valid = await (await post('/selection', { patientId: '000000018', patientSystem: national })).json();
        assert.equal(valid.patient.value, '000000018');
        for (const patientSystem of ['', 'urn:unknown', national.toUpperCase()]) {
            const data = { patientId: '000000018', patientSystem, serviceId: fixture.instance.id };
            const result = await (await post('/selection', data)).json();
            assert.equal(result.patient, null); assert.equal(result.patientField, 'system'); assert.ok(result.patientError);
            const before = fixture.requests.length;
            assert.equal((await post('/create-consent', data)).status, 302);
            assert.equal(fixture.requests.length, before);
        }
        const full = await (await post('/selection', { patientId: `${passport}|001aB`, patientSystem: national })).json();
        assert.deepEqual(full.patient, { system: passport, value: '001aB', automaticTestApproval: false });
        assert.equal(fixture.consents.size, 2); assert.deepEqual(fixture.violations, []);
    } finally { await fixture.close(); }
});
