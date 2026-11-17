'use strict';

/** Central issuance/revalidation for immutable PCM 0.4.2 data grants. */
const { resolveDataSourceGrant, findOperationalDataSourceByAddress } = require('./token-authorization');
const { evaluatePolicy, SERVICE_SYSTEM } = require('./fhir/system-policy');
const { IDENTIFIER_SYSTEMS, EXTENSIONS } = require('../../shared/pcm-contract');
const { normalizePatientIdentifier } = require('../../shared/identity-mapping');
const { TYPE, ROLE_BASE, RequestError, validateScenarioRequest } = require('./rar-request');
const { sourceLimits } = require('./source-policy');
const { authorityStillAllowed } = require('./grant-authority-state');
const { basedOnId } = require('./fhir/healthcare-service-lifecycle');
const VERSION = 'pcm-data-grant/6';
const { readFirstUse } = require('./clinical-first-use');
const DEMOGRAPHICS = '_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics';
const DISCOVERY_TAG = '_tag=http://fhir.health.gov.il/cs/il-hdp-resource-tags|hmo-dependent-discovery';
// Only server-side orchestration can attach invocation context. JSON/form input
// cannot name this key; no wire session handle is accepted as authorization.
const INTERNAL_INVOCATION = Symbol('pcm-authenticated-invocation');
const deny = (message = 'Authorization basis is unavailable') => { throw new RequestError('invalid_authorization_details', message); };
const identifier = value => ({ system: value.system, value: value.value });
const context = (type, role, value) => ({ type, role: `${ROLE_BASE}${role}`, identifier: identifier(value) });
const official = (resource, system) => {
    const matches = (resource?.identifier || []).filter(item => item.system === system && item.value);
    if (matches.length !== 1) deny();
    return matches[0];
};

/** Cap by explicit service approval windows when supplied, rejecting malformed dates. */
function serviceDeadline(store, service, now) {
    let deadline = Infinity;
    // Integer OAuth NumericDate represents the complete second, as in Consent
    // eligibility. Fresh millisecond approval starts must not wait for another
    // second; precise injected clocks retain their exact boundary. Expiry stays unchanged.
    const representedNow = Number.isInteger(now) ? now + 0.999 : now;
    for (const resource of [service, store.get('HealthcareService', basedOnId(service))].filter(Boolean)) {
        for (const item of (resource.extension || []).filter(value => value.url === EXTENSIONS.approvalWindow)) {
            const start = Date.parse(item.valuePeriod?.start) / 1000;
            const end = Date.parse(item.valuePeriod?.end) / 1000;
            if (!Number.isFinite(start) || !Number.isFinite(end) || start > representedNow || end <= now) deny();
            deadline = Math.min(deadline, end);
        }
    }
    return deadline;
}

