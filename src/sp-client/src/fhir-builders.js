'use strict';

/** Closed interaction-specific FHIR request builders for the SP client. */
const {
    CODE_SYSTEMS,
    CONSENT_POLICY,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    PROFILES,
    validatePatientIdentifier
} = require('./constants');

const REQUEST_PROFILES = Object.freeze({
    organizationCreate: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-organization-service-provider-create',
    endpointCreate: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-endpoint-create',
    endpointUpdate: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-endpoint-update',
    serviceExisting: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-existing-registration-submit',
    serviceNew: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-new-service-submit',
    serviceStatus: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-instance-business-status-update',
    consentSubmit: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-consent-submit',
    consentDeactivate: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-consent-deactivate',
    catalogProposal: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-catalog-update-proposal',
    catalogUpdate: 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-request-catalog-update-parameters'
});
const SCOPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/consentscope';
const ACT_CODE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const CATALOG_UPDATE_RESPONSE_PROFILE = 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-request-catalog-update-response';

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

function ensureObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
    return value;
}

function exactKeys(value, allowed, required, name) {
    ensureObject(value, name);
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    const missing = required.filter(key => !Object.hasOwn(value, key));
    if (unknown.length || missing.length) {
        throw new TypeError(`${name} has ${unknown.length ? `unknown fields: ${unknown.join(', ')}` : `missing fields: ${missing.join(', ')}`}`);
    }
}

function requestMeta(profile) { return { profile: [profile] }; }

function validateMeta(meta, profile) {
    if (meta === undefined) return;
    exactKeys(meta, ['profile'], ['profile'], 'meta');
    if (!Array.isArray(meta.profile) || meta.profile.length !== 1 || meta.profile[0] !== profile) {
        throw new TypeError(`meta.profile must contain only ${profile}`);
    }
}

function assertNoModifierExtension(value, path = 'request') {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'modifierExtension')) throw new TypeError(`${path}.modifierExtension is unsupported`);
    for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(child)) child.forEach((item, index) => assertNoModifierExtension(item, `${path}.${key}[${index}]`));
        else assertNoModifierExtension(child, `${path}.${key}`);
    }
}

function validUcumDuration(duration) {
    return duration && typeof duration.value === 'number' && Number.isFinite(duration.value)
        && duration.system === 'http://unitsofmeasure.org'
        && typeof duration.code === 'string' && duration.code.length > 0;
}

function validateServiceDefinition(body) {
    const extensions = Array.isArray(body.extension) ? body.extension : [];
    const values = url => extensions.filter(extension => extension.url === url);
    const accessMode = values(EXTENSIONS.accessMode);
    const accessDuration = values(EXTENSIONS.accessDuration);
    const examples = values(EXTENSIONS.exampleQuery);
    const allowChange = values(EXTENSIONS.allowPatientBucketChange);
    const buckets = values(EXTENSIONS.informationBucket);
    const bucketCodes = [];
    for (const bucket of buckets) {
        try {
            bucketCodes.push(require('../../shared/information-buckets').parseInformationBucket(bucket).coding.code);
        } catch (error) { throw new TypeError(error.message); }
    }
    if (body.type?.length !== 1 || body.type[0]?.coding?.length !== 1
        || body.type[0].coding[0].system !== ACT_CODE_SYSTEM || body.type[0].coding[0].code !== 'INFA'
        || body.type[0].coding[0].display !== 'information access'
        || accessMode.length !== 1 || !['one-time', 'continuous'].includes(accessMode[0].valueCode)
        || accessDuration.length !== 1 || !validUcumDuration(accessDuration[0].valueDuration)
        || examples.length < 1 || examples.some(extension => typeof extension.valueString !== 'string' || !extension.valueString)
        || allowChange.length !== 1 || typeof allowChange[0].valueBoolean !== 'boolean'
        || buckets.length < 1 || new Set(bucketCodes).size !== bucketCodes.length) {
        throw new TypeError('HealthcareService definition does not satisfy the closed profile');
    }
}

/** Keep GUID admission explicit at the local clinical boundary. */
function validateClinicalIdentifier(identifier, options) {
    try { require('../../shared/identity-mapping').normalizePatientIdentifier(identifier, options); return []; }
    catch (error) { return [error.message]; }
}

