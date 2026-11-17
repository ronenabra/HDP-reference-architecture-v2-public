/**
 * Common closed FHIR interaction contract for the PCM sandbox.
 *
 * Resource-specific business rules remain in their services. This module owns
 * the transport-level invariants shared by every interaction: declared route
 * inventory, request-envelope validation, OperationOutcome responses, and
 * authoritative HTTP metadata.
 */

const FHIR_ROUTE_DEFINITIONS = Object.freeze([
    { path: '/.well-known/smart-configuration', methods: ['get'] },
    { path: '/metadata', methods: ['get'] },
    { path: '/Organization', methods: ['get', 'post'] },
    { path: '/Organization/_search', methods: ['post'] },
    { path: '/Organization/:id', methods: ['get', 'head', 'put'] },
    { path: '/Endpoint', methods: ['get', 'post'] },
    { path: '/Endpoint/_search', methods: ['post'] },
    { path: '/Endpoint/:id', methods: ['get', 'head', 'put'] },
    { path: '/HealthcareService', methods: ['get', 'post'] },
    { path: '/HealthcareService/_search', methods: ['post'] },
    { path: '/HealthcareService/:id/$request-catalog-update', methods: ['post'] },
    { path: '/HealthcareService/:id', methods: ['get', 'head', 'put'] },
    { path: '/Consent', methods: ['get', 'post'] },
    { path: '/Consent/_search', methods: ['post'] },
    { path: '/Consent/:id', methods: ['get', 'head', 'put'] },
    { path: '/Contract', methods: ['get'] },
    { path: '/Contract/_search', methods: ['post'] },
    { path: '/Contract/:id', methods: ['get', 'head'] }
]);

const DTO_FIELDS = Object.freeze({
    'Organization.create': new Set(['resourceType', 'id', 'meta', 'extension', 'name', 'contact']),
    'Organization.update': new Set(['resourceType', 'id', 'meta', 'extension', 'name', 'contact', 'endpoint']),
    'Endpoint.create': new Set(['resourceType', 'id', 'meta', 'extension', 'status', 'connectionType', 'payloadType', 'address']),
    'Endpoint.update': new Set(['resourceType', 'id', 'meta', 'extension', 'status', 'connectionType', 'payloadType', 'address']),
    'HealthcareService.create': new Set(['resourceType', 'id', 'meta', 'extension', 'category', 'type', 'name', 'extraDetails']),
    'HealthcareService.update': new Set(['resourceType', 'id', 'meta', 'extension']),
    'Consent.create': new Set(['resourceType', 'id', 'meta', 'extension', 'status', 'scope', 'category', 'patient', 'policy']),
    'Consent.update': new Set(['resourceType', 'id', 'meta', 'extension', 'status', 'scope', 'category', 'policy'])
});

const DTO_REQUIRED_FIELDS = Object.freeze({
    'Organization.create': ['resourceType', 'name'],
    'Organization.update': ['resourceType', 'id', 'name'],
    'Endpoint.create': ['resourceType', 'status', 'connectionType', 'payloadType', 'address'],
    'Endpoint.update': ['resourceType', 'id', 'status', 'connectionType', 'payloadType', 'address'],
    'HealthcareService.update': ['resourceType', 'id', 'extension'],
    'Consent.create': ['resourceType', 'status', 'scope', 'category', 'patient', 'policy', 'extension'],
    'Consent.update': ['resourceType', 'id', 'status', 'scope', 'category', 'policy']
});

class FHIRContractError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     * @param {string} code
     */
    constructor(message, status = 400, code = 'invalid') {
        super(message);
        this.name = 'FHIRContractError';
        this.status = status;
        this.code = code;
    }
}

/** @returns {object} */
function operationOutcome(diagnostics, code = 'invalid', severity = 'error') {
    return {
        resourceType: 'OperationOutcome',
        issue: [{ severity, code, diagnostics }]
    };
}

/** Send a uniform FHIR error response. */
function sendOutcome(res, status, diagnostics, code = 'invalid') {
    res.type?.('application/fhir+json');
    return res.status(status).json(operationOutcome(diagnostics, code));
}