/** Construct the exact enriched RAR which is retained and returned unchanged. */
function authorizationDetails(scenario, basis, service, patients, representative) {
    // FHIR Consent permits longer values, but OAuth PatientIdentifier does not.
    // This wire-schema bound is independent of configurable identity validation.
    for (const patient of [...(patients || []), ...(representative ? [representative] : [])]) {
        if (typeof patient.value !== 'string' || [...patient.value].length > 128) {
            throw new RequestError('invalid_authorization_details', 'OAuth Patient identifier exceeds 128 characters');
        }
    }
    const fhirContext = [context(basis.resourceType, 'authorization-basis', official(basis,
        basis.resourceType === 'Consent' ? IDENTIFIER_SYSTEMS.consent : 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id'))];
    // Self-contained normative grants have no service. Consent and the explicitly
    // labelled local sampler keep their required, validated service context.
    if (basis.resourceType === 'Consent' || scenario === 'sandbox-patient-sample') fhirContext.push(
        context('HealthcareService', 'healthcare-service', official(service,
            basis.resourceType === 'Consent' ? IDENTIFIER_SYSTEMS.healthcareServiceInstance : SERVICE_SYSTEM)));
    for (const patient of patients || []) fhirContext.push(context('Patient', 'authorization-patient', patient));
    if (representative) fhirContext.push(context('RelatedPerson', 'discovery-representative', representative));
    return [{ type: TYPE, fhirContext, purposeOfUse: [scenario === 'consent-access'
        ? { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' }
        : { system: scenario === 'sandbox-patient-sample' ? 'urn:pcm:sandbox:authorization-scenario' : 'http://pcm.fhir.health.gov.il/cs/pcm-authorization-scenario', code: scenario }] }];
}

/** Evaluate requested authorization using current state; never infer missing invocation evidence. */
function evaluateGrant({ store, config, firstUseStore, client, requested, scope, resource, now, compiledAt = now, invocation = null, controls = {} }) {
    if (requested.basis.type === 'Consent') {
        const result = resolveDataSourceGrant({ store, client, requested, scope, resource, now, compiledAt, firstUseStore, controls, config });
        if (result.error) throw new RequestError(result.error, result.description);
        const grant = result.grant;
        const consent = store.get('Consent', grant.consentId);
        const service = store.get('HealthcareService', grant.serviceId);
        if (!grant.patient) deny();
        const window = readFirstUse(firstUseStore, service.id, consent.id, client.clientId, grant.dataSourceOrganizationId);
        const deadline = Math.min(grant.deadline,
            serviceDeadline(store, service, now), window?.expiresAt ?? Number.MAX_SAFE_INTEGER);
        if (!Number.isFinite(deadline) || deadline <= now) deny();
        return { ...grant, version: VERSION, scenario: 'consent-access', deadline,
            authorization_details: authorizationDetails('consent-access', consent, service, [grant.patient]),
            requesterIdentifier: identifier(official(store.get('Organization', client.organizationId), IDENTIFIER_SYSTEMS.organization)) };
    }
    if (requested.patients.length > sourceLimits(store, config, { resource }).maxPatients) deny();
    const target = findOperationalDataSourceByAddress(store, resource);
    if (!target) throw new RequestError('invalid_target', 'Resource is not an active Data Source Endpoint');
    const policy = evaluatePolicy({ store, config, identifier: requested.basis.identifier, clientId: client.clientId,
        targetOrganizationId: target.organization.id, now });
    if (!policy) deny();
    const { scenario, service, contract } = policy;
    validateScenarioRequest(requested, scope, scenario, { syntheticFixture: invocation?.syntheticFixture === true });
    let effectiveScope;
    let representative;
    let invocationIdentity;
    // An ongoing Contract must remain JSON-safe in the retained opaque-token record.
    // The independent configured OAuth lifetime still caps every issued token.
    let deadline = policy.end === Infinity ? Number.MAX_SAFE_INTEGER : policy.end;
    const patientKeys = requested.patients.map(value => normalizePatientIdentifier(value).key);
    if (scenario === 'sandbox-patient-sample') {
        effectiveScope = 'system/Patient.s';
    } else if (scenario === 'presence-check') {
        const eligible = new Set(config.systemAuthorization.presenceEligiblePatients.map(value => normalizePatientIdentifier(value).key));
        if (patientKeys.some(key => !eligible.has(key))) deny();
        effectiveScope = `system/Patient.s?identifier=${requested.patients.map(value => `${value.system}|${value.value}`).join(',')}&${DEMOGRAPHICS}`;
    } else {
        // Invocation evidence is produced by the private flow repository. It is
        // copied into the grant, but must be independently resolved on revalidation.
        if (!invocation || invocation.expiresAt <= now || invocation.clientId !== client.clientId) deny();
        const identity = normalizePatientIdentifier(invocation.identifier);
        invocationIdentity = { system: identity.system, value: identity.value };
        const membership = config.systemAuthorization.memberships.find(member => normalizePatientIdentifier(member.identifier).key === identity.key);
        if (identity.synthetic && !(invocation.syntheticFixture === true && membership?.sandboxFixture === true)) deny();
        if (!identity.synthetic && !require('../../shared/identity-mapping').isPatientLoginEligible(identity, membership?.loginEligibility)) deny();
        deadline = Math.min(deadline, invocation.expiresAt);
        if (scenario === 'patient-authentication') {
            const source = require('./hmo-sources').resolveHmoSource(config, target.organization.id, { store });
            if (invocation.phase !== 'authenticating' || patientKeys[0] !== identity.key || invocation.homeHmoId !== source.id) deny();
            effectiveScope = `patient/Patient.s?${DEMOGRAPHICS}`;
        } else {
            if (invocation.phase !== 'authenticated') deny();
            representative = identifier(identity);
            effectiveScope = `system/Patient.s?_has:RelatedPerson:patient:identifier=${identity.system}|${identity.value}&${DEMOGRAPHICS} system/RelatedPerson.s?identifier=${identity.system}|${identity.value}&${DEMOGRAPHICS}&${DISCOVERY_TAG}`;
        }
    }
    return { version: VERSION, scenario, contractId: contract.id, ...(service ? { serviceId: service.id } : {}),
        dataSourceOrganizationId: target.organization.id, endpointId: target.endpoint.id,
        scope: effectiveScope, requestedScope: scope, requested, compiledAt, deadline,
        ...(invocation ? { invocationId: invocation.id, invocationIdentity } : {}),
        authorization_details: authorizationDetails(scenario, contract, service, requested.patients, representative) };
}

/** Capture current eligibility/authority beside the retained permission decision. */
function resolveGrant(options) {
    const grant = evaluateGrant(options);
    return { ...grant, authority: options.store.authorityState.stamp(options.store, options.config, grant, options.client, options.controls || {}) };
}

/** Require exact retained alternatives/context; broadening cannot modify an existing grant. */
function grantContentStillAllowed(issued, current) {
    if (issued?.version !== VERSION || current?.version !== VERSION || issued.scenario !== current.scenario) return false;
    if (issued.scenario === 'consent-access' && (issued.scope !== current.scope
        || JSON.stringify(issued.approvalSnapshot) !== JSON.stringify(current.approvalSnapshot))) return false;
    if (JSON.stringify(issued.authorization_details) !== JSON.stringify(current.authorization_details)) return false;
    const currentScopes = new Set(current.scope.split(' '));
    return issued.scope.split(' ').every(scope => currentScopes.has(scope));
}

/** Compare original-source dependency history separately from a caller's permitted simulation. */
function grantStillAllowed(issued, current) {
    return grantContentStillAllowed(issued, current) && authorityStillAllowed(issued.authority, current.authority);
}

module.exports = { grantContentStillAllowed, INTERNAL_INVOCATION, VERSION, authorizationDetails, grantStillAllowed, resolveGrant, serviceDeadline };
