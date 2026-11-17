'use strict';

/** Closed validation and normalization for PCM-IG 0.4.2 introspection. */

const {
    IDENTIFIER_SYSTEMS,
    isOpaqueClientId,
    isThumbprint
} = require('../../shared/pcm-contract');

const { validateDataAuthorizationDetails } = require('../../shared/data-authorization-details');

const NORMALIZED_SCHEMA = 'pcm-ds-authorization-context/4';
const ACTIVE_FIELDS = Object.freeze([
    'active', 'scope', 'client_id', 'pcm_authentication_context',
    'exp', 'iat', 'iss', 'aud', 'sub', 'organization_id', 'authorization_details'
]);
const REQUIRED_ACTIVE_FIELDS = Object.freeze([
    'active', 'scope', 'client_id', 'pcm_authentication_context',
    'exp', 'iat', 'iss', 'aud', 'sub', 'authorization_details'
]);
const CONTEXT_ROLES = Object.freeze({
    Patient: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient',
    Consent: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis',
    HealthcareService: 'https://pcm.fhir.health.gov.il/fhir-context-role/healthcare-service'
});
/** Freeze an independent normalized grant so caller-owned JSON cannot widen it later. */
function immutable(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(immutable);
        Object.freeze(value);
    }
    return value;
}

