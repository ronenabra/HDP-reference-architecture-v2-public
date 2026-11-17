'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');
const { PRESETS, buildEffectivePolicy } = require('../../shared/conformance-policy');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { CONTEXT_ROLES, NORMALIZED_SCHEMA, validateIntrospectionResponse } = require('../src/introspection-contract');
const { AUDIENCE, ISSUER, NOW, common, dataSourceResponse, presenceResponse, item, options, patient } = require('../test-support/introspection-fixture');

test('validates and normalizes all four closed response variants', () => {
    assert.deepEqual(validateIntrospectionResponse({ active: false }, options), { active: false });

    const access = validateIntrospectionResponse(dataSourceResponse(), options);
    assert.equal(access.schema, NORMALIZED_SCHEMA);
    assert.equal(access.kind, 'data-source-access');
    assert.deepEqual(access.grant.patient, patient);
    assert.equal(access.grant.consent.value, 'CONSENT-1');

    const online = validateIntrospectionResponse(presenceResponse(), options);
    assert.equal(online.kind, 'online-presence');
    assert.equal(online.grant.patient, null);
    assert.deepEqual(online.grant.presenceIdentifiers, [patient]);
    const batch = validateIntrospectionResponse(presenceResponse([patient, { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '2' }]), options);
    assert.equal(batch.kind, 'batch-presence');
    assert.equal(batch.grant.presenceIdentifiers.length, 2);
});

test('rejects every missing base field, unknown field, legacy field, and stale binding', () => {
    for (const field of ['active', 'scope', 'client_id', 'pcm_authentication_context', 'exp', 'iat', 'authorization_details', 'iss', 'aud', 'sub']) {
        const candidate = dataSourceResponse();
        delete candidate[field];
        assert.throws(() => validateIntrospectionResponse(candidate, options), /Invalid PCM introspection response/, field);
    }
    for (const extra of ['extra', 'patient', 'cnf']) {
        assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), [extra]: 'forbidden' }, options), /not allowed/);
    }
    assert.throws(() => validateIntrospectionResponse({ active: false, scope: 'leak' }, options), /not allowed/);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), iss: `${ISSUER}/` }, options), /issuer/);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), aud: 'https://ho-b.example.test/fhir' }, options), /audience/);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), sub: 'different-client' }, options), /equal sub/);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), exp: NOW }, options), /future integer/);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), iat: NOW + 1 }, options), /iat/);
});

test('accepts only an exact member of the bounded configured issuer set', () => {
    const internalIssuer = 'https://pcm.internal:3000';
    assert.equal(validateIntrospectionResponse(dataSourceResponse(), {
        ...options,
        acceptedIssuers: [ISSUER, internalIssuer]
    }).active, true);
    assert.equal(validateIntrospectionResponse({ ...dataSourceResponse(), iss: internalIssuer }, {
        ...options,
        acceptedIssuers: [ISSUER, internalIssuer]
    }).active, true);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), iss: `${internalIssuer}/` }, {
        ...options,
        acceptedIssuers: [ISSUER, internalIssuer]
    }), /configured PCM operational origin/);
});

test('rejects wrong nested shapes, roles, identifier systems, and cardinality', () => {
    const mutations = [
        value => { value.pcm_authentication_context.extra = true; },
        value => { value.pcm_authentication_context.correlation_verified = false; },
        value => { value.pcm_authentication_context.token_endpoint_mtls['x5t#S256'] = 'bad'; },
        value => { value.authorization_details[0].fhirContext[0].extra = true; },
        value => { value.authorization_details[0].fhirContext[0].role = CONTEXT_ROLES.Consent; },
        value => { value.authorization_details[0].fhirContext[1].identifier.system = IDENTIFIER_SYSTEMS.healthcareServiceInstance; },
        value => { value.authorization_details[0].fhirContext[2].identifier.value = ''; },
        value => { value.authorization_details[0].fhirContext.pop(); },
        value => { value.authorization_details[0].fhirContext[2] = value.authorization_details[0].fhirContext[1]; }
    ];
    for (const mutate of mutations) {
        const value = structuredClone(dataSourceResponse());
        mutate(value);
        assert.throws(() => validateIntrospectionResponse(value, options), /Invalid PCM introspection response/);
    }
});

