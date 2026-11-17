'use strict';

/**
 * Immutable vocabulary and configuration helpers for the pinned PCM-IG 0.4.2
 * sandbox contract. Operational hosts are intentionally separate from
 * canonical identifiers so local/team routing cannot rewrite FHIR identity.
 */

const crypto = require('crypto');
const { environmentEndpoints, validateEnvironment } = require('./pcm-environment');
const { buildEffectivePolicy, POLICY_VERSION } = require('./conformance-policy');
const { hasValidIsraeliNationalId, normalizePatientIdentifier } = require('./identity-mapping');

const PCM_IG = Object.freeze({
    version: '0.4.2',
    fhirVersion: '4.0.1',
    commit: 'bd093a1764a56dd8ad76af365f33b74a735daee0'
});

const OPERATIONAL = environmentEndpoints('production');

const CANONICAL_BASE = 'http://pcm.fhir.health.gov.il';

const CODE_SYSTEMS = Object.freeze({
    organizationType: `${CANONICAL_BASE}/cs/pcm-org-type`,
    contactEntityType: `${CANONICAL_BASE}/cs/pcm-contactentity-type`,
    consentAccessMode: `${CANONICAL_BASE}/cs/pcm-consent-access-mode`,
    consentBusinessStatus: `${CANONICAL_BASE}/cs/pcm-consent-business-status`,
    serviceBusinessStatus: `${CANONICAL_BASE}/cs/pcm-service-business-status`,
    metaTag: `${CANONICAL_BASE}/cs/pcm-meta-tag`,
    informationBucket: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets',
    actReason: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
    endpointConnectionType: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type',
    endpointPayloadType: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type'
});

const IDENTIFIER_SYSTEMS = Object.freeze({
    organization: `${CANONICAL_BASE}/identifier/pcm-organization-id`,
    healthcareServiceCatalog: `${CANONICAL_BASE}/identifier/pcm-healthcareservice-catalog-id`,
    healthcareServiceInstance: `${CANONICAL_BASE}/identifier/pcm-healthcareservice-instance-id`,
    consent: `${CANONICAL_BASE}/identifier/pcm-consent-id`,
    israelNationalId: 'http://fhir.health.gov.il/identifier/il-national-id',
    palestinianNationalId: 'http://fhir.health.gov.il/identifier/pna-national-id',
    israelTemporaryId: 'http://fhir.health.gov.il/identifier/il-temporary-id',
    passport: 'http://hl7.org/fhir/sid/passport-ISR',
    syntheticTest: 'http://fhir.health.gov.il/identifier/il-hdp-test-id'
});

const SECURITY = Object.freeze({
    system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason',
    syntheticTestCode: 'HTEST'
});

const EXTENSIONS = Object.freeze({
    accessDuration: `${CANONICAL_BASE}/StructureDefinition/ext-access-duration`,
    accessMode: `${CANONICAL_BASE}/StructureDefinition/ext-access-mode`,
    allowPatientBucketChange: `${CANONICAL_BASE}/StructureDefinition/ext-allow-patient-bucket-change`,
    applicableCertificates: `${CANONICAL_BASE}/StructureDefinition/ext-applicable-certificates`,
    approvalWindow: `${CANONICAL_BASE}/StructureDefinition/ext-approval-window`,
    basedOnCanonicalHealthcareService: `${CANONICAL_BASE}/StructureDefinition/ext-based-on-canonical-healthcareservice`,
    consentBusinessStatus: `${CANONICAL_BASE}/StructureDefinition/ext-consent-business-status`,
    exampleQuery: `${CANONICAL_BASE}/StructureDefinition/ext-example-query`,
    informationBucket: `${CANONICAL_BASE}/StructureDefinition/ext-information-bucket`,
    oauthRedirectUri: `${CANONICAL_BASE}/StructureDefinition/ext-oauth2-redirect-uri`,
    pcmService: `${CANONICAL_BASE}/StructureDefinition/ext-pcm-service`,
    serviceBusinessStatus: `${CANONICAL_BASE}/StructureDefinition/ext-service-business-status`
});

const SANDBOX_EXTENSIONS = Object.freeze({
    approvalScopeOption: 'urn:pcm:sandbox:approval-scope-option',
    approvedTokenScopeOrigin: 'urn:pcm:sandbox:approved-token-scope-origin',
    approvedTokenScope: `${CANONICAL_BASE}/StructureDefinition/ext-approved-token-scope`,
    dataSourceServerTrust: `${CANONICAL_BASE}/StructureDefinition/ext-data-source-server-trust`
});