/** Reject any populated modifierExtension anywhere in an inbound resource. */
function assertNoModifierExtensions(value, location = 'resource') {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'modifierExtension')) {
        throw new FHIRContractError(`Unsupported modifierExtension at ${location}`);
    }
    for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(child)) child.forEach((item, index) => assertNoModifierExtensions(item, `${location}.${key}[${index}]`));
        else if (child && typeof child === 'object') assertNoModifierExtensions(child, `${location}.${key}`);
    }
}

/** Return true when a CodeableConcept contains one exact coding. */
function hasCoding(concept, system, code) {
    return Array.isArray(concept?.coding)
        && concept.coding.some(coding => coding.system === system && coding.code === code);
}

/**
 * Validate the closed common envelope for a create or update request.
 * Resource-specific validators may impose narrower permitted/fixed fields.
 */
function validateWriteRequest(resource, { resourceType, interaction, id } = {}) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        throw new FHIRContractError(`${resourceType} request body must be a JSON object`);
    }
    if (resource.resourceType !== resourceType) {
        throw new FHIRContractError(`resourceType must be ${resourceType}`);
    }
    const permitted = DTO_FIELDS[`${resourceType}.${interaction}`];
    if (!permitted) throw new FHIRContractError(`Unsupported ${resourceType} ${interaction} interaction`, 405, 'not-supported');
    const unknown = Object.keys(resource).filter(field => !permitted.has(field));
    if (unknown.length) throw new FHIRContractError(`Unsupported ${resourceType} field(s): ${unknown.join(', ')}`);
    const missing = (DTO_REQUIRED_FIELDS[`${resourceType}.${interaction}`] || [])
        .filter(field => resource[field] === undefined || resource[field] === null || resource[field] === '');
    if (missing.length) throw new FHIRContractError(`Missing required ${resourceType} field(s): ${missing.join(', ')}`);
    if (resource.meta?.versionId !== undefined || resource.meta?.lastUpdated !== undefined) {
        throw new FHIRContractError('Client-supplied meta.versionId and meta.lastUpdated are prohibited');
    }
    const metaFields = Object.keys(resource.meta || {});
    if (metaFields.some(field => field !== 'profile')) {
        throw new FHIRContractError('Only optional meta.profile may be supplied by a client');
    }
    assertNoModifierExtensions(resource);
    try { require('../public-fhir').assertPublic(resource); } catch (error) { throw new FHIRContractError(error.message); }
    if (interaction === 'update') {
        if (!resource.id) throw new FHIRContractError('Update body id is required');
        if (resource.id !== id) throw new FHIRContractError('Update body id must match the URL id');
    }
    if (resourceType === 'Endpoint') {
        if (!['active', 'suspended', ...(interaction === 'update' ? ['off'] : [])].includes(resource.status)) {
            throw new FHIRContractError(`Endpoint.status is not permitted for ${interaction}`);
        }
        if (resource.connectionType?.system !== 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type'
            || resource.connectionType?.code !== 'hl7-fhir-rest') {
            throw new FHIRContractError('Endpoint.connectionType must be the fixed hl7-fhir-rest coding');
        }
        const payloadCoding = resource.payloadType?.[0]?.coding?.[0];
        if (resource.payloadType?.length !== 1 || resource.payloadType[0]?.coding?.length !== 1
            || payloadCoding?.system !== 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type'
            || payloadCoding?.code !== 'any' || payloadCoding.display !== undefined) {
            throw new FHIRContractError('Endpoint.payloadType must be the fixed any payload coding');
        }
        try {
            if (new URL(resource.address).protocol !== 'https:') throw new Error('not HTTPS');
        } catch {
            throw new FHIRContractError('Endpoint.address must be an absolute HTTPS URI');
        }
    }
    if (resourceType === 'Consent' && resource.status !== (interaction === 'create' ? 'proposed' : 'inactive')) {
        throw new FHIRContractError(`Consent.status must be ${interaction === 'create' ? 'proposed' : 'inactive'}`);
    }
    if (resourceType === 'Consent') {
        if (resource.scope?.coding?.length !== 1
            || !hasCoding(resource.scope, 'http://terminology.hl7.org/CodeSystem/consentscope', 'patient-privacy')) {
            throw new FHIRContractError('Consent.scope must contain exactly the fixed patient-privacy coding');
        }
        if (resource.category?.length !== 1
            || !hasCoding(resource.category[0], 'http://terminology.hl7.org/CodeSystem/v3-ActCode', 'INFA')) {
            throw new FHIRContractError('Consent.category must contain exactly the fixed INFA coding');
        }
        if (resource.policy?.length !== 1
            || resource.policy[0]?.authority !== 'https://www.gov.il/'
            || resource.policy[0]?.uri !== 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024') {
            throw new FHIRContractError('Consent.policy must equal the fixed legal policy');
        }
        // FHIR R4 ppc-1 requires policy or policyRule; PCM fixes one policy and
        // prohibits policyRule, so the closed interaction must never admit both.
        if (resource.policyRule !== undefined) {
            throw new FHIRContractError('Consent.policyRule is prohibited by the PCM ppc-1 projection');
        }
        if (interaction === 'create' && !resource.patient?.identifier?.system) {
            throw new FHIRContractError('Consent.patient must contain one logical identifier');
        }
    }
    if (resourceType === 'HealthcareService' && interaction === 'create') {
        const basedOn = (resource.extension || []).filter(extension =>
            extension.url === 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice');
        const required = basedOn.length
            ? ['resourceType', 'extension']
            : ['resourceType', 'name', 'category', 'type', 'extraDetails', 'extension'];
        const missingService = required.filter(field => resource[field] === undefined || resource[field] === null || resource[field] === '');
        if (missingService.length || basedOn.length > 1) {
            throw new FHIRContractError(`Invalid HealthcareService registration projection${missingService.length ? `; missing ${missingService.join(', ')}` : ''}`);
        }
    }
    if (resourceType === 'HealthcareService' && interaction === 'update') {
        const statusExtensions = (resource.extension || []).filter(extension =>
            extension.url === 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-service-business-status');
        const code = statusExtensions[0]?.valueCoding?.code;
        if (statusExtensions.length !== 1
            || statusExtensions[0]?.valueCoding?.system !== 'http://pcm.fhir.health.gov.il/cs/pcm-service-business-status'
            || !['active', 'suspended', 'cancelled'].includes(code)) {
            throw new FHIRContractError('HealthcareService update requires exactly one permitted businessStatus extension');
        }
    }
    return JSON.parse(JSON.stringify(resource));
}

/** Build absolute resource metadata without trusting forwarded host headers. */
function resourceLocation(req, resource) {
    const protocol = req.protocol || 'https';
    const host = req.get?.('host') || req.headers?.host || 'pcm.local';
    return `${protocol}://${host}/r4/${resource.resourceType}/${resource.id}`;
}

/** Add response metadata owned by the server. */
function setResourceHeaders(req, res, resource, { created = false } = {}) {
    const location = resourceLocation(req, resource);
    const version = resource.meta?.versionId;
    const updated = resource.meta?.lastUpdated;
    res.type?.('application/fhir+json');
    if (created) res.set?.('Location', location);
    res.set?.('Content-Location', location);
    if (version) res.set?.('ETag', `W/"${version}"`);
    if (updated) res.set?.('Last-Modified', new Date(updated).toUTCString());
    return res;
}

/** Send a FHIR resource with authoritative success headers. */
function sendResource(req, res, resource, { status = 200, created = false, head = false } = {}) {
    setResourceHeaders(req, res, resource, { created });
    if (head) return res.status(status).end();
    return res.status(status).json(require('../public-fhir').publicDto(resource));
}

/** Convert contract exceptions to FHIR responses and rethrow programming errors. */
function handleContractError(res, error) {
    if (!(error instanceof FHIRContractError)) throw error;
    return sendOutcome(res, error.status, error.message, error.code);
}

module.exports = {
    FHIRContractError,
    FHIR_ROUTE_DEFINITIONS,
    DTO_FIELDS,
    assertNoModifierExtensions,
    handleContractError,
    hasCoding,
    operationOutcome,
    resourceLocation,
    sendOutcome,
    sendResource,
    setResourceHeaders,
    validateWriteRequest
};
