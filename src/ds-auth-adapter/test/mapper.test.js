require('../../../test-support/team-config').installTestRuntime({ patients: [], identityMapping: { businessIdOverrides: {} } });
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
// Each Node test worker owns its log rotation directory.
const testLogs = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ds-adapter-test-'));
process.env.LOG_DIR = testLogs;
test.after(() => fs.rmSync(testLogs, { recursive: true, force: true }));
const { mapIdentity, mapPatient, mapUnfilteredSimulation } = require('../src/mapper');
const { simulationStage } = require('../src/index');
const { SIMULATION_CONTROLS } = require('../../shared/conformance-policy');
const { validateIntrospectionResponse } = require('../src/introspection-contract');
const { IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');
const { AUDIENCE, ISSUER, NOW, common, dataSourceResponse, presenceResponse, item, patient } = require('../test-support/introspection-fixture');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

function keyFixture() {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'ds-mapper-'));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = path.join(tmp, 'local.key');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    return { tmp, keyPath, publicKey };
}

function withSigningKey(keyPath, fn) {
    const previous = process.env.LOCAL_JWT_SIGNING_KEY_PATH;
    process.env.LOCAL_JWT_SIGNING_KEY_PATH = keyPath;
    try { return fn(); } finally {
        if (previous === undefined) delete process.env.LOCAL_JWT_SIGNING_KEY_PATH;
        else process.env.LOCAL_JWT_SIGNING_KEY_PATH = previous;
    }
}

function context(hoId = 'ho-a', audience = AUDIENCE) {
    return validateIntrospectionResponse({ ...dataSourceResponse(), aud: audience }, {
        expectedIssuer: ISSUER, expectedAudience: audience, hoId, clock: () => NOW
    });
}

const requestBinding = Object.freeze({ method: 'GET', uri: '/fhir/Observation?status=final' });

test('every adapter authorization simulation control selects an explicit stage', () => {
    const enabled = Object.fromEntries(SIMULATION_CONTROLS.map(name => [name, true]));
    assert.equal(simulationStage(enabled), 'enforced');
    assert.equal(simulationStage({ ...enabled, oauthBearer: false }), 'enforced');
    for (const control of [
        'clientAssertionSignature', 'clientAssertionAudience', 'clientAssertionReplay',
        'clientAssertionExpiry', 'tokenResourceBinding', 'tokenAudience', 'tokenExpiry'
    ]) assert.equal(simulationStage({ ...enabled, [control]: false }), 'enforced', control);
    for (const control of ['consentState', 'serviceState', 'history', 'includes']) {
        assert.equal(simulationStage({ ...enabled, [control]: false }), 'enforced', control);
    }
    assert.equal(simulationStage({ ...enabled, resultFiltering: false }), 'enforced');
});

test('anonymous unfiltered context minting is retired even with a signing key', () => {
    const fixture = keyFixture();
    try { withSigningKey(fixture.keyPath, () => assert.throws(() => mapUnfilteredSimulation({
        hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', requestBinding, clock: () => NOW
    }), /retired|unsupported|disabled/i)); } finally { fs.rmSync(fixture.tmp, { recursive: true, force: true }); }
});

test('supplying a trusted Patient cannot restore the retired operation simulation path', () => {
    for (const uri of ['/fhir/Patient/$everything', '/fhir?_getpages=opaque.1.mac&_count=1']) {
        assert.throws(() => mapUnfilteredSimulation({ hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir',
            requestBinding: { method: 'GET', uri }, authentication: context().authentication,
            trustedPatient: { system: 'http://example.test/mrn', value: 'one' }, sourceExpiresAt: NOW + 30, clock: () => NOW }), /retired|unsupported|disabled/i);
    }
});

test('neither expired nor valid source deadlines can fabricate an unfiltered grant', () => {
    for (const sourceExpiresAt of [undefined, null, NaN, Infinity, '1700000001', NOW + 0.5, NOW, NOW - 1, NOW + 1, NOW + 30, NOW + 120]) {
        assert.throws(() => mapUnfilteredSimulation({ hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', requestBinding,
            trustedPatient: { system: 'urn:fixture', value: 'one' }, sourceExpiresAt, clock: () => NOW }), /retired|unsupported|disabled/i);
    }
});

test('typed contexts map to a closed HO-bound private JWT', () => {
    const fixture = keyFixture();
    try {
        withSigningKey(fixture.keyPath, () => {
            const token = mapIdentity(context(), {
                hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', clock: () => NOW,
                requestBinding
            });
            const payload = jwt.verify(token, fixture.publicKey, {
                algorithms: ['RS256'], issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', clockTimestamp: NOW
            });
            assert.equal(payload.schema, 'pcm-ds-local-token/5');
            assert.equal(payload.authorization_schema, 'pcm-ds-authorization-context/4');
            assert.equal(payload.ho_id, 'ho-a');
            assert.equal(payload.patient_identifier.value, '000000018');
            assert.equal(payload.consent_identifier.value, 'CONSENT-1');
            assert.equal(payload.healthcare_service_identifier.value, 'SERVICE-1');
            assert.deepEqual(payload.request_binding, requestBinding);
            assert.equal(payload.exp, NOW + 30);
        });
    } finally { fs.rmSync(fixture.tmp, { recursive: true, force: true }); }
});