const PROFILES = Object.freeze({
    organizationParent: `${CANONICAL_BASE}/StructureDefinition/pcm-organization-parent`,
    organizationServiceProvider: `${CANONICAL_BASE}/StructureDefinition/pcm-organization-service-provider`,
    organizationSource: `${CANONICAL_BASE}/StructureDefinition/pcm-organization-source`,
    organizationSystem: `${CANONICAL_BASE}/StructureDefinition/pcm-organization-system`,
    endpoint: `${CANONICAL_BASE}/StructureDefinition/pcm-endpoint`,
    endpointSystem: `${CANONICAL_BASE}/StructureDefinition/pcm-endpoint-system`,
    healthcareServiceCanonical: `${CANONICAL_BASE}/StructureDefinition/pcm-healthcareservice-canonical`,
    healthcareServiceInstance: `${CANONICAL_BASE}/StructureDefinition/pcm-healthcareservice-instance`,
    consent: `${CANONICAL_BASE}/StructureDefinition/pcm-consent`
});

const CONSENT_POLICY = Object.freeze({
    authority: 'https://www.gov.il/',
    uri: 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024'
});

const B2B = Object.freeze({
    version: '1',
    purposeOfUse: `${CODE_SYSTEMS.actReason}#TREAT`
});

const SCOPES = Object.freeze({
    management: 'system/*.crus',
    legacyManagement: 'system/*.cruds',
    onlinePresence: 'system/Patient.rs?identifier',
    batchPresence: 'system/Patient.rs?identifier'
});

const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OPAQUE_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/;

/** Build operational endpoint URLs without changing canonical vocabulary. */
function buildOperationalEndpoints(oauthBase = OPERATIONAL.oauthBase, fhirBase = null) {
    const environment = ['production', 'test'].find(name => environmentEndpoints(name).oauthBase === oauthBase);
    if (!environment || (fhirBase !== null && fhirBase !== oauthBase)) {
        throw new TypeError('PCM logical endpoints must use one exact declared environment base');
    }
    return environmentEndpoints(environment);
}

/** Serialize the HL7 B2B Organization identity using exact system#value form. */
function serializeBusinessIdentifier(identifier) {
    if (!identifier || typeof identifier.system !== 'string' || typeof identifier.value !== 'string') {
        throw new TypeError('Business identifier requires distinct system and value strings');
    }
    if (!identifier.system || !identifier.value || identifier.system.includes('#') || identifier.value.includes('#')) {
        throw new TypeError('Business identifier system/value cannot be empty or contain #');
    }
    return `${identifier.system}#${identifier.value}`;
}

/** Return whether a value is an opaque, non-URL OAuth client identifier. */
function isOpaqueClientId(value) {
    return typeof value === 'string' && OPAQUE_CLIENT_ID_PATTERN.test(value) && !value.includes('://') && !value.includes('/');
}

/** Derive a stable opaque sandbox client ID from a role prefix and seed. */
function createOpaqueClientId(prefix, stableValue) {
    const digest = crypto.createHash('sha256').update(String(stableValue)).digest('hex').slice(0, 20);
    return `${String(prefix).replace(/[^A-Za-z0-9._~-]/g, '-')}-${digest}`;
}

/** Return whether a value is a base64url SHA-256 certificate thumbprint. */
function isThumbprint(value) {
    return typeof value === 'string' && THUMBPRINT_PATTERN.test(value);
}

/** Return whether PEM material is a P-256 EC private key. */
function isP256PrivateKey(pem) {
    try {
        const key = crypto.createPrivateKey(pem);
        return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
    } catch (_error) {
        return false;
    }
}

/** Validate the Israeli national-ID check digit. */
function hasValidIsraeliCheckDigit(value) {
    return hasValidIsraeliNationalId(value);
}

/** Validate one patient identifier against the active PCM identifier subset. */
function validatePatientIdentifier(identifier) {
    try {
        normalizePatientIdentifier(identifier);
        return [];
    } catch (error) {
        return [error.message];
    }
}

/** Enumerate certificate purposes required for each sandbox participant. */
function requiredCertificateRoles() {
    return Object.freeze({
        pcm: ['server'],
        presenceOrchestrator: ['mtls', 'assertion'],
        authenticationOrchestrator: ['mtls', 'assertion'],
        discoveryOrchestrator: ['mtls', 'assertion'],
        serviceProvider: ['mtls', 'assertion'],
        hospitalBServiceProvider: ['mtls', 'assertion'],
        referenceDataSource: ['server', 'mtls', 'assertion'],
        dsFhirServer: ['server'],
        untrustedClient: ['mtls']
    });
}