function contractError(message, reasonCode = 'MALFORMED_PCM_RESPONSE') {
    const error = new Error(`Invalid PCM introspection response: ${message}`);
    error.code = 'PCM_INTROSPECTION_CONTRACT';
    error.reasonCode = reasonCode;
    return error;
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value, required, allowed, label) {
    if (!isRecord(value)) throw contractError(`${label} must be an object`);
    for (const key of required) {
        if (!Object.hasOwn(value, key)) throw contractError(`${label}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) throw contractError(`${label}.${key} is not allowed`);
    }
}

function validateAuthenticationContext(value, options) {
    try { return require('../../shared/authentication-evidence').normalizeAuthenticationEvidence(value, options); }
    catch (error) { throw contractError(error.message); }
}

function validateOrganizationId(value) {
    const prefix = `${IDENTIFIER_SYSTEMS.organization}#`;
    if (typeof value !== 'string' || !value.startsWith(prefix)
        || value.length === prefix.length || /[#\s]/.test(value.slice(prefix.length))) {
        throw contractError(`organization_id must use ${IDENTIFIER_SYSTEMS.organization}#value`);
    }
    return Object.freeze({ system: IDENTIFIER_SYSTEMS.organization, value: value.slice(prefix.length) });
}

/**
 * Validate a closed PCM response and convert it into the only internal schema
 * accepted by mapping and policy code.
 */
function validateIntrospectionResponse(value, options) {
    const now = options?.clock?.() ?? Math.floor(Date.now() / 1000);
    if (!isRecord(value)) throw contractError('body must be an object');
    if (value.active === false) {
        requireExactKeys(value, ['active'], ['active'], 'inactive response');
        return Object.freeze({ active: false });
    }
    requireExactKeys(value, REQUIRED_ACTIVE_FIELDS, ACTIVE_FIELDS, 'active response');
    if (value.active !== true) throw contractError('active must be true or false');
    if (!isOpaqueClientId(value.client_id) || value.sub !== value.client_id) {
        throw contractError('client_id must be opaque and equal sub');
    }
    const acceptedIssuers = options?.acceptedIssuers || [options?.expectedIssuer];
    if (!Array.isArray(acceptedIssuers) || !acceptedIssuers.includes(value.iss)) {
        throw contractError('issuer does not match a configured PCM operational origin', 'INVALID_ISSUER');
    }
    if (value.aud !== options?.expectedAudience) throw contractError('audience does not match this Data Source', 'INVALID_AUDIENCE');
    if (!Number.isSafeInteger(value.exp)) throw contractError('exp must be a future integer');
    if (value.exp <= now) throw contractError('exp must be a future integer', 'EXPIRED_TOKEN');
    if (Object.hasOwn(value, 'iat') && (!Number.isSafeInteger(value.iat) || value.iat > now || (value.iat >= value.exp))) {
        throw contractError('iat must be an integer before exp and not in the future');
    }

    let details;
    try { details = validateDataAuthorizationDetails(value.authorization_details, { allowSandboxGuid: options?.allowSandboxGuid === true, syntheticWorkflowFixtures: options?.syntheticWorkflowFixtures || [], maxPatients: options?.presenceLimits?.maxPatients ?? 100 }); }
    catch (error) { throw contractError(error.message); }
    if (details.basis.type === 'Contract' && details.scenario !== 'sandbox-patient-sample') {
        try { require('../../shared/workflow-identities').assertWorkflowIdentity(details.basis.identifier, details.scenario, options?.workflowIdentities); }
        catch (error) { throw contractError(error.message); }
    }
    const authentication = validateAuthenticationContext(value.pcm_authentication_context, { ...options?.authenticationSimulation, controls: options?.controls });
    let kind;
    let patient = null;
    let consent = null;
    const healthcareService = details.service?.identifier || null;
    const contract = details.basis.type === 'Contract' ? details.basis.identifier : null;
    let organization = null;
    let presenceIdentifiers = null;
    const representative = details.representative || null;
    const demographics = '_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics';
    const discoveryTag = '_tag=http://fhir.health.gov.il/cs/il-hdp-resource-tags|hmo-dependent-discovery';
    const identityValue = identifier => `${identifier.system}|${identifier.value}`;
    if (details.scenario === 'consent-access') {
        kind = 'data-source-access';
        organization = validateOrganizationId(value.organization_id);
        patient = details.patients[0];
        consent = details.basis.identifier;
        if (typeof value.scope !== 'string' || value.scope !== 'patient/*.rs' && !value.scope.split(' ').every(scope => /^patient\/[A-Z][A-Za-z]+\.(?:r|s|rs)(?:\?[^\s]+)?$/.test(scope))) throw contractError('Consent scope is invalid');
        for (const token of value.scope.split(' ')) {
            if (!token.startsWith('patient/Patient.')) continue;
            const clauses = token.split('?')[1]?.split('&') || [];
            if (clauses.some(clause => clause.startsWith('identifier=') && clause !== `identifier=${identityValue(patient)}`)) throw contractError('Patient scope identity disagrees with context');
        }
    } else {
        if (Object.hasOwn(value, 'organization_id')) throw contractError('system workflow must omit organization_id');
        if (details.scenario === 'sandbox-patient-sample') {
            kind = 'sandbox-patient-sample';
            if (value.scope !== 'system/Patient.s' || value.aud !== options.expectedAudience || value.exp <= now) throw contractError('sampling scope/audience/expiry mismatch');
        } else if (details.scenario === 'presence-check') {
            presenceIdentifiers = details.patients;
            kind = presenceIdentifiers.length === 1 ? 'online-presence' : 'batch-presence';
            const expected = `system/Patient.s?identifier=${presenceIdentifiers.map(identityValue).join(',')}&${demographics}`;
            if (value.scope !== expected) throw contractError('presence scope/context mismatch');
        } else if (details.scenario === 'patient-authentication') {
            kind = 'patient-authentication';
            patient = details.patients[0];
            if (value.scope !== `patient/Patient.s?${demographics}`) throw contractError('authentication scope/context mismatch');
        } else {
            kind = 'dependent-discovery';
            const expected = [`system/Patient.s?_has:RelatedPerson:patient:identifier=${identityValue(representative)}&${demographics}`, `system/RelatedPerson.s?identifier=${identityValue(representative)}&${demographics}&${discoveryTag}`];
            const actual = value.scope?.split(' ');
            if (actual?.length !== 2 || !expected.every(scope => actual.includes(scope))) throw contractError('discovery scope/context mismatch');
        }
    }

    return immutable(structuredClone({
        schema: NORMALIZED_SCHEMA,
        active: true,
        kind,
        hoId: options.hoId,
        subject: Object.freeze({ clientId: value.client_id, organization }),
        grant: Object.freeze({
            scope: value.scope,
            patient,
            consent,
            healthcareService,
            contract,
            representative,
            scenario: details.scenario,
            presenceIdentifiers
        }),
        token: Object.freeze({
            issuer: value.iss,
            audience: value.aud,
            issuedAt: value.iat ?? null,
            returnedExpiresAt: value.exp,
            expiresAt: value.exp
        }),
        authentication
    }));
}

module.exports = {
    ACTIVE_FIELDS,
    CONTEXT_ROLES,
    NORMALIZED_SCHEMA,
    validateIntrospectionResponse
};
