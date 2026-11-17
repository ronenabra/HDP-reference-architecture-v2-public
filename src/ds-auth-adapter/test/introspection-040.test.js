'use strict';

/** Validate all four current enriched grant variants before private-context mapping. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { NOW, dataGrantFixture, rar } = require('../../../test-support/data-grants');
const { resolveGrant } = require('../../pcm-core/src/data-grant');
const { validateIntrospectionResponse, NORMALIZED_SCHEMA } = require('../src/introspection-contract');

/** Build an authentic PCM grant and its public projection without relying on legacy fixtures. */
function responseFor(scenario) {
    const f = dataGrantFixture();
    let input = f.request;
    if (scenario !== 'consent-access') {
        const key = { 'presence-check': 'presenceOrchestrator', 'patient-authentication': 'authenticationOrchestrator', 'dependent-discovery': 'discoveryOrchestrator' }[scenario];
        const clientId = f.config.oauthClients[key].clientId;
        const policyId = { 'presence-check': 'PRESENCE', 'patient-authentication': 'PATIENT-AUTHENTICATION', 'dependent-discovery': 'DEPENDENT-DISCOVERY' }[scenario];
        input = { ...input, client: { clientId },
            requested: rar('Contract', `PCM-POLICY-${policyId}-001`, scenario === 'presence-check' ? [f.patient] : scenario === 'patient-authentication' ? [f.strongPatient] : []),
            scope: scenario === 'presence-check' ? 'system/Patient.s' : scenario === 'patient-authentication' ? 'patient/Patient.s' : 'system/Patient.s system/RelatedPerson.s',
            invocation: { id: 'flow', clientId, identifier: f.strongPatient, homeHmoId: f.source.dataSourceOrganization.id, phase: scenario === 'dependent-discovery' ? 'authenticated' : 'authenticating', expiresAt: NOW + 100 } };
    }
    const grant = resolveGrant(input);
    const response = { active: true, client_id: input.client.clientId, sub: input.client.clientId,
        scope: grant.scope, authorization_details: grant.authorization_details,
        iss: f.config.contract.operational.fhirBase, aud: input.resource, iat: NOW, exp: NOW + 30,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true },
        ...(scenario === 'consent-access' ? { organization_id: `${grant.requesterIdentifier.system}#${grant.requesterIdentifier.value}` } : {}) };
    return { response, options: { expectedIssuer: response.iss, expectedAudience: response.aud, clock: () => NOW, hoId: f.source.id } };
}

for (const [scenario, kind] of [['consent-access', 'data-source-access'], ['presence-check', 'online-presence'], ['patient-authentication', 'patient-authentication'], ['dependent-discovery', 'dependent-discovery']]) {
    test(`current ${scenario} grant normalizes with role-aware identity separation`, () => {
        const { response, options } = responseFor(scenario);
        const normalized = validateIntrospectionResponse(response, options);
        assert.equal(normalized.schema, NORMALIZED_SCHEMA);
        assert.equal(normalized.kind, kind);
        assert.equal(Boolean(normalized.grant.patient), ['consent-access', 'patient-authentication'].includes(scenario));
        assert.equal(Boolean(normalized.grant.representative), scenario === 'dependent-discovery');
        for (const name of ['iat', 'authorization_details']) {
            const invalid = structuredClone(response); delete invalid[name];
            assert.throws(() => validateIntrospectionResponse(invalid, options));
        }
        for (const change of [{ patient: {} }, { fhirContext: [] }, { aud: 'https://other.test/fhir' }, { exp: NOW }]) {
            assert.throws(() => validateIntrospectionResponse({ ...response, ...change }, options));
        }
        const wrongRole = structuredClone(response);
        wrongRole.authorization_details[0].fhirContext[0].role = 'https://pcm.fhir.health.gov.il/fhir-context-role/consent';
        assert.throws(() => validateIntrospectionResponse(wrongRole, options));
        if (scenario !== 'consent-access') {
            assert.throws(() => validateIntrospectionResponse({ ...response, organization_id: 'caller' }, options));
            assert.throws(() => validateIntrospectionResponse({ ...response, scope: response.scope + ' system/Observation.s' }, options));
        }
    });
}

for (const scenario of ['presence-check', 'patient-authentication', 'dependent-discovery']) {
    test(`0.4.2 ${scenario} binds exact configured Contract and rejects old/extra context`, () => {
        const { response, options } = responseFor(scenario);
        const basis = body => body.authorization_details[0].fhirContext.find(item => item.type === 'Contract');
        const wrong = structuredClone(response); basis(wrong).identifier.value = 'matching-title-is-not-authority';
        assert.throws(() => validateIntrospectionResponse(wrong, options), /Contract identity/);
        const identities = { ...require('../../shared/workflow-identities').DEFAULTS, [scenario]: 'configured-replacement' };
        assert.throws(() => validateIntrospectionResponse(response, { ...options, workflowIdentities: identities }), /Contract identity/);
        basis(wrong).identifier.value = 'configured-replacement';
        assert.equal(validateIntrospectionResponse(wrong, { ...options, workflowIdentities: identities }).grant.contract.value, 'configured-replacement');
        const old = structuredClone(response);
        old.authorization_details[0].fhirContext.push({ type: 'HealthcareService', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/healthcare-service', identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-system-healthcareservice-id', value: 'old' } });
        assert.throws(() => validateIntrospectionResponse(old, options));
        const purpose = structuredClone(response); purpose.authorization_details[0].purposeOfUse[0].system = 'urn:wrong';
        assert.throws(() => validateIntrospectionResponse(purpose, options));
        if (scenario === 'presence-check') assert.equal(validateIntrospectionResponse(response, options).grant.patient, null);
    });
}

test('Consent Patient identifier predicates must agree with the sole enriched Patient', () => {
    const { response, options } = responseFor('consent-access');
    const wrong = { ...response, scope: 'patient/Patient.s?identifier=http://fhir.health.gov.il/identifier/il-national-id|000000026' };
    assert.throws(() => validateIntrospectionResponse(wrong, options), /disagrees/);
    assert.throws(() => validateIntrospectionResponse({ ...response, scope: 'patient/Patient.s system/Observation.s' }, options), /scope/);
});
