'use strict';

/** Closed PCM 0.4.2 enriched RAR validation shared by Doctor and Data Sources. */
const { MAXIMA } = require('./presence-limits');
const { normalizePatientIdentifier } = require('./identity-mapping');
const TYPE = 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access';
const ROLE = 'https://pcm.fhir.health.gov.il/fhir-context-role/';
const BASE = 'http://pcm.fhir.health.gov.il';
const BASIS = { Consent: `${BASE}/identifier/pcm-consent-id`, Contract: `${BASE}/identifier/pcm-data-access-authorization-id` };
const SERVICE = { Consent: `${BASE}/identifier/pcm-healthcareservice-instance-id`, Contract: `${BASE}/identifier/pcm-system-healthcareservice-id` };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new TypeError('Invalid PCM effective authorization_details'); };

/** Build the minimal Consent request using an authoritative business identifier. */
function consentAuthorizationDetails(consent) {
    const matches = (consent?.identifier || []).filter(item => item.system === BASIS.Consent && item.value);
    if (matches.length !== 1) throw new TypeError('Consent must have one authoritative business identifier');
    return [{ type: TYPE, fhirContext: [{ type: 'Consent', role: `${ROLE}authorization-basis`, identifier: {
        system: matches[0].system, value: matches[0].value
    } }] }];
}

/** Build a Contract-only request; PCM derives the service and scenario. */
function contractAuthorizationDetails(value) {
    if (typeof value !== 'string' || !value) throw new TypeError('Contract business identifier is required');
    return [{ type: TYPE, fhirContext: [{ type: 'Contract', role: `${ROLE}authorization-basis`, identifier: { system: BASIS.Contract, value } }] }];
}

/** Validate context roles/cardinality and return the explicit scenario and identities. */
function validateDataAuthorizationDetails(details, { allowSandboxGuid = false, maxPatients = MAXIMA.maxPatients, syntheticWorkflowFixtures = [] } = {}) {
    if (!Array.isArray(details) || details.length !== 1 || !exact(details[0], ['type', 'fhirContext', 'purposeOfUse']) || details[0].type !== TYPE) fail();
    // This list is private consumer configuration, never a RAR/wire option. Default rejection is unchanged.
    const fixtureAllowed = identity => syntheticWorkflowFixtures.some(value => value.system === identity.system && value.value === identity.value);
    const value = details[0];
    if (!Array.isArray(value.fhirContext) || value.fhirContext.length < 2 || value.fhirContext.length > maxPatients + 2
        || !Array.isArray(value.purposeOfUse) || value.purposeOfUse.length !== 1
        || !value.purposeOfUse[0] || !['system', 'code'].every(key => typeof value.purposeOfUse[0][key] === 'string')
        || Object.keys(value.purposeOfUse[0]).some(key => !['system', 'code', 'display'].includes(key))
        || (value.purposeOfUse[0].display !== undefined && typeof value.purposeOfUse[0].display !== 'string')) fail();
    let basis, service, representative;
    const patients = [];
    const seen = new Set();
    for (const item of value.fhirContext) {
        if (!exact(item, ['type', 'role', 'identifier']) || !exact(item.identifier, ['system', 'value'])
            || typeof item.identifier.system !== 'string' || typeof item.identifier.value !== 'string' || !item.identifier.value) fail();
        const key = JSON.stringify([item.type, item.identifier.system, item.identifier.value]);
        if (seen.has(key)) fail();
        seen.add(key);
        if (Object.hasOwn(BASIS, item.type)) {
            if (basis || item.role !== `${ROLE}authorization-basis` || item.identifier.system !== BASIS[item.type]) fail();
            basis = item;
        } else if (item.type === 'HealthcareService') {
            if (service || item.role !== `${ROLE}healthcare-service`) fail();
            service = item;
        } else if (item.type === 'Patient') {
            if (item.role !== `${ROLE}authorization-patient`) fail();
            normalizePatientIdentifier(item.identifier, { allowSandboxGuid, maxLength: 128 });
            patients.push(item.identifier);
        } else if (item.type === 'RelatedPerson') {
            if (representative || item.role !== `${ROLE}discovery-representative`) fail();
            if (normalizePatientIdentifier(item.identifier, { maxLength: 128 }).synthetic && !fixtureAllowed(item.identifier)) fail();
            representative = item.identifier;
        } else fail();
    }
    if (!basis) fail();
    const purpose = value.purposeOfUse[0];
    if (basis.type === 'Consent') {
        if (!service || service.identifier.system !== SERVICE.Consent) fail();
        if (purpose.system !== 'http://terminology.hl7.org/CodeSystem/v3-ActReason' || purpose.code !== 'TREAT' || patients.length !== 1 || representative) fail();
        return { scenario: 'consent-access', basis, service, patients };
    }
    for (const patient of patients) normalizePatientIdentifier(patient);
    if (purpose.code === 'sandbox-patient-sample') {
        if (!service || service.identifier.system !== SERVICE.Contract || !allowSandboxGuid || purpose.system !== 'urn:pcm:sandbox:authorization-scenario' || patients.length || representative || value.fhirContext.length !== 2) fail();
        return { scenario: purpose.code, basis, service, patients };
    }
    if (service || purpose.system !== `${BASE}/cs/pcm-authorization-scenario`) fail();
    if (purpose.code === 'presence-check') {
        if (patients.length < 1 || patients.length > maxPatients || representative) fail();
    } else if (purpose.code === 'patient-authentication') {
        if (patients.length !== 1 || representative || (normalizePatientIdentifier(patients[0]).synthetic && !fixtureAllowed(patients[0]))) fail();
    } else if (purpose.code === 'dependent-discovery') {
        if (patients.length || !representative) fail();
    } else fail();
    return { scenario: purpose.code, basis, service, patients, representative };
}

module.exports = { BASIS, ROLE, SERVICE, TYPE, contractAuthorizationDetails, consentAuthorizationDetails, validateDataAuthorizationDetails };