test('presence variants reject cross-variant fields and scope/context disagreement', () => {
    const base = presenceResponse();
    assert.throws(() => validateIntrospectionResponse({ ...base, organization_id: `${IDENTIFIER_SYSTEMS.organization}#X` }, options));
    const wrongPatient = structuredClone(base);
    wrongPatient.authorization_details[0].fhirContext[1].identifier.value = '000000026';
    assert.throws(() => validateIntrospectionResponse(wrongPatient, options));
    assert.throws(() => validateIntrospectionResponse({ ...base, scope: base.scope + `,${IDENTIFIER_SYSTEMS.syntheticTest}|2` }, options));
    assert.throws(() => validateIntrospectionResponse({ ...base, fhirContext: [] }, options), /not allowed/);
});

test('every preset requires token and Patient context even with obsolete direct consumer switches', () => {
    for (const preset of PRESETS) {
        const selected = { ...options, controls: buildEffectivePolicy(buildTeamConfig({}, preset), {}).simulation.controls };
        const valid = dataSourceResponse();
        const context = validateIntrospectionResponse(valid, selected);
        assert.equal(context.active, true);
        assert.equal(context.grant.scope, valid.scope);
        assert.deepEqual(context.grant.patient, patient);
        for (const [control, mutate, diagnostic] of [
            ['tokenAudience', value => { value.aud = 'https://other-source.test/fhir'; }, /audience/],
            ['tokenExpiry', value => { value.exp = NOW - 1; value.iat = NOW - 60; }, /future integer/],
            ['patientMapping', value => { value.authorization_details[0].fhirContext = value.authorization_details[0].fhirContext.filter(item => item.type !== 'Patient'); }, /Invalid PCM introspection response/],
            ['patientIdentifier', value => { value.scope = 'patient/Patient.rs?identifier=urn:other|wrong'; }, /identity disagrees/]
        ]) {
            const value = dataSourceResponse();
            mutate(value);
            const before = structuredClone(value);
            assert.throws(() => validateIntrospectionResponse(value, selected), diagnostic, `${preset}: ${control}`);
            const obsolete = { ...selected, controls: { ...selected.controls, [control]: false } };
            assert.throws(() => validateIntrospectionResponse(value, obsolete), diagnostic, 'obsolete options cannot bypass required authority');
            assert.throws(() => validateIntrospectionResponse({ ...value, iss: 'https://forged.test' }, obsolete), /issuer/);
            assert.throws(() => validateIntrospectionResponse({ ...value, extra: true }, obsolete), /not allowed/);
            assert.deepEqual(value, before, 'rejection cannot silently repair the source response');
        }
    }
});

test('PNA OAuth response contexts preserve strings and enforce the PatientIdentifier 128 boundary', () => {
    for (const length of [128, 129]) {
        const response = dataSourceResponse();
        response.authorization_details[0].fhirContext.find(item => item.type === 'Patient').identifier = { system: IDENTIFIER_SYSTEMS.palestinianNationalId, value: '0'.repeat(length) };
        if (length === 128) assert.equal(validateIntrospectionResponse(response, options).grant.patient.value.length, length);
        else assert.throws(() => validateIntrospectionResponse(response, options), /128 characters/);
    }
});

test('selected source permits105 presence identities without creating a Patient compartment', () => {
    const { presenceResponse, options } = require('../test-support/introspection-fixture');
    const patients = Array.from({ length: 105 }, (_, index) => ({ system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: String(index + 1) }));
    const response = presenceResponse(patients);
    assert.throws(() => validateIntrospectionResponse(response, { ...options, presenceLimits: { maxPatients: 100 } }));
    const context = validateIntrospectionResponse(response, { ...options, presenceLimits: { maxPatients: 105 } });
    assert.equal(context.kind, 'batch-presence');
    assert.equal(context.grant.patient, null);
    assert.equal(context.grant.presenceIdentifiers.length, 105);
});