/** Return every pinned-contract violation in a team configuration object. */
function validateTeamContractConfig(config) {
    const errors = validateEnvironment(config);
    const { validateHealthOrganizations } = require('./health-organizations');
    errors.push(...validateHealthOrganizations(config));
    if (config?.conformance?.policyVersion !== POLICY_VERSION) {
        errors.push(`conformance.policyVersion must be ${POLICY_VERSION}`);
    }
    try {
        buildEffectivePolicy(config, {});
    } catch (error) {
        errors.push(error.message);
    }
    if (config?.contract?.pcmIgVersion !== PCM_IG.version) errors.push(`contract.pcmIgVersion must be ${PCM_IG.version}`);
    if (config?.contract?.pcmIgCommit !== PCM_IG.commit) errors.push(`contract.pcmIgCommit must be ${PCM_IG.commit}`);
    const operational = config?.contract?.operational;
    for (const key of ['oauthBase', 'fhirBase']) {
        if (typeof operational?.[key] !== 'string' || !/^https:\/\//.test(operational[key])) {
            errors.push(`contract.operational.${key} must be an HTTPS URL`);
        }
    }
    if (config?.contract?.canonicalBase !== CANONICAL_BASE) {
        errors.push(`contract.canonicalBase must be ${CANONICAL_BASE}`);
    }
    const orgs = config?.organizations || {};
    for (const [name, organization] of Object.entries(orgs)) {
        if (name === 'dataSources') {
            for (const [index, dataSource] of (organization || []).entries()) {
                validateOrganizationConfig(dataSource, `organizations.dataSources[${index}]`, errors);
            }
            continue;
        }
        if (!organization || typeof organization !== 'object' || Array.isArray(organization)) continue;
        validateOrganizationConfig(organization, `organizations.${name}`, errors);
    }
    const roles = requiredCertificateRoles();
    for (const [participant, purposes] of Object.entries(roles)) {
        for (const purpose of purposes) {
            const role = config?.certificateRoles?.[participant]?.[purpose];
            if (!role?.cert || !role?.key) errors.push(`certificateRoles.${participant}.${purpose} requires cert and key`);
        }
    }
    return errors;
}

/** Validate one configured Organization-like participant. */
function validateOrganizationConfig(organization, path, errors) {
    if (!organization || typeof organization !== 'object') return;
    if (organization.clientId !== undefined && !isOpaqueClientId(organization.clientId)) {
        errors.push(`${path}.clientId must be an opaque identifier independent of Resource.id`);
    }
    if (organization.businessIdentifier !== undefined) {
        if (organization.businessIdentifier?.system !== IDENTIFIER_SYSTEMS.organization || !organization.businessIdentifier?.value) {
            errors.push(`${path}.businessIdentifier must use the PCM organization identifier system`);
        }
    }
    if (organization.clientId && (
        organization.clientId === organization.id
        || organization.clientId === organization.businessIdentifier?.value
    )) {
        errors.push(`${path}.clientId must be independent of Resource.id and the Organization business identifier`);
    }
    if (organization.certThumbprint != null && !isThumbprint(organization.certThumbprint)) {
        errors.push(`${path}.certThumbprint must be a 43-character base64url SHA-256 thumbprint`);
    }
    for (const scope of organization.scopes || []) {
        if (scope === SCOPES.legacyManagement) errors.push(`${path}.scopes must not contain ${SCOPES.legacyManagement}`);
    }
    if (organization.pcmClientAuth) {
        if (!isOpaqueClientId(organization.pcmClientAuth.clientId)) {
            errors.push(`${path}.pcmClientAuth.clientId must be an opaque identifier`);
        }
        if (!isThumbprint(organization.pcmClientAuth.certThumbprint)) {
            errors.push(`${path}.pcmClientAuth.certThumbprint must be a 43-character base64url SHA-256 thumbprint`);
        }
    }
    if (organization.serverTrust?.certThumbprint != null && !isThumbprint(organization.serverTrust.certThumbprint)) {
        errors.push(`${path}.serverTrust.certThumbprint must be a 43-character base64url SHA-256 thumbprint`);
    }
}

/** Find the official identifier for a required NamingSystem. */
function officialIdentifier(resource, system) {
    return (resource.identifier || []).find(item => item.system === system && item.use === 'official');
}