function buildConsentSubmit(patientIdentifier, serviceId, { declareProfile = true, allowSandboxGuid = false } = {}) {
    const errors = validateClinicalIdentifier(patientIdentifier, { allowSandboxGuid });
    if (errors.length) throw new TypeError(errors.join('; '));
    if (typeof serviceId !== 'string' || !/^[A-Za-z0-9\-.]{1,64}$/.test(serviceId)) throw new TypeError('HealthcareService id is invalid');
    const body = {
        resourceType: 'Consent',
        ...(declareProfile ? { meta: requestMeta(REQUEST_PROFILES.consentSubmit) } : {}),
        status: 'proposed',
        scope: { coding: [{ system: SCOPE_SYSTEM, code: 'patient-privacy' }] },
        category: [{ coding: [{ system: ACT_CODE_SYSTEM, code: 'INFA' }] }],
        patient: { identifier: { system: patientIdentifier.system, value: patientIdentifier.value } },
        policy: [{ authority: CONSENT_POLICY.authority, uri: CONSENT_POLICY.uri }],
        extension: [{ url: EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${serviceId}` } }]
    };
    return validateConsentSubmit(body, { allowSandboxGuid });
}

function validateConsentSubmit(body, identityOptions) {
    assertNoModifierExtension(body);
    exactKeys(body, ['resourceType', 'id', 'meta', 'status', 'scope', 'category', 'patient', 'policy', 'extension'], ['resourceType', 'status', 'scope', 'category', 'patient', 'policy', 'extension'], 'Consent submit');
    if (body.resourceType !== 'Consent') throw new TypeError('Consent submit resourceType is invalid');
    validateMeta(body.meta, REQUEST_PROFILES.consentSubmit);
    if (body.status !== 'proposed' || body.scope?.coding?.length !== 1
        || body.scope.coding[0].system !== SCOPE_SYSTEM || body.scope.coding[0].code !== 'patient-privacy'
        || body.category?.length !== 1 || body.category[0]?.coding?.length !== 1
        || body.category[0].coding[0].system !== ACT_CODE_SYSTEM || body.category[0].coding[0].code !== 'INFA') {
        throw new TypeError('Consent submit fixed status/scope/category is invalid');
    }
    const patientErrors = validateClinicalIdentifier(body.patient?.identifier, identityOptions);
    if (patientErrors.length || body.patient?.reference !== undefined) throw new TypeError(patientErrors.join('; ') || 'Consent patient must be identifier-only');
    if (body.policy?.length !== 1 || body.policy[0].authority !== CONSENT_POLICY.authority || body.policy[0].uri !== CONSENT_POLICY.uri) {
        throw new TypeError('Consent submit policy is invalid');
    }
    if (body.extension?.length !== 1 || body.extension[0].url !== EXTENSIONS.pcmService
        || !/^HealthcareService\/[A-Za-z0-9\-.]{1,64}$/.test(body.extension[0].valueReference?.reference || '')) {
        throw new TypeError('Consent submit pcmService is invalid');
    }
    return clone(body);
}

function buildConsentDeactivate(consentId) {
    if (typeof consentId !== 'string' || !/^[A-Za-z0-9\-.]{1,64}$/.test(consentId)) {
        throw new TypeError('Consent logical id is invalid');
    }
    const body = {
        resourceType: 'Consent', id: consentId,
        meta: requestMeta(REQUEST_PROFILES.consentDeactivate),
        status: 'inactive',
        scope: { coding: [{ system: SCOPE_SYSTEM, code: 'patient-privacy' }] },
        category: [{ coding: [{ system: ACT_CODE_SYSTEM, code: 'INFA' }] }],
        policy: [{ authority: CONSENT_POLICY.authority, uri: CONSENT_POLICY.uri }]
    };
    exactKeys(body, ['resourceType', 'id', 'meta', 'status', 'scope', 'category', 'policy'], ['resourceType', 'id', 'status', 'scope', 'category', 'policy'], 'Consent deactivate');
    return body;
}

function buildOrganizationCreate(input) {
    exactKeys(input, ['name', 'contact', 'extension', 'declareProfile'], ['name'], 'Organization create input');
    const { name, contact = [], extension = [], declareProfile = true } = input;
    if (typeof name !== 'string' || !name.trim()) throw new TypeError('Organization name is required');
    if (!Array.isArray(contact) || contact.some(item => !item?.purpose)) {
        throw new TypeError('Every Organization contact override requires purpose');
    }
    if (!Array.isArray(extension)) throw new TypeError('Organization extension must be an array');
    if (extension.some(item => [EXTENSIONS.oauthRedirectUri, EXTENSIONS.applicableCertificates].includes(item?.url))) {
        throw new TypeError('Organization create cannot supply PCM-managed extensions');
    }
    const body = {
        resourceType: 'Organization',
        ...(declareProfile ? { meta: requestMeta(REQUEST_PROFILES.organizationCreate) } : {}),
        name: name.trim(),
        ...(contact.length ? { contact: clone(contact) } : {}),
        ...(extension.length ? { extension: clone(extension) } : {})
    };
    assertNoModifierExtension(body);
    exactKeys(body, ['resourceType', 'meta', 'name', 'contact', 'extension'], ['resourceType', 'name'], 'Organization create');
    return body;
}

function buildOrganizationUpdate(resource) {
    ensureObject(resource, 'Organization');
    if (resource.resourceType !== 'Organization' || !resource.id || !resource.name) throw new TypeError('Organization update requires resourceType, id, and name');
    const isSource = resource.type?.some(type => type.coding?.some(coding => coding.system === CODE_SYSTEMS.organizationType && coding.code === 'source'));
    const body = {
        resourceType: 'Organization', id: resource.id, name: resource.name,
        ...(Array.isArray(resource.contact) ? { contact: clone(resource.contact) } : {}),
        ...(isSource ? { endpoint: clone(resource.endpoint || []) } : {})
    };
    if (Array.isArray(body.contact) && body.contact.some(item => !item?.purpose)) {
        throw new TypeError('Every Organization contact override requires purpose');
    }
    if (isSource && (body.endpoint.length !== 1 || !/^Endpoint\/[A-Za-z0-9\-.]{1,64}$/.test(body.endpoint[0]?.reference || ''))) {
        throw new TypeError('Data Source Organization update requires one local Endpoint reference');
    }
    assertNoModifierExtension(body);
    exactKeys(body, ['resourceType', 'id', 'name', 'contact', 'endpoint'], ['resourceType', 'id', 'name', ...(isSource ? ['endpoint'] : [])], 'Organization update');
    return body;
}

function buildEndpointWrite(resource, interaction = 'update') {
    ensureObject(resource, 'Endpoint');
    const required = ['resourceType', ...(interaction === 'update' ? ['id'] : []), 'status', 'connectionType', 'payloadType', 'address'];
    exactKeys(resource, required, required, `Endpoint ${interaction}`);
    const body = Object.fromEntries(required.map(key => [key, clone(resource[key])]));
    body.meta = requestMeta(interaction === 'update' ? REQUEST_PROFILES.endpointUpdate : REQUEST_PROFILES.endpointCreate);
    assertNoModifierExtension(body);
    exactKeys(body, [...required, 'meta'], [...required, 'meta'], `Endpoint ${interaction}`);
    const allowedStatus = interaction === 'update' ? ['active', 'suspended', 'off'] : ['active', 'suspended'];
    if (body.resourceType !== 'Endpoint' || !allowedStatus.includes(body.status)
        || body.connectionType?.system !== CODE_SYSTEMS.endpointConnectionType
        || body.connectionType?.code !== 'hl7-fhir-rest'
        || !Array.isArray(body.payloadType) || body.payloadType.length !== 1
        || body.payloadType[0]?.coding?.length !== 1
        || body.payloadType[0].coding[0].system !== CODE_SYSTEMS.endpointPayloadType
        || body.payloadType[0].coding[0].code !== 'any'
        || (() => {
            try {
                const address = new URL(body.address);
                return address.protocol !== 'https:' || address.username || address.password || address.hash;
            } catch (_error) { return true; }
        })()) throw new TypeError(`Endpoint ${interaction} fixed fields are invalid`);
    return body;
}

function buildExistingServiceRegistration(canonicalId) {
    if (typeof canonicalId !== 'string' || !/^[A-Za-z0-9\-.]{1,64}$/.test(canonicalId)) {
        throw new TypeError('Canonical service id is invalid');
    }
    return {
        resourceType: 'HealthcareService', meta: requestMeta(REQUEST_PROFILES.serviceExisting),
        extension: [{
            url: EXTENSIONS.basedOnCanonicalHealthcareService,
            valueReference: { reference: `HealthcareService/${canonicalId}` }
        }]
    };
}

function buildNewServiceRegistration(definition) {
    ensureObject(definition, 'new HealthcareService');
    const allowed = ['resourceType', 'name', 'category', 'type', 'extraDetails', 'extension'];
    exactKeys(definition, allowed, allowed, 'new HealthcareService');
    const body = clone(definition);
    body.meta = requestMeta(REQUEST_PROFILES.serviceNew);
    const extensions = Array.isArray(body.extension) ? body.extension : [];
    if (body.resourceType !== 'HealthcareService'
        || typeof body.name !== 'string' || !body.name.trim()
        || !Array.isArray(body.category) || !body.category.length
        || typeof body.extraDetails !== 'string' || !body.extraDetails.trim()
        || extensions.some(extension => [
            EXTENSIONS.basedOnCanonicalHealthcareService,
            EXTENSIONS.serviceBusinessStatus,
            EXTENSIONS.approvalWindow
        ].includes(extension.url))) {
        throw new TypeError('New service request does not satisfy the closed submit profile');
    }
    validateServiceDefinition(body);
    assertNoModifierExtension(body);
    exactKeys(body, [...allowed, 'meta'], [...allowed, 'meta'], 'new HealthcareService request');
    return body;
}

function buildServiceStatusUpdate(serviceId, targetStatus) {
    if (typeof serviceId !== 'string' || !/^[A-Za-z0-9\-.]{1,64}$/.test(serviceId)) {
        throw new TypeError('HealthcareService id is invalid');
    }
    if (!['active', 'suspended', 'cancelled'].includes(targetStatus)) throw new TypeError('Unsupported owner service status target');
    return {
        resourceType: 'HealthcareService', id: serviceId,
        meta: requestMeta(REQUEST_PROFILES.serviceStatus),
        extension: [{
            url: EXTENSIONS.serviceBusinessStatus,
            valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: targetStatus }
        }]
    };
}

function buildCatalogUpdateParameters(proposedCatalog, reason) {
    ensureObject(proposedCatalog, 'proposedCatalog');
    const allowed = ['resourceType', 'id', 'meta', 'identifier', 'active', 'name', 'category', 'type', 'extraDetails', 'extension'];
    exactKeys(proposedCatalog, allowed, allowed, 'proposedCatalog');
    exactKeys(proposedCatalog.meta, ['profile', 'versionId', 'lastUpdated', 'tag'], ['profile', 'tag'], 'proposedCatalog.meta');
    if (proposedCatalog.resourceType !== 'HealthcareService' || !proposedCatalog.id
        || proposedCatalog.meta?.profile?.length !== 1
        || proposedCatalog.meta.profile[0] !== REQUEST_PROFILES.catalogProposal
        || proposedCatalog.meta?.tag?.length !== 1
        || proposedCatalog.meta.tag[0].system !== CODE_SYSTEMS.metaTag || proposedCatalog.meta.tag[0].code !== 'catalog'
        || !Array.isArray(proposedCatalog.identifier) || proposedCatalog.identifier.length !== 1
        || !proposedCatalog.identifier.some(identifier => identifier.use === 'official'
            && identifier.system === IDENTIFIER_SYSTEMS.healthcareServiceCatalog && identifier.value)
        || typeof proposedCatalog.active !== 'boolean'
        || typeof proposedCatalog.name !== 'string' || !proposedCatalog.name.trim()
        || !Array.isArray(proposedCatalog.category) || !proposedCatalog.category.length
        || !Array.isArray(proposedCatalog.type) || proposedCatalog.type.length !== 1
        || typeof proposedCatalog.extraDetails !== 'string' || !proposedCatalog.extraDetails.trim()
        || !Array.isArray(proposedCatalog.extension)) {
        throw new TypeError('Catalog update requires one complete authoritative catalog proposal');
    }
    const businessStatuses = proposedCatalog.extension.filter(extension => extension.url === EXTENSIONS.serviceBusinessStatus);
    if (businessStatuses.length !== 1
        || businessStatuses[0].valueCoding?.system !== CODE_SYSTEMS.serviceBusinessStatus
        || !['pending', 'active', 'rejected', 'frozen', 'suspended', 'cancelled'].includes(businessStatuses[0].valueCoding?.code)) {
        throw new TypeError('Catalog proposal requires one authoritative business status');
    }
    if (proposedCatalog.extension.some(extension => [
        EXTENSIONS.basedOnCanonicalHealthcareService,
        EXTENSIONS.approvalWindow
    ].includes(extension.url))) throw new TypeError('Catalog proposal contains an instance-only extension');
    validateServiceDefinition(proposedCatalog);
    assertNoModifierExtension(proposedCatalog, 'proposedCatalog');
    const parameter = [{ name: 'proposedCatalog', resource: clone(proposedCatalog) }];
    if (reason !== undefined) {
        if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('Catalog update reason must be non-empty');
        parameter.push({ name: 'reason', valueString: reason.trim() });
    }
    return { resourceType: 'Parameters', meta: requestMeta(REQUEST_PROFILES.catalogUpdate), parameter };
}

function projectUpdate(resourceType, resource) {
    if (resourceType === 'Organization') return buildOrganizationUpdate(resource);
    if (resourceType === 'Endpoint') {
        const fields = ['resourceType', 'id', 'status', 'connectionType', 'payloadType', 'address'];
        return buildEndpointWrite(Object.fromEntries(fields.map(key => [key, clone(resource[key])])), 'update');
    }
    if (resourceType === 'Consent') return buildConsentDeactivate(resource.id);
    throw new TypeError(`Generic update is unavailable for ${resourceType}; use its interaction-specific builder`);
}

/** Validate a complete authoritative FHIR resource returned by PCM. */
function validateAuthoritativeResource(resource, expectedType) {
    ensureObject(resource, `${expectedType} response`);
    assertNoModifierExtension(resource, `${expectedType} response`);
    if (resource.resourceType !== expectedType || !/^[A-Za-z0-9\-.]{1,64}$/.test(resource.id || '')
        || typeof resource.meta?.versionId !== 'string' || !resource.meta.versionId
        || Number.isNaN(Date.parse(resource.meta?.lastUpdated || ''))) {
        throw new TypeError(`${expectedType} response lacks authoritative identity or version metadata`);
    }
    const profiles = resource.meta?.profile;
    if (!Array.isArray(profiles) || profiles.length !== 1) throw new TypeError(`${expectedType} response has an invalid profile`);
    if (expectedType === 'Organization') {
        const allowed = [PROFILES.organizationParent, PROFILES.organizationServiceProvider, PROFILES.organizationSource, PROFILES.organizationSystem];
        if (!allowed.includes(profiles[0]) || typeof resource.active !== 'boolean'
            || !resource.identifier?.some(identifier => identifier.use === 'official' && identifier.value)) {
            throw new TypeError('Organization response is not an authoritative PCM Organization');
        }
    } else if (expectedType === 'Endpoint') {
        if (profiles[0] !== PROFILES.endpoint || !['active', 'suspended', 'off'].includes(resource.status)
            || resource.connectionType?.system !== CODE_SYSTEMS.endpointConnectionType
            || resource.connectionType?.code !== 'hl7-fhir-rest'
            || resource.payloadType?.length !== 1 || resource.payloadType[0]?.coding?.length !== 1
            || resource.payloadType[0].coding[0].system !== CODE_SYSTEMS.endpointPayloadType
            || resource.payloadType[0].coding[0].code !== 'any'
            || typeof resource.address !== 'string'
            || !/^Organization\/[A-Za-z0-9\-.]{1,64}$/.test(resource.managingOrganization?.reference || '')) {
            throw new TypeError('Endpoint response is not an authoritative PCM Endpoint');
        }
    } else if (expectedType === 'HealthcareService') {
        const identifierSystem = profiles[0] === PROFILES.healthcareServiceInstance
            ? IDENTIFIER_SYSTEMS.healthcareServiceInstance
            : (profiles[0] === PROFILES.healthcareServiceCanonical ? IDENTIFIER_SYSTEMS.healthcareServiceCatalog : null);
        if (!identifierSystem || typeof resource.active !== 'boolean'
            || !resource.identifier?.some(identifier => identifier.use === 'official'
                && identifier.system === identifierSystem && identifier.value)
            || typeof resource.name !== 'string' || !resource.name
            || !Array.isArray(resource.category) || !resource.category.length
            || !Array.isArray(resource.type) || resource.type.length !== 1
            || typeof resource.extraDetails !== 'string' || !resource.extraDetails
            || resource.extension?.filter(extension => extension.url === EXTENSIONS.serviceBusinessStatus).length !== 1) {
            throw new TypeError('HealthcareService response is not an authoritative PCM service');
        }
    } else if (expectedType === 'Consent') {
        if (profiles[0] !== PROFILES.consent
            || !resource.identifier?.some(identifier => identifier.use === 'official'
                && identifier.system === IDENTIFIER_SYSTEMS.consent && identifier.value)
            || !['proposed', 'active', 'rejected', 'inactive', 'entered-in-error'].includes(resource.status)
            || resource.policy?.length !== 1 || resource.policy[0].authority !== CONSENT_POLICY.authority
            || resource.policy[0].uri !== CONSENT_POLICY.uri || !resource.patient?.identifier?.system
            || resource.extension?.filter(extension => extension.url === EXTENSIONS.consentBusinessStatus).length !== 1) {
            throw new TypeError('Consent response is not an authoritative PCM Consent');
        }
    } else {
        throw new TypeError(`Unsupported authoritative response type: ${expectedType}`);
    }
    return clone(resource);
}

/** Validate the closed synchronous catalog-update acknowledgement. */
function validateCatalogUpdateResponse(response) {
    exactKeys(response, ['resourceType', 'id', 'meta', 'parameter'], ['resourceType', 'meta', 'parameter'], 'catalog update response');
    if (response.resourceType !== 'Parameters' || response.meta?.profile?.length !== 1
        || response.meta.profile[0] !== CATALOG_UPDATE_RESPONSE_PROFILE || !Array.isArray(response.parameter)) {
        throw new TypeError('Catalog update response is not the closed acknowledgement');
    }
    const requestIds = response.parameter.filter(parameter => parameter.name === 'requestId');
    const statuses = response.parameter.filter(parameter => parameter.name === 'status');
    const messages = response.parameter.filter(parameter => parameter.name === 'message');
    const exactParameter = (parameter, valueField) => {
        exactKeys(parameter, ['name', valueField], ['name', valueField], `catalog response ${parameter.name}`);
    };
    [...requestIds, ...messages].forEach(parameter => exactParameter(parameter, 'valueString'));
    statuses.forEach(parameter => exactParameter(parameter, 'valueCode'));
    if (requestIds.length !== 1 || typeof requestIds[0].valueString !== 'string' || !requestIds[0].valueString
        || statuses.length !== 1 || statuses[0].valueCode !== 'received'
        || messages.length > 1 || response.parameter.length !== requestIds.length + statuses.length + messages.length) {
        throw new TypeError('Catalog update response is not the closed acknowledgement');
    }
    return clone(response);
}

module.exports = {
    REQUEST_PROFILES,
    buildCatalogUpdateParameters,
    buildConsentDeactivate,
    buildConsentSubmit,
    buildEndpointWrite,
    buildExistingServiceRegistration,
    buildNewServiceRegistration,
    buildOrganizationCreate,
    buildOrganizationUpdate,
    buildServiceStatusUpdate,
    projectUpdate,
    validateAuthoritativeResource,
    validateCatalogUpdateResponse,
    validateConsentSubmit
};