test('HTEST workflow contexts require exact private fixture enrollment and keep default synthetic rejection', () => {
    for (const value of ['1', '2']) for (const scenario of ['patient-authentication', 'dependent-discovery']) {
        const identity = { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value };
        const demographics = '_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics';
        const scope = scenario === 'patient-authentication' ? `patient/Patient.s?${demographics}`
            : `system/Patient.s?_has:RelatedPerson:patient:identifier=${identity.system}|${value}&${demographics} system/RelatedPerson.s?identifier=${identity.system}|${value}&${demographics}&_tag=http://fhir.health.gov.il/cs/il-hdp-resource-tags|hmo-dependent-discovery`;
        const response = { ...common(scope), authorization_details: [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access',
            purposeOfUse: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-authorization-scenario', code: scenario }], fhirContext: [
                { type: 'Contract', role: CONTEXT_ROLES.Consent, identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: `PCM-POLICY-${scenario === 'patient-authentication' ? 'PATIENT-AUTHENTICATION' : 'DEPENDENT-DISCOVERY'}-001` } },
                { type: scenario === 'patient-authentication' ? 'Patient' : 'RelatedPerson', role: `https://pcm.fhir.health.gov.il/fhir-context-role/${scenario === 'patient-authentication' ? 'authorization-patient' : 'discovery-representative'}`, identifier: identity }
            ] }] };
        assert.throws(() => validateIntrospectionResponse(response, options));
        assert.throws(() => validateIntrospectionResponse(response, { ...options, syntheticWorkflowFixtures: [{ ...identity, value: value === '1' ? '2' : '1' }] }));
        assert.equal(validateIntrospectionResponse(response, { ...options, syntheticWorkflowFixtures: [identity] }).kind, scenario);
        assert.throws(() => validateIntrospectionResponse({ ...response, syntheticWorkflowFixtures: [identity] }, options));
    }
});

test('simulation normalization requires explicit matching consumer configuration and retains null evidence', () => {
    const raw = dataSourceResponse();
    raw.pcm_authentication_context = { token_endpoint_mtls: null, client_assertion_signing: null, correlation_verified: false,
        simulation: { version: 'pcm-authentication-simulation/1', skipped: ['token-endpoint-mtls', 'client-assertion-signature'] } };
    const selected = { ...options, authenticationSimulation: { allowSimulation: true, allowMissingTransport: true }, controls: { clientAssertionSignature: false } };
    const context = validateIntrospectionResponse(raw, selected);
    assert.equal(context.authentication.correlationVerified, false);
    assert.equal(context.authentication.tokenEndpointMtlsThumbprint, null);
    assert.equal(context.authentication.clientAssertionSigningThumbprint, null);
    assert.throws(() => validateIntrospectionResponse(raw, options), /simulation/);
    assert.throws(() => validateIntrospectionResponse(raw, { ...selected, controls: { clientAssertionSignature: true } }), /simulation/);
});

test('exact patient wildcard retains source/Patient binding and literal bytes without accepting other wildcard forms', () => {
    const value = { ...dataSourceResponse(), scope: 'patient/*.rs' };
    const normalized = validateIntrospectionResponse(value, options);
    assert.equal(normalized.grant.scope, value.scope);
    assert.deepEqual(normalized.grant.patient, patient);
    for (const scope of ['patient/*.s', 'patient/*.cruds', 'patient/*.rs?status=final', ' patient/*.rs']) {
        assert.throws(() => validateIntrospectionResponse({ ...value, scope }, options), /Consent scope/);
    }
    assert.throws(() => validateIntrospectionResponse({ ...value, aud: 'https://unapproved.example/fhir' }, options), /audience/);
});
