'use strict';
/** One patient entry uses shared validation and exact typed identity semantics. */
const test = require('node:test'), assert = require('node:assert/strict');
const { patientChoice, ORDINARY, identifierTypes } = require('../src/patient-choice');
const { DEFAULT_PATIENT_ID_SYSTEM: national, SYNTHETIC_TEST_ID_SYSTEM: synthetic, SANDBOX_GUID_ID_SYSTEM: guid } = require('../../shared/identity-mapping');
const config = { conformance: { mode: 'connectathon', preset: 'connectathon-mtls' } };
test('manual entry retains leading zeros, typed choices and full-token precedence with whitespace', () => {
    assert.equal(patientChoice(' 000000018 ', national, config).value, '000000018');
    assert.equal(patientChoice(` ${national} | 000000018 `, synthetic, config).key, `${national}|000000018`);
    assert.equal(patientChoice(ORDINARY.idValue, ORDINARY.idSystem, config).synthetic, false);
    assert.match(ORDINARY.display, /unknown/i);
    for (const value of ['1', '2']) assert.equal(patientChoice(value, synthetic, config).synthetic, true);
    assert.throws(() => patientChoice('1', national, config), /nine digits/);
    assert.throws(() => patientChoice('01', synthetic, config), /exactly 1 or 2/);
    for (const input of ['', '000000019', '000000018|more']) assert.throws(() => patientChoice(input, national, config));
    assert.throws(() => patientChoice('urn:unknown|000000018', national, config), /subset/);
    assert.ok(identifierTypes().some(type => type.system === national));
});
test('GUID input is allowed only in the existing supported sandbox identity branch', () => {
    const value = 'C0FFEE00-1234-5678-9ABC-ABCDEF012345';
    assert.equal(patientChoice(value, guid, config).value, value);
    assert.throws(() => patientChoice(value, guid, { conformance: { mode: 'strict', preset: 'strict' } }), /connectathon/);
    assert.throws(() => patientChoice('00000000-0000-0000-0000-000000000000', guid, config), /non-nil/);
});