/** Validate bootstrap invariants derived from the imported PCM profiles. */
function validateSeedResource(resource) {
    const errors = [];
    if (!resource || typeof resource !== 'object' || !resource.resourceType || !resource.id) {
        return ['seed resource requires resourceType and id'];
    }
    if (!resource.meta?.lastUpdated) errors.push('seed resource requires deterministic meta.lastUpdated');
    const certificateExtensions = (resource.extension || []).filter(extension => extension.url === EXTENSIONS.applicableCertificates);
    for (const certificateExtension of certificateExtensions) {
        for (const thumbprint of (certificateExtension.extension || []).filter(extension => extension.url === 'thumbprint')) {
            if (!isThumbprint(thumbprint.valueString)) errors.push('applicable certificate thumbprint must be base64url SHA-256');
        }
    }
    if (resource.resourceType === 'Organization') {
        const profile = resource.meta?.profile?.[0];
        const expectedIdentifierSystem = profile === PROFILES.organizationSystem
            ? 'http://institutions.health.gov.il/Institutions'
            : IDENTIFIER_SYSTEMS.organization;
        if (!officialIdentifier(resource, expectedIdentifierSystem)) errors.push('Organization requires authoritative official business identifier');
        if (!(resource.type || []).some(type => (type.coding || []).some(coding => coding.system === CODE_SYSTEMS.organizationType))) {
            errors.push('Organization requires PCM organization type coding');
        }
        if (!(resource.meta?.profile || []).some(profile => Object.values(PROFILES).includes(profile))) {
            errors.push('Organization requires a pinned PCM Organization profile');
        }
        if ((resource.type || []).length < 2) errors.push('Organization requires PCM and institutional type codings');
    } else if (resource.resourceType === 'Endpoint') {
        if (resource.connectionType?.system !== CODE_SYSTEMS.endpointConnectionType || resource.connectionType?.code !== 'hl7-fhir-rest') {
            errors.push('Endpoint connectionType must be hl7-fhir-rest');
        }
        const payload = resource.payloadType?.[0]?.coding?.[0];
        if (payload?.system !== CODE_SYSTEMS.endpointPayloadType || payload?.code !== 'any' || payload.display !== undefined) {
            errors.push('Endpoint payloadType must be endpoint-payload-type|any without display');
        }
        if (!/^https:\/\//.test(resource.address || '')) errors.push('Endpoint address must use HTTPS');
        if (!(resource.meta?.profile || []).some(profile => [PROFILES.endpoint, PROFILES.endpointSystem].includes(profile))) {
            errors.push('Endpoint requires a pinned PCM Endpoint profile');
        }
    } else if (resource.resourceType === 'HealthcareService') {
        const isCatalog = (resource.meta?.profile || []).includes(PROFILES.healthcareServiceCanonical);
        const expectedProfile = isCatalog ? PROFILES.healthcareServiceCanonical : PROFILES.healthcareServiceInstance;
        const expectedIdentifier = isCatalog ? IDENTIFIER_SYSTEMS.healthcareServiceCatalog : IDENTIFIER_SYSTEMS.healthcareServiceInstance;
        const expectedTag = isCatalog ? 'catalog' : 'instance';
        if (!officialIdentifier(resource, expectedIdentifier)) errors.push(`HealthcareService seed requires official ${expectedTag} identifier`);
        if (!(resource.meta?.profile || []).includes(expectedProfile)) errors.push(`HealthcareService seed requires the PCM ${expectedTag} profile`);
        if (!(resource.meta?.tag || []).some(tag => tag.system === CODE_SYSTEMS.metaTag && tag.code === expectedTag)) {
            errors.push(`HealthcareService seed requires the ${expectedTag} meta tag`);
        }
        const extensionUrls = (resource.extension || []).map(extension => extension.url);
        const requiredExtensions = [
            EXTENSIONS.serviceBusinessStatus,
            EXTENSIONS.accessMode,
            EXTENSIONS.accessDuration,
            EXTENSIONS.exampleQuery,
            EXTENSIONS.allowPatientBucketChange,
            EXTENSIONS.informationBucket,
            ...(isCatalog ? [] : [EXTENSIONS.basedOnCanonicalHealthcareService, EXTENSIONS.approvalWindow])
        ];
        for (const url of requiredExtensions) {
            if (!extensionUrls.includes(url)) errors.push(`HealthcareService requires ${url}`);
        }
        if (!resource.category?.length || resource.type?.length !== 1 || !resource.extraDetails) {
            errors.push('HealthcareService requires category, one type, and purpose details');
        }
        if (!isCatalog && !resource.providedBy?.reference) errors.push('HealthcareService instance requires providedBy');
    } else if (resource.resourceType === 'Consent') {
        if (resource.policyRule !== undefined) errors.push('Consent.policyRule is prohibited');
        if (resource.policy?.length !== 1
            || resource.policy[0].authority !== CONSENT_POLICY.authority
            || resource.policy[0].uri !== CONSENT_POLICY.uri) {
            errors.push('Consent requires exactly the fixed PCM policy');
        }
    }
    return errors;
}

module.exports = {
    B2B,
    CANONICAL_BASE,
    CODE_SYSTEMS,
    CONSENT_POLICY,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    OPERATIONAL,
    PCM_IG,
    PROFILES,
    SANDBOX_EXTENSIONS,
    SCOPES,
    SECURITY,
    THUMBPRINT_PATTERN,
    buildOperationalEndpoints,
    createOpaqueClientId,
    isOpaqueClientId,
    isP256PrivateKey,
    isThumbprint,
    hasValidIsraeliCheckDigit,
    requiredCertificateRoles,
    serializeBusinessIdentifier,
    validatePatientIdentifier,
    validateSeedResource,
    validateTeamContractConfig
};
