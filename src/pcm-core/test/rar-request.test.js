'use strict';

/** PCM-IG-040 wire parsing regressions; these do not claim runtime integration. */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
    BASIS_SYSTEMS, FORM_BYTES, RAR_BYTES, ROLE_BASE, TYPE,
    parseAuthorizationDetails, parseForm, parseScopeCeiling, parseUniqueJson, validateScenarioRequest
} = require('../src/rar-request');

/** Build the exact closed RAR object used in boundary tests. */
function rar(type = 'Consent', patients = []) {
    return JSON.stringify([{ type: TYPE, fhirContext: [
        { type, role: `${ROLE_BASE}authorization-basis`, identifier: { system: BASIS_SYSTEMS[type], value: 'business-identifier' } },
        ...patients.map(identifier => ({ type: 'Patient', role: `${ROLE_BASE}authorization-patient`, identifier }))
    ] }]);
}
const patient = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
const fails = (code, operation) => assert.throws(operation, error => error.code === code);

for (const [scenario, type, patients, scope, shape] of [
    ['consent-access', 'Consent', [], 'patient/Observation.rs patient/Condition.s', 'consent'],
    ['presence-check', 'Contract', [patient], 'system/Patient.s', 'patient-policy'],
    ['patient-authentication', 'Contract', [patient], 'patient/Patient.s', 'patient-policy'],
    ['dependent-discovery', 'Contract', [], 'system/Patient.s system/RelatedPerson.s', 'contract-only']
]) {
    test(`closed RAR shape and ceiling for ${scenario}`, () => {
        const parsed = parseAuthorizationDetails(rar(type, patients));
        assert.equal(parsed.shape, shape);
        assert.ok(validateScenarioRequest(parsed, scope, scenario).length);
        assert.equal(parsed.basis.identifier.value, 'business-identifier');
    });
}

test('form decoding happens exactly once and preserves repeated-field evidence', () => {
    const input = new URLSearchParams({ authorization_details: rar(), resource: 'https://ho.example/fhir', scope: 'patient/Patient.s' });
    const parsed = parseForm(input.toString());
    assert.equal(parseAuthorizationDetails(parsed.authorization_details).shape, 'consent');
    assert.equal(parseForm('value=%2526%2B+%26').value, '%26+ &');
    for (const field of ['scope', 'authorization_details', 'client_assertion', 'grant_type']) {
        fails('invalid_request', () => parseForm(`${field}=one&${field}=two`));
    }
    fails('invalid_target', () => parseForm('resource=one&res%6furce=two'));
    for (const input of ['x=%', 'x=%FF', 'x=%C0%AF', '=x', 'x', 'x=1&&y=2', '']) {
        fails('invalid_request', () => parseForm(input));
    }
    fails('invalid_request', () => parseForm(Buffer.from([120, 61, 0xff])));
});

test('decoded form limits count UTF-8 bytes and delimiters at the exact boundary', () => {
    const prefix = 'value=';
    const value = 'é'.repeat((FORM_BYTES - prefix.length) / 2);
    assert.equal(parseForm(`${prefix}${encodeURIComponent(value)}`).value, value);
    fails('invalid_request', () => parseForm(`${prefix}${encodeURIComponent(value)}a`));
    assert.equal(parseForm('a=' + 'x'.repeat(FORM_BYTES - 2)).a.length, FORM_BYTES - 2);
    fails('invalid_request', () => parseForm('a=' + 'x'.repeat(FORM_BYTES - 1)));
});

test('RAR decoded byte limit permits boundary whitespace but rejects one extra byte', () => {
    const valid = rar();
    assert.equal(parseAuthorizationDetails(valid.padEnd(RAR_BYTES)).shape, 'consent');
    fails('invalid_request', () => parseAuthorizationDetails(valid.padEnd(RAR_BYTES + 1)));
    const unicode = rar().replace('business-identifier', 'é'.repeat(128));
    const padding = RAR_BYTES - Buffer.byteLength(unicode);
    assert.equal(parseAuthorizationDetails(unicode + ' '.repeat(padding)).shape, 'consent');
    fails('invalid_request', () => parseAuthorizationDetails(unicode + ' '.repeat(padding + 1)));
});

test('JSON duplicate detection checks nested and escaped names without false string matches', () => {
    assert.deepEqual(parseUniqueJson('{"a":[{},[],{"x":"a, \\\"b\\\":3"}]}'), { a: [{}, [], { x: 'a, "b":3' }] });
    for (const text of ['{"type":1,"type":2}', '{"type":1,"ty\\u0070e":2}', '[{"id":{"value":1,"value":2}}]']) {
        fails('invalid_authorization_details', () => parseUniqueJson(text));
    }
    for (const text of ['{', '[1,]', '{"a":NaN}']) fails('invalid_authorization_details', () => parseUniqueJson(text));
    fails('invalid_authorization_details', () => parseUniqueJson('['.repeat(34) + '0' + ']'.repeat(34)));
    assert.deepEqual(parseUniqueJson('{"__proto__":1}'), JSON.parse('{"__proto__":1}'));
});

