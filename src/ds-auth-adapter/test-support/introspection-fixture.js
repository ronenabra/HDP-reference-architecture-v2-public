'use strict';

const { IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');
const { CONTEXT_ROLES } = require('../src/introspection-contract');

const NOW = 1900000000;
const ISSUER = 'https://pcm2mtest.health.gov.il/api/fhir-service/r4';
const AUDIENCE = 'https://ho-a.example.test/fhir';
const THUMBPRINT = 'A'.repeat(43);
const patient = { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' };

function item(type, identifier) {
    return { type, role: CONTEXT_ROLES[type], identifier };
}

function common(scope = 'patient/Observation.rs') {
    return {
        active: true,
        scope,
        client_id: 'pcm-sp-client-0001',
        pcm_authentication_context: {
            token_endpoint_mtls: { 'x5t#S256': THUMBPRINT },
            client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) },
            correlation_verified: true
        },
        exp: NOW + 30,
        iat: NOW - 1,
        iss: ISSUER,
        aud: AUDIENCE,
        sub: 'pcm-sp-client-0001'
    };
}

function dataSourceResponse() {
    return {
        ...common(),
        organization_id: `${IDENTIFIER_SYSTEMS.organization}#SP-1`,
        authorization_details: [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access',
        purposeOfUse: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' }], fhirContext: [
            item('Patient', patient),
            item('Consent', { system: IDENTIFIER_SYSTEMS.consent, value: 'CONSENT-1' }),
            item('HealthcareService', { system: IDENTIFIER_SYSTEMS.healthcareServiceInstance, value: 'SERVICE-1' })
        ] }]
    };
}

/** Build a Contract-based presence grant for an explicit Patient set. */
function presenceResponse(patients = [patient]) {
    const scope = `system/Patient.s?identifier=${patients.map(id => `${id.system}|${id.value}`).join(',')}&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics`;
    return { ...common(scope), client_id: 'pcm-presence-orchestrator', sub: 'pcm-presence-orchestrator',
        authorization_details: [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access',
            purposeOfUse: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-authorization-scenario', code: 'presence-check' }],
            fhirContext: [
                { type: 'Contract', role: CONTEXT_ROLES.Consent, identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' } },
                ...patients.map(id => item('Patient', id))
            ] }] };
}

const options = { expectedIssuer: ISSUER, expectedAudience: AUDIENCE, hoId: 'ho-a', clock: () => NOW };

module.exports = { AUDIENCE, ISSUER, NOW, common, dataSourceResponse, presenceResponse, item, options, patient };
