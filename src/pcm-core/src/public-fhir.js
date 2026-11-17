'use strict';

/** Public FHIR DTOs and the closed PCM-owned metadata boundary (not a URN policy). */
const { EXTENSIONS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const SCHEMA = 'pcm-public-fhir/1';
const prefix = 'urn:pcm:sandbox:';
const SERVICE_URLS = new Set(['service-grant', 'approval-scope-option', 'service-confidentiality-policy', 'service-master-data'].map(value => prefix + value));
const PRIVATE_URLS = new Set([...SERVICE_URLS, prefix + 'consent-scope-snapshot', SANDBOX_EXTENSIONS.approvedTokenScope,
    SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, SANDBOX_EXTENSIONS.dataSourceServerTrust, prefix + 'patient-sampling:fixed-query']);
const PRIVATE_TAGS = new Set(['source-change', 'consent-cancellation', 'service-disabled', 'seed-definition', 'full-clinical-access', 'patient-sampler'].map(value => prefix + value));
const PRIVATE_KEYS = new Set(['approvalSnapshot', 'approvalRecord', 'serviceGrant', 'privateState', '_private', 'authoring', 'historyMode', 'approvedAt', 'publicVersionAtDecision', 'serverTrust', 'sessionId', 'discoveredEndpoint', 'discoveredEndpoints']);
/** Stable public rejection without echoing a private input payload. */
class PublicMetadataError extends Error {
    constructor() { super('Private PCM metadata is not permitted in public FHIR; use the owning private command.'); this.status = 400; this.code = 'invalid'; }
}
const META_FIELDS = new Set(['id', 'extension', 'versionId', 'lastUpdated', 'source', 'profile', 'security', 'tag']);
const CODING_FIELDS = new Set(['id', 'extension', 'system', 'version', 'code', 'display', 'userSelected']);
const REFERENCE_FIELDS = new Set(['id', 'extension', 'reference', 'type', 'identifier', 'display']);
const IDENTIFIER_FIELDS = new Set(['id', 'extension', 'use', 'type', 'system', 'value', 'period', 'assigner']);
const VALUE_FIELD = /^value(?:Base64Binary|Boolean|Canonical|Code|Date|DateTime|Decimal|Id|Instant|Integer|Markdown|Oid|PositiveInt|String|Time|UnsignedInt|Uri|Url|Uuid|Address|Age|Annotation|Attachment|CodeableConcept|Coding|ContactPoint|Count|Distance|Duration|HumanName|Identifier|Money|Period|Quantity|Range|Ratio|Reference|SampledData|Signature|Timing|ContactDetail|Contributor|DataRequirement|Expression|ParameterDefinition|RelatedArtifact|TriggerDefinition|UsageContext|Dosage|Meta)$/;
const COMMON = ['resourceType', 'id', 'meta', 'implicitRules', 'language', 'text', 'contained', 'extension', 'modifierExtension'];
const FIELDS = {
    Organization: ['identifier', 'active', 'type', 'name', 'alias', 'telecom', 'address', 'partOf', 'contact', 'endpoint'],
    Endpoint: ['identifier', 'status', 'connectionType', 'name', 'managingOrganization', 'contact', 'period', 'payloadType', 'payloadMimeType', 'address', 'header'],
    HealthcareService: ['identifier', 'active', 'providedBy', 'category', 'type', 'specialty', 'location', 'name', 'comment', 'extraDetails', 'photo', 'telecom', 'coverageArea', 'serviceProvisionCode', 'eligibility', 'program', 'characteristic', 'communication', 'referralMethod', 'appointmentRequired', 'availableTime', 'notAvailable', 'availabilityExceptions', 'endpoint', 'description'],
    Consent: ['identifier', 'status', 'scope', 'category', 'patient', 'dateTime', 'performer', 'organization', 'sourceAttachment', 'sourceReference', 'policy', 'policyRule', 'verification', 'provision'],
    Contract: ['identifier', 'url', 'version', 'status', 'legalState', 'instantiatesCanonical', 'instantiatesUri', 'contentDerivative', 'issued', 'applies', 'expirationType', 'subject', 'authority', 'domain', 'site', 'name', 'title', 'subtitle', 'alias', 'author', 'scope', 'topicCodeableConcept', 'topicReference', 'type', 'subType', 'contentDefinition', 'term', 'supportingInfo', 'relevantHistory', 'signer', 'friendly', 'legal', 'rule', 'legallyBindingAttachment', 'legallyBindingReference'],
    Bundle: ['identifier', 'type', 'timestamp', 'total', 'link', 'entry', 'signature'],
    Parameters: ['parameter'], OperationOutcome: ['issue']
};

/** Reject known private representations even inside ordinary extensions, JSON displays or text.
 * Ordinary third-party extensions, arbitrary URNs and ordinary JSON text remain public.
 */
function assertPublic(value) {
    const fail = () => { throw new PublicMetadataError(); };
    const visit = item => {
        if (typeof item === 'string') {
            const decoded = item.replace(/&quot;|&#34;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            if ([...PRIVATE_KEYS].some(key => new RegExp('(?:^|[,{])\\s*"' + key + '"\\s*:').test(decoded.replace(/<[^>]*>/g, '')))) fail();
            if ([...PRIVATE_URLS, ...PRIVATE_TAGS].some(uri => uri && item.includes(uri)) || /pcm-(?:consent-scope-snapshot|consent-scope|consent-approval|service-grant)\/1/.test(item)) fail();
            const trimmed = item.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                let parsed; try { parsed = JSON.parse(trimmed); } catch { return; }
                visit(parsed);
            }
            return;
        }
        if (!item || typeof item !== 'object') return;
        if (Array.isArray(item)) { item.forEach(visit); return; }
        if (Object.keys(item).some(key => PRIVATE_KEYS.has(key))) fail();
        const closed = (object, fields) => {
            if (!object || typeof object !== 'object' || Array.isArray(object)
                || Object.keys(object).some(key => !fields.has(key) && !(key.startsWith('_') && fields.has(key.slice(1))))) fail();
        };
        if (item.meta !== undefined) {
            closed(item.meta, META_FIELDS);
            for (const field of ['tag', 'security']) if (item.meta[field] !== undefined) {
                if (!Array.isArray(item.meta[field])) fail();
                item.meta[field].forEach(value => closed(value, CODING_FIELDS));
            }
        }
        for (const field of ['coding', 'tag']) if (item[field] !== undefined) {
            if (!Array.isArray(item[field])) fail();
            item[field].forEach(value => closed(value, CODING_FIELDS));
        }
        if (typeof item.reference === 'string') closed(item, REFERENCE_FIELDS);
        if (item.identifier !== undefined) for (const value of Array.isArray(item.identifier) ? item.identifier : [item.identifier]) closed(value, IDENTIFIER_FIELDS);
        if (item.extension !== undefined) {
            if (!Array.isArray(item.extension)) fail();
            for (const extension of item.extension) {
                if (!extension || typeof extension.url !== 'string' || Object.keys(extension).some(key => !['id', 'url', 'extension'].includes(key) && !VALUE_FIELD.test(key) && !(key.startsWith('_') && VALUE_FIELD.test(key.slice(1))))) fail();
            }
        }
        if (item.display !== undefined && typeof item.display !== 'string') fail();
        if (item.text && typeof item.text === 'object') closed(item.text, new Set(['id', 'extension', 'status', 'div', '_status', '_div']));
        if (['Organization', 'HealthcareService', 'Contract'].includes(item.resourceType) && item.name !== undefined && typeof item.name !== 'string') fail();
        if (item.resourceType && FIELDS[item.resourceType]) {
            const allowed = new Set([...COMMON, ...FIELDS[item.resourceType]]);
            if (Object.keys(item).some(key => !allowed.has(key) && !(key.startsWith('_') && allowed.has(key.slice(1))))) fail();
        }
        Object.values(item).forEach(visit);
    };
    visit(value);
    return value;
}

/** Detached positive public DTO, used by ordinary reads, envelopes and resource downloads. */
function publicDto(resource) {
    assertPublic(resource);
    return structuredClone(resource);
}

/** Split only a trusted *new producer draft*. This never reads or migrates retained state. */
function splitProduced(resource) {
    const draft = structuredClone(resource);
    const grant = require('../../shared/service-grant').readServiceGrant(draft);
    const options = (draft.extension || []).filter(item => item.url === SANDBOX_EXTENSIONS.approvalScopeOption).map(option => ({ ...option,
        extension: [...option.extension, ...(option.extension.some(item => item.url === 'origin') ? [] : [{ url: 'origin', valueString: grant?.origin || 'generated' }])] }));
    const definition = grant ? { grant, options, confidentialityPolicy: require('../../shared/service-confidentiality-policy').readPolicy(draft),
        includeMasterData: require('../../shared/service-master-data').masterEnabled(draft) } : null;
    const tags = (draft.meta?.tag || []).filter(tag => PRIVATE_TAGS.has(tag.system));
    const bookkeeping = (draft.extension || []).filter(item => item.url === prefix + 'patient-sampling:fixed-query');
    if (draft.extension) draft.extension = draft.extension.filter(item => !PRIVATE_URLS.has(item.url));
    if (draft.meta?.tag) draft.meta.tag = draft.meta.tag.filter(tag => !PRIVATE_TAGS.has(tag.system));
    return { resource: publicDto(draft), definition,
        provisioning: tags.length || bookkeeping.length ? { seedTags: tags, bookkeeping } : null };
}

/** Publish a trusted fresh seed/authoring draft and its private owners as one atomic command.
 * Existing resource replacement belongs to reviewed reconciliation, never implicit extraction.
 */
function publishNewResource(store, draft, { create = false, id = draft.id } = {}) {
    return store.transaction(() => {
        if (id && store.get(draft.resourceType, id)) throw new Error('Producer creation cannot replace retained state');
        const parts = splitProduced(draft);
        const resource = create ? store.create(parts.resource, () => {}, { id }) : store.add(parts.resource);
        const expectedVersions = { [`${resource.resourceType}/${resource.id}`]: resource.meta.versionId };
        if (parts.definition && !resource.extension?.some(item => item.url === EXTENSIONS.basedOnCanonicalHealthcareService)) {
            store.privateRecords.services.createDefinition({ serviceId: resource.id, ...parts.definition, expectedRevision: store.privateState.revision, expectedVersions });
        }
        if (parts.provisioning) store.privateRecords.provisioning.put({ type: resource.resourceType, id: resource.id, value: parts.provisioning,
            expectedRevision: store.privateState.revision, expectedVersions });
        return resource;
    });
}

/** Return closed private authority or deny; no legacy/public/default fallback. */
function requireDefinition(store, service) {
    const result = store.privateRecords.services.getDefinition(service?.id);
    if (result.status !== 'ok') throw Object.assign(new Error('Private service definition is missing or invalid; complete coordinated migration.'), { status: 409 });
    return result;
}

/** Reject incompatible retained resources before bootstrap can silently republish them.
 * Empty disposable stores remain usable. Coordinated retained conversion belongs to 07.
 */
function assertRetainedCompatibility(store) {
    for (const type of Object.keys(store.data)) for (const resource of store.getAll(type)) {
        assertPublic(resource);
        if (type === 'HealthcareService' && require('./fhir/healthcare-service-lifecycle').serviceKind(resource)
            && store.privateRecords.services.getDefinition(resource.id).status !== 'ok') {
            throw new Error('Retained service lacks compatible private authority; stop and use PUBLIC-METADATA-07 coordinated migration.');
        }
        const decision = type === 'Consent' && resource.status === 'active' ? store.privateRecords.approvals.getDecision(resource.id) : null;
        if (decision && decision.status !== 'ok' && !decision.snapshot) {
            throw new Error('Retained active Consent lacks compatible private authority; stop and use PUBLIC-METADATA-07 coordinated migration.');
        }
    }
}

module.exports = { SCHEMA, PublicMetadataError, assertRetainedCompatibility, SERVICE_URLS, PRIVATE_URLS, PRIVATE_TAGS, assertPublic, publicDto, splitProduced, publishNewResource, requireDefinition };
