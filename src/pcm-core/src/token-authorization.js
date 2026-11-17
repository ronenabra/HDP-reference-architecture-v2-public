'use strict';

/** Authoritative authorization lookups used by token issuance. */

const { B2B, CONSENT_POLICY, EXTENSIONS, serializeBusinessIdentifier } = require('../../shared/pcm-contract');
const { readFirstUse } = require('./clinical-first-use');
const { resolveIdentifier } = require('./fhir/system-policy');
const { validateScenarioRequest } = require('./rar-request');
const {
    findOperationalDataSourceByAddress,
    localReference,
    officialOrganizationIdentifier,
    organizationIsOperational
} = require('./fhir/participant-lifecycle');
const { serviceIsOperational } = require('./fhir/healthcare-service-lifecycle');
const { accessMode, consentBusinessStatus, consentIsActive, patientIdentifier } = require('./fhir/consent-lifecycle');

const { requiresExactSourceMembership } = require('./fhir/sandbox-source-change');

const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));
const referenceId = reference => localReference(reference);

function businessIdentifier(organization) {
    return officialOrganizationIdentifier(organization);
}

function exactArray(value, expected) {
    return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

/** Return true when every independently requested scope was explicitly approved. */
function scopeIsApprovedSubset(requested, approved) {
    const approvedScopes = new Set(String(approved || '').split(/\s+/).filter(Boolean));
    const requestedScopes = String(requested || '').split(/\s+/).filter(Boolean);
    return requestedScopes.length > 0 && requestedScopes.every(scope => approvedScopes.has(scope));
}

function validateB2BEnvelope(decodedAssertion) {
    const allowedClaims = new Set(['iss', 'sub', 'aud', 'jti', 'iat', 'exp', 'cnf', 'extensions']);
    if (!decodedAssertion || Object.keys(decodedAssertion).some(key => !allowedClaims.has(key))) {
        return { error: 'invalid_grant', description: 'Data Source assertion contains unsupported claims' };
    }
    const extensions = decodedAssertion.extensions;
    if (!extensions || Object.keys(extensions).length !== 1 || !extensions['hl7-b2b']) {
        return { error: 'invalid_grant', description: 'Data Source assertion requires exactly the hl7-b2b extension' };
    }
    const b2b = extensions['hl7-b2b'];
    const allowed = new Set(['version', 'organization_id', 'purpose_of_use', 'consent_policy', 'consent_reference']);
    if (!b2b || Object.keys(b2b).some(key => !allowed.has(key)) || Object.keys(b2b).length !== allowed.size) {
        return { error: 'invalid_grant', description: 'HL7 B2B extension fields are invalid' };
    }
    if (b2b.version !== B2B.version) return { error: 'invalid_grant', description: 'HL7 B2B version is invalid' };
    if (!exactArray(b2b.purpose_of_use, B2B.purposeOfUse)) {
        return { error: 'invalid_grant', description: 'HL7 B2B purpose_of_use is invalid' };
    }
    if (!exactArray(b2b.consent_policy, CONSENT_POLICY.uri)) {
        return { error: 'invalid_grant', description: 'HL7 B2B consent_policy is invalid' };
    }
    if (!Array.isArray(b2b.consent_reference) || b2b.consent_reference.length !== 1) {
        return { error: 'invalid_grant', description: 'HL7 B2B requires exactly one Consent reference' };
    }
    return { b2b };
}

/** Resolve a Data Source token grant through Consent and active lifecycle state. */
function resolveDataSourceGrant({ store, client, requested, scope, resource, now, compiledAt = now, firstUseStore, controls = {}, config = {} }) {
    // Keep the OAuth/RAR shape mandatory; requested resource/actions are advisory
    // for this sandbox's Consent path, independently of the saved approval.
    try { validateScenarioRequest(requested, scope, 'consent-access'); }
    catch (error) { return { error: error.code || 'invalid_authorization_details', description: error.message }; }
    if (client.role !== 'service-provider') {
        return { error: 'unauthorized_client', description: 'Only Service Provider clients can request Data Source access' };
    }
    const requester = store.get('Organization', client.organizationId);
    if (!organizationIsOperational(store, requester)) {
        return { error: 'unauthorized_client', description: 'Requesting Organization is not active' };
    }
    const identifier = businessIdentifier(requester);
    if (!identifier) return { error: 'unauthorized_client', description: 'Requester identity is invalid' };
    const consent = resolveIdentifier(store, 'Consent', requested.basis.identifier);
    if (consentBusinessStatus(consent) === 'service-provider-cancelled') return { error: 'invalid_authorization_details', description: 'Authorization basis was permanently cancelled by its provider', diagnostic: 'consent-provider-cancelled' };
    // Clinical eligibility is independent of authentication simulations.
    if (!consent || !consentIsActive(consent, now)) {
        const diagnostic = !consent
            ? 'consent-missing'
            : consent.status !== 'active'
                ? 'consent-fhir-status'
                : consentBusinessStatus(consent) !== 'active'
                    ? 'consent-business-status'
                    : 'consent-period';
        return { error: 'invalid_authorization_details', description: 'Authorization basis is unavailable', diagnostic };
    }
    // The selected approval alone owns permissions; copied service metadata is provenance.
    let saved;
    try {
        const decision = store.privateRecords.approvals.getDecision(consent.id);
        saved = decision.status === 'ok' ? decision.snapshot : null;
        if (!saved?.usable) return { error: 'invalid_scope', description: 'Approval scope is missing or unusable; create a new Consent approval.', diagnostic: 'approval-snapshot-unusable' };
    } catch (error) { return { error: 'invalid_scope', description: error.message, diagnostic: 'approval-snapshot-invalid' }; }
    const requesterActor = ensureArray(consent.provision?.actor).some(actor => {
        const ref = referenceId(actor.reference?.reference);
        return ref?.type === 'Organization' && ref.id === client.organizationId;
    });
    if (!requesterActor) return { error: 'invalid_authorization_details', description: 'Authorization basis is unavailable' };

    const serviceReference = ensureArray(consent.extension)
        .find(extension => extension.url === EXTENSIONS.pcmService)?.valueReference?.reference;
    const serviceRef = referenceId(serviceReference);
    const service = serviceRef?.type === 'HealthcareService' ? store.get('HealthcareService', serviceRef.id) : null;
    if (!service || !serviceIsOperational(store, service)) {
        return { error: 'invalid_authorization_details', description: 'Authorization basis is unavailable' };
    }
    const target = findOperationalDataSourceByAddress(store, resource);
    if (!target) return { error: 'invalid_target', description: 'Resource is not an active Data Source Endpoint' };
    if (target.organization.id === config.organizations?.referenceDataSource?.id) {
        return { error: 'invalid_scope', description: 'Legacy Node source does not support clinical scope enforcement; select a qualified native Data Source.' };
    }
    const targetIsCustodian = ensureArray(consent.provision?.actor).some(actor => {
        const ref = referenceId(actor.reference?.reference);
        return actor.role?.coding?.some(coding => coding.code === 'CST')
            && ref?.type === 'Organization' && ref.id === target.organization.id;
    });
    if (!targetIsCustodian) return { error: 'invalid_target', description: 'Resource is not authorized by the referenced consent' };
    if (accessMode(consent) === 'one-time') {
        const window = readFirstUse(firstUseStore, service.id, consent.id, client.clientId, target.organization.id);
        if (window && (!window.ok || window.startedAt > now || window.expiresAt <= now)) {
            return { error: 'invalid_authorization_details', description: 'Authorization basis is unavailable', diagnostic: 'consent-first-use-window' };
        }
    }
    if (patientIdentifier(consent)?.sandboxSynthetic && !require('../../shared/identity-mapping').sandboxIdentityOptions(config).allowSandboxGuid) return { error: 'invalid_authorization_details', description: 'Sandbox GUID identities are unavailable in strict' };
    // getDecision validates supported approved syntax and exact private binding.
    // Never intersect, expand or regenerate that immutable permission decision.
    return {
        grant: {
            consentId: consent.id,
            serviceId: service.id,
            dataSourceOrganizationId: target.organization.id,
            endpointId: target.endpoint.id,
            patient: patientIdentifier(consent),
            scope: saved.scope,
            approvalSnapshot: saved,
            requestedScope: scope,
            requested,
            compiledAt,
            deadline: Math.floor(Date.parse(consent.provision?.period?.end) / 1000)
        }
    };
}

module.exports = {
    findOperationalDataSourceByAddress,
    organizationIsOperational,
    resolveDataSourceGrant,
    scopeIsApprovedSubset,
    serviceIsOperational,
    validateB2BEnvelope
};