test('zero/multiple objects, unknown properties, roles and caller-derived fields are denied', () => {
    for (const value of [[], {}, null, [JSON.parse(rar())[0], JSON.parse(rar())[0]]]) {
        fails('invalid_authorization_details', () => parseAuthorizationDetails(JSON.stringify(value)));
    }
    for (const field of ['purpose', 'organization', 'scope', 'session', 'representative']) {
        const value = JSON.parse(rar());
        value[0][field] = 'caller-selected';
        fails('invalid_authorization_details', () => parseAuthorizationDetails(JSON.stringify(value)));
    }
    for (const type of ['RelatedPerson', 'HealthcareService', 'Group', '__proto__']) {
        const value = JSON.parse(rar());
        value[0].fhirContext[0].type = type;
        fails('invalid_authorization_details', () => parseAuthorizationDetails(JSON.stringify(value)));
    }
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar().replace('authorization-basis', 'consent')));
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Consent', [patient])));
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar().replace('business-identifier', 'x'.repeat(129))));
});

test('semantic duplicate patient identities and unsupported patient namespaces are denied', () => {
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Contract', [patient, { value: patient.value, system: patient.system }])));
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Contract', [{ ...patient, system: 'https://unknown.example/id' }])));
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Contract', [{ ...patient, value: '000000019' }])));
});

test('presence allows 100 distinct identities but never 101', () => {
    const patients = Array.from({ length: 100 }, (_, index) => ({
        system: 'http://hl7.org/fhir/sid/passport-USA', value: `P${String(index).padStart(7, '0')}`
    }));
    const input = rar('Contract', patients);
    assert.equal(parseAuthorizationDetails(input).patients.length, 100);
    fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Contract', [...patients, { ...patients[0], value: 'P1000000' }])));
});

test('scope ceilings reject prefilters, wildcards, mixed families and duplicate resources', () => {
    for (const scope of ['', ' patient/Patient.s', 'patient/Patient.s ', 'patient/Patient.s\n',
        'patient/Patient.s?identifier=x', 'patient/*.s', 'patient/Patient.crus', 'patient/Patient.s  patient/Condition.s',
        'patient/Patient.s system/RelatedPerson.s', 'patient/Patient.s patient/Patient.s', 'patient/Patient.r patient/Patient.s']) {
        fails('invalid_scope', () => parseScopeCeiling(scope));
    }
    fails('invalid_scope', () => parseScopeCeiling('patient/Invented.s', new Set(['Patient'])));
});

test('resolved scenarios retain their own cardinality, scope and identity restrictions', () => {
    const two = parseAuthorizationDetails(rar('Contract', [patient, { ...patient, value: '000000026' }]));
    fails('invalid_authorization_details', () => validateScenarioRequest(two, 'patient/Patient.s', 'patient-authentication'));
    fails('invalid_authorization_details', () => validateScenarioRequest(two, 'system/Patient.s system/RelatedPerson.s', 'dependent-discovery'));
    fails('invalid_scope', () => validateScenarioRequest(two, 'system/Patient.rs', 'presence-check'));
    const discovery = parseAuthorizationDetails(rar('Contract'));
    fails('invalid_scope', () => validateScenarioRequest(discovery, 'system/Patient.s', 'dependent-discovery'));
    fails('invalid_authorization_details', () => validateScenarioRequest(discovery, 'system/Patient.s', 'organizational-sharing'));
    const synthetic = parseAuthorizationDetails(rar('Contract', [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }]));
    assert.ok(validateScenarioRequest(synthetic, 'system/Patient.s', 'presence-check'));
    fails('invalid_authorization_details', () => validateScenarioRequest(synthetic, 'patient/Patient.s', 'patient-authentication'));
});

test('0.4.2 RAR accepts PNA IDs and recognized passports with an OAuth-only 128-character boundary', () => {
    for (const system of ['http://fhir.health.gov.il/identifier/pna-national-id', 'http://hl7.org/fhir/sid/passport-USA']) {
        for (const value of ['000000019', 'P'.repeat(128), 'é'.repeat(128)]) {
            const identifier = { system, value };
            assert.deepEqual(parseAuthorizationDetails(rar('Contract', [identifier])).patients, [identifier]);
        }
        fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Contract', [{ system, value: 'P'.repeat(129) }])));
    }
    for (const identifier of [
        { system: patient.system, value: '000000019' },
        { system: 'http://hl7.org/fhir/sid/passport-ZZZ', value: '123' },
        { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '01' }
    ]) fails('invalid_authorization_details', () => parseAuthorizationDetails(rar('Contract', [identifier])));
});