test('Patient mapping is deterministic inside one HO and pairwise distinct between HOs', () => {
    const identifier = context().grant.patient;
    assert.equal(mapPatient(identifier, 'ho-a'), mapPatient(identifier, 'ho-a'));
    assert.notEqual(mapPatient(identifier, 'ho-a'), mapPatient(identifier, 'ho-b'));
});

test('configured overrides are used without consuming legacy raw patient fields', () => {
    const fixture = keyFixture();
    try {
        withSigningKey(fixture.keyPath, () => {
            const token = mapIdentity(context(), {
                hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', clock: () => NOW,
                requestBinding,
                identityOverrides: { 'http://fhir.health.gov.il/identifier/il-national-id|000000018': 'Patient/local-18' }
            });
            assert.equal(jwt.decode(token).patient, undefined);
            assert.equal(mapPatient(context().grant.patient, 'ho-a', { 'http://fhir.health.gov.il/identifier/il-national-id|000000018': 'Patient/local-18' }), 'Patient/local-18');
            assert.throws(() => mapIdentity({ active: true, patient: 'legacy', cnf: {} }, {
                hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir'
            }), /authorization-context\/4/);
        });
    } finally { fs.rmSync(fixture.tmp, { recursive: true, force: true }); }
});

test('mapping rejects a normalized context belonging to another HO', () => {
    assert.throws(() => mapIdentity(context('ho-b', 'https://ho-b.example.test/fhir'), {
        hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir'
    }), /another HO/);
});

test('mapping rejects missing bindings and ordinary resource POSTs', () => {
    assert.throws(() => mapIdentity(context(), {
        hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir'
    }), /request binding/);
    assert.throws(() => mapIdentity(context(), {
        hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir',
        requestBinding: { method: 'POST', uri: '/fhir/Observation' }
    }), /request binding/);
    const fixture = keyFixture();
    try {
        withSigningKey(fixture.keyPath, () => {
            assert.doesNotThrow(() => mapIdentity(context(), {
                hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir',
                requestBinding: { method: 'GET', uri: '/fhir?_getpages=opaque-1&_getpagesoffset=1' }
            }));
        });
    } finally { fs.rmSync(fixture.tmp, { recursive: true, force: true }); }
});

test('presence mapping permits only its exact online GET or batch root POST class', () => {
    const fixture = keyFixture();
    const system = patient.system;
    const online = validateIntrospectionResponse(presenceResponse(), { expectedIssuer: ISSUER, expectedAudience: AUDIENCE, hoId: 'ho-a', clock: () => NOW });
    const testSystem = IDENTIFIER_SYSTEMS.syntheticTest;
    const batch = validateIntrospectionResponse(presenceResponse([{ system: testSystem, value: '1' }, { system: testSystem, value: '2' }]), { expectedIssuer: ISSUER, expectedAudience: AUDIENCE, hoId: 'ho-a', clock: () => NOW });
    try {
        withSigningKey(fixture.keyPath, () => {
            const options = { hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', clock: () => NOW };
            assert.equal(jwt.decode(mapIdentity(online, {
                ...options, requestBinding: { method: 'GET', uri: '/fhir/Patient?identifier=x&_summary=count&_count=0' }
            })).kind, 'online-presence');
            assert.equal(jwt.decode(mapIdentity(batch, {
                ...options, requestBinding: { method: 'POST', uri: '/fhir' }
            })).kind, 'batch-presence');
            assert.equal(jwt.decode(mapIdentity(online, {
                ...options, requestBinding: { method: 'POST', uri: '/fhir' }
            })).kind, 'online-presence');
            assert.throws(() => mapIdentity(batch, {
                ...options, requestBinding: { method: 'GET', uri: '/fhir/Patient?identifier=x' }
            }), /request binding/);
        });
    } finally { fs.rmSync(fixture.tmp, { recursive: true, force: true }); }
});

test('PNA mapping cannot consume an Israeli value-only override or collide with an equal IL identifier', () => {
    const pna = { system: IDENTIFIER_SYSTEMS.palestinianNationalId, value: '000000018' };
    const il = { system: IDENTIFIER_SYSTEMS.israelNationalId, value: pna.value };
    const overrides = { [pna.value]: 'Patient/local-il' };
    assert.equal(mapPatient(il, 'ho-a', overrides), 'Patient/local-il');
    assert.notEqual(mapPatient(pna, 'ho-a', overrides), 'Patient/local-il');
    assert.notEqual(mapPatient(pna, 'ho-a', {}), mapPatient(il, 'ho-a', {}));
    assert.notEqual(mapPatient(pna, 'ho-a', {}), mapPatient(pna, 'ho-b', {}));
    assert.equal(mapPatient(pna, 'ho-a', { [`${pna.system}|${pna.value}`]: 'Patient/local-pna' }), 'Patient/local-pna');
});

test('clinical form search signs the unchanged external POST binding', () => {
    const fixture = keyFixture();
    try {
        withSigningKey(fixture.keyPath, () => {
            const requestBinding = { method: 'POST', uri: '/fhir/Observation/_search?code=a%7Cb&code=c%7Cd' };
            const token = mapIdentity(context(), { hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a',
                audience: 'urn:ho-a:fhir', requestBinding });
            assert.deepEqual(jwt.decode(token).request_binding, requestBinding);
        });
    } finally { fs.rmSync(fixture.tmp, { recursive: true, force: true }); }
});
