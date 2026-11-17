'use strict';

/** Authoritative HealthcareService registration and lifecycle rules. */
const { randomUUID: uuidv4 } = require('crypto');
const {
    CODE_SYSTEMS,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    PROFILES, SANDBOX_EXTENSIONS
} = require('../../../shared/pcm-contract');
const {
    localReference,
    organizationIsOperational,
    organizationRole
} = require('./participant-lifecycle');

const { URL: CONFIDENTIALITY_POLICY_URL, readPolicy } = require('../../../shared/service-confidentiality-policy');
const { URL: MASTER_URL, masterEnabled } = require('../../../shared/service-master-data');
const { URL: GRANT_URL } = require('../../../shared/service-grant');
const CATALOG_PROPOSAL_PROFILE = 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-catalog-update-proposal';
const CATALOG_UPDATE_REQUEST_PROFILE = 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-request-catalog-update-parameters';
const CATALOG_UPDATE_RESPONSE_PROFILE = 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-request-catalog-update-response';
const SERVICE_STATES = new Set(['pending', 'active', 'rejected', 'frozen', 'suspended', 'cancelled']);
const BUILTIN_CATALOG_ID = 'demo-catalog-sandbox-full-access';
const OWNER_STATES = new Set(['active', 'suspended', 'cancelled']);
const DEFINITION_EXTENSION_URLS = new Set([
    GRANT_URL, SANDBOX_EXTENSIONS.approvalScopeOption,
    EXTENSIONS.accessMode,
    EXTENSIONS.accessDuration,
    EXTENSIONS.exampleQuery,
    EXTENSIONS.allowPatientBucketChange,
    EXTENSIONS.informationBucket
]);
const KNOWN_EXTENSION_URLS = new Set([
    EXTENSIONS.serviceBusinessStatus,
    EXTENSIONS.basedOnCanonicalHealthcareService,
    EXTENSIONS.approvalWindow,
    ...DEFINITION_EXTENSION_URLS
]);
const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));
const clone = value => JSON.parse(JSON.stringify(value));

/** Reject modifier extensions at every depth before interpreting lifecycle data. */
function assertNoModifierExtensions(value, location = 'resource') {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'modifierExtension')) {
        throw new HealthcareServiceLifecycleError(`Unsupported modifierExtension at ${location}`);
    }
    for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(child)) {
            child.forEach((item, index) => assertNoModifierExtensions(item, `${location}.${key}[${index}]`));
        } else if (child && typeof child === 'object') {
            assertNoModifierExtensions(child, `${location}.${key}`);
        }
    }
}

class HealthcareServiceLifecycleError extends Error {
    constructor(message, status = 400, code = 'business-rule') {
        super(message);
        this.name = 'HealthcareServiceLifecycleError';
        this.status = status;
        this.code = code;
    }
}

function officialIdentifier(service, system) {
    const matches = ensureArray(service?.identifier).filter(identifier =>
        identifier.use === 'official'
        && identifier.system === system
        && typeof identifier.value === 'string'
        && identifier.value);
    return matches.length === 1 ? matches[0] : null;
}

function hasProfile(service, profile) {
    return ensureArray(service?.meta?.profile).includes(profile);
}

function hasClassificationTag(service, code) {
    const tags = ensureArray(service?.meta?.tag).filter(tag => tag.system === CODE_SYSTEMS.metaTag);
    return tags.length === 1 && tags[0].code === code;
}

function serviceKind(service) {
    const catalog = hasProfile(service, PROFILES.healthcareServiceCanonical)
        && officialIdentifier(service, IDENTIFIER_SYSTEMS.healthcareServiceCatalog)
        && hasClassificationTag(service, 'catalog')
        && !service?.providedBy;
    const basedOn = extensions(service, EXTENSIONS.basedOnCanonicalHealthcareService);
    const owner = localReference(service?.providedBy?.reference, 'Organization');
    const instance = hasProfile(service, PROFILES.healthcareServiceInstance)
        && officialIdentifier(service, IDENTIFIER_SYSTEMS.healthcareServiceInstance)
        && hasClassificationTag(service, 'instance')
        && owner
        && basedOn.length === 1
        && localReference(basedOn[0].valueReference?.reference, 'HealthcareService');
    if (catalog && !instance) return 'catalog';
    if (instance && !catalog) return 'instance';
    return null;
}

function extensions(resource, url) {
    return ensureArray(resource?.extension).filter(extension => extension.url === url);
}

function businessStatus(service) {
    const matches = extensions(service, EXTENSIONS.serviceBusinessStatus);
    if (matches.length !== 1) return null;
    const coding = matches[0].valueCoding;
    if (coding?.system !== CODE_SYSTEMS.serviceBusinessStatus || !SERVICE_STATES.has(coding.code)) return null;
    return coding.code;
}

function statusExtension(code) {
    return {
        url: EXTENSIONS.serviceBusinessStatus,
        valueCoding: {
            system: CODE_SYSTEMS.serviceBusinessStatus,
            code,
            display: code[0].toUpperCase() + code.slice(1)
        }
    };
}

function basedOnId(service) {
    const values = extensions(service, EXTENSIONS.basedOnCanonicalHealthcareService);
    if (values.length !== 1) return null;
    return localReference(values[0].valueReference?.reference, 'HealthcareService')?.id || null;
}

function ownerId(service) {
    return localReference(service?.providedBy?.reference, 'Organization')?.id || null;
}

function serviceIsOperational(store, service) {
    if (serviceKind(service) !== 'instance' || service.active !== true || businessStatus(service) !== 'active') return false;
    const canonical = store.get('HealthcareService', basedOnId(service));
    return serviceKind(canonical) === 'catalog'
        && canonical.active === true
        && businessStatus(canonical) === 'active';
}

function assertOperationalServiceProvider(store, organization) {
    if (organizationRole(organization) !== 'service-provider' || !organizationIsOperational(store, organization)) {
        throw new HealthcareServiceLifecycleError('Only an operational Service Provider may manage service registrations', 403, 'forbidden');
    }
}

function assertUnknownKnownExtension(request, allowedKnown) {
    for (const extension of ensureArray(request.extension)) {
        if (KNOWN_EXTENSION_URLS.has(extension.url) && !allowedKnown.has(extension.url)) {
            throw new HealthcareServiceLifecycleError(`HealthcareService extension is not permitted in this request: ${extension.url}`);
        }
    }
}

function assertCreateMeta(request) {
    if (request.meta?.tag !== undefined) {
        throw new HealthcareServiceLifecycleError('HealthcareService.meta.tag is PCM-managed');
    }
}

function validUcumDuration(duration) {
    return duration
        && typeof duration.value === 'number'
        && Number.isFinite(duration.value)
        && duration.system === 'http://unitsofmeasure.org'
        && typeof duration.code === 'string'
        && duration.code.length > 0;
}

function assertDefinitionExtensions(request) {
    const typeCoding = request.type?.[0]?.coding;
    if (typeCoding?.length !== 1
        || typeCoding[0].system !== 'http://terminology.hl7.org/CodeSystem/v3-ActCode'
        || typeCoding[0].code !== 'INFA'
        || typeCoding[0].display !== 'information access') {
        throw new HealthcareServiceLifecycleError('HealthcareService.type must be the fixed INFA information access coding');
    }
    const accessMode = extensions(request, EXTENSIONS.accessMode)[0];
    if (!['one-time', 'continuous'].includes(accessMode?.valueCode)) {
        throw new HealthcareServiceLifecycleError('accessMode must be one-time or continuous');
    }
    if (!validUcumDuration(extensions(request, EXTENSIONS.accessDuration)[0]?.valueDuration)) {
        throw new HealthcareServiceLifecycleError('accessDuration must be a UCUM duration');
    }
    if (extensions(request, EXTENSIONS.exampleQuery).some(extension =>
        typeof extension.valueString !== 'string' || !extension.valueString)) {
        throw new HealthcareServiceLifecycleError('Every exampleQuery requires a non-empty valueString');
    }
    const bucketCodes = [];
    for (const bucket of extensions(request, EXTENSIONS.informationBucket)) {
        try {
            bucketCodes.push(require('../../../shared/information-buckets').parseInformationBucket(bucket).coding.code);
        } catch (error) { throw new HealthcareServiceLifecycleError(error.message); }
    }
    if (new Set(bucketCodes).size !== bucketCodes.length) {
        throw new HealthcareServiceLifecycleError('Information bucket codes must be unique');
    }
}

function classifyRegistrationRequest(request) {
    if (extensions(request, EXTENSIONS.basedOnCanonicalHealthcareService).length && extensions(request, GRANT_URL).length) throw new HealthcareServiceLifecycleError('Registration cannot override the canonical service grant.');
    try { readPolicy(request); masterEnabled(request); } catch (error) { throw new HealthcareServiceLifecycleError(error.message); }
    try { require('../service-scope-authoring').assertServiceGrant(request); } catch (error) { throw new HealthcareServiceLifecycleError(error.message); }
    assertNoModifierExtensions(request);
    assertCreateMeta(request);
    const basedOn = extensions(request, EXTENSIONS.basedOnCanonicalHealthcareService);
    if (basedOn.length > 1) {
        throw new HealthcareServiceLifecycleError('Existing registration requires exactly one basedOn extension');
    }
    if (basedOn.length === 1) {
        if (extensions(request, MASTER_URL).length) throw new HealthcareServiceLifecycleError('Registration cannot override canonical master-data setting');
        if (extensions(request, CONFIDENTIALITY_POLICY_URL).length) throw new HealthcareServiceLifecycleError('Registration cannot override canonical confidentiality policy');
        const forbidden = ['name', 'category', 'type', 'extraDetails'].filter(field => request[field] !== undefined);
        if (forbidden.length) {
            throw new HealthcareServiceLifecycleError(`Existing registration contains prohibited definition field(s): ${forbidden.join(', ')}`);
        }
        assertUnknownKnownExtension(request, new Set([EXTENSIONS.basedOnCanonicalHealthcareService]));
        return 'existing-catalog';
    }
    for (const field of ['name', 'category', 'type', 'extraDetails', 'extension']) {
        const value = request[field];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
            throw new HealthcareServiceLifecycleError(`New-service registration requires HealthcareService.${field}`);
        }
    }
    if (typeof request.name !== 'string' || !request.name.trim()
        || typeof request.extraDetails !== 'string' || !request.extraDetails.trim()
        || request.type.length !== 1) {
        throw new HealthcareServiceLifecycleError('New-service registration name, purpose, and single type are invalid');
    }
    assertUnknownKnownExtension(request, DEFINITION_EXTENSION_URLS);
    const exactOne = [EXTENSIONS.accessMode, EXTENSIONS.accessDuration, EXTENSIONS.allowPatientBucketChange];
    if (exactOne.some(url => extensions(request, url).length !== 1)
        || extensions(request, EXTENSIONS.informationBucket).length < 1
        || extensions(request, EXTENSIONS.exampleQuery).length < 1) {
        throw new HealthcareServiceLifecycleError('New-service registration requires the complete extension definition');
    }
    const allow = extensions(request, EXTENSIONS.allowPatientBucketChange)[0];
    if (typeof allow.valueBoolean !== 'boolean') {
        throw new HealthcareServiceLifecycleError('allowPatientBucketChange requires exactly one explicit boolean value');
    }
    assertDefinitionExtensions(request);
    return 'new-service';
}

function normalizedName(value) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function duplicateCatalogByName(store, name, exceptId = null) {
    const key = normalizedName(name);
    return store.getAll('HealthcareService').find(service =>
        service.id !== exceptId && serviceKind(service) === 'catalog' && normalizedName(service.name) === key) || null;
}

function identifier(system, prefix, id) {
    return [{ use: 'official', system, value: `${prefix}-${id.toUpperCase()}` }];
}

function classificationMeta(profile, code) {
    return {
        profile: [profile],
        tag: [{ system: CODE_SYSTEMS.metaTag, code, display: code === 'catalog' ? 'Catalog' : 'Instance' }]
    };
}

function approvalWindow(clock) {
    const start = clock();
    const end = new Date(start.getTime() + (30 * 24 * 60 * 60 * 1000));
    return { url: EXTENSIONS.approvalWindow, valuePeriod: { start: start.toISOString(), end: end.toISOString() } };
}

function definitionExtensions(service) {
    return ensureArray(service.extension).filter(extension => (DEFINITION_EXTENSION_URLS.has(extension.url) || [CONFIDENTIALITY_POLICY_URL, MASTER_URL].includes(extension.url)));
}

function createInstanceShape({ request, canonical, callerOrganization, instanceId, clock }) {
    return {
        resourceType: 'HealthcareService',
        meta: classificationMeta(PROFILES.healthcareServiceInstance, 'instance'),
        identifier: identifier(IDENTIFIER_SYSTEMS.healthcareServiceInstance, 'PCM-HS-INST', instanceId),
        extension: [
            statusExtension('pending'),
            {
                url: EXTENSIONS.basedOnCanonicalHealthcareService,
                valueReference: { reference: `HealthcareService/${canonical.id}` }
            },
            approvalWindow(clock),
            ...definitionExtensions(canonical),
            ...ensureArray(request.extension).filter(extension => !KNOWN_EXTENSION_URLS.has(extension.url) && ![CONFIDENTIALITY_POLICY_URL, MASTER_URL].includes(extension.url))
        ],
        active: false,
        providedBy: { reference: `Organization/${callerOrganization.id}` },
        category: clone(canonical.category),
        type: clone(canonical.type),
        name: canonical.name,
        extraDetails: canonical.extraDetails
    };
}

/** Create a provider-independent pending definition and its immutable private authority atomically.
 * Ownership and lifecycle identifiers are generated by PCM; no provider is required.
 */
function createCatalogDefinition({ store, request, privateDefinition, clock = () => new Date(), idGenerator = uuidv4 }) {
    require('../public-fhir').assertPublic(request);
    if (classifyRegistrationRequest(request) !== 'new-service') throw new HealthcareServiceLifecycleError('A complete new catalog definition is required');
    if (privateDefinition) {
        const grant = privateDefinition.grant, anchor = Date.parse(grant?.anchor), now = clock().getTime();
        if (!Number.isFinite(anchor) || anchor > now || anchor < now - 900000) throw new HealthcareServiceLifecycleError('Private creation review expired or is in the future.');
        const rebuilt = require('../service-definition-form').serviceDefinitionCommand(grant.authoring, { now: anchor / 1000 });
        const project = resource => ({ name: resource.name, extraDetails: resource.extraDetails, category: resource.category, type: resource.type, extension: resource.extension.filter(item => item.url !== EXTENSIONS.exampleQuery) });
        if (JSON.stringify(rebuilt.definition) !== JSON.stringify(privateDefinition) || JSON.stringify(project(rebuilt.resource)) !== JSON.stringify(project(request))) {
            throw new HealthcareServiceLifecycleError('Private definition differs from the reviewed public definition.');
        }
    }
    return store.transaction(() => {
        if (duplicateCatalogByName(store, request.name)) {
            throw new HealthcareServiceLifecycleError('Choose a unique service name or register against the existing canonical HealthcareService', 409, 'conflict');
        }
        const catalogId = idGenerator();
        const canonical = require('../public-fhir').publishNewResource(store, {
            resourceType: 'HealthcareService',
            meta: classificationMeta(PROFILES.healthcareServiceCanonical, 'catalog'),
            identifier: identifier(IDENTIFIER_SYSTEMS.healthcareServiceCatalog, 'PCM-CAT', catalogId),
            extension: [statusExtension('pending'), ...clone(ensureArray(request.extension))],
            active: false,
            category: clone(request.category),
            type: clone(request.type),
            name: request.name.trim(),
            extraDetails: request.extraDetails.trim()
        }, { create: true, id: catalogId });
        const definition = privateDefinition || require('../public-service-definition').definitionFromPublic(canonical, clock());
        store.privateRecords.services.createDefinition({ serviceId: canonical.id, ...definition, expectedRevision: store.privateState.revision,
            expectedVersions: { [`HealthcareService/${canonical.id}`]: canonical.meta.versionId } });
        return canonical;
    });
}

/** Persist deliberate built-in choices in the existing Organization provisioning owner.
 * @param {object} store FHIRStore joining the current transaction.
 * @param {string} providerId Exact registered provider.
 * @param {string} override none, paused or disconnected; never clinical authority.
 * @returns {void} Writes only when the initialized preference changes.
 */
function recordProviderDefault(store, providerId, override) {
    const defaults = store.privateRecords.services.getProviderDefaults(providerId);
    const value = { initialized: true, override };
    if (JSON.stringify(defaults.services[BUILTIN_CATALOG_ID]) === JSON.stringify(value)) return;
    defaults.services[BUILTIN_CATALOG_ID] = value;
    const provider = store.get('Organization', providerId);
    store.privateRecords.provisioning.put({ type: 'Organization', id: providerId,
        value: { ...store.privateRecords.provisioning.get('Organization', providerId), serviceDefaults: defaults },
        expectedRevision: store.privateState.revision, expectedVersions: { [`Organization/${providerId}`]: provider.meta.versionId } });
}

/** Initialize a real provider once, under explicit seed/registration provisioning authority.
 * Existing history supplies the retained choice; missing instances never undo initialized choices.
 * @param {object} options Existing store, provider and optional deterministic provisioning identity.
 * @returns {object|null} Existing/new association, or null when no new initialization is needed.
 */
function enrollProviderDefault({ store, provider, instanceId, clock = store.clock }) {
    if (organizationRole(provider) !== 'service-provider') return null;
    const canonical = store.get('HealthcareService', BUILTIN_CATALOG_ID);
    if (serviceKind(canonical) !== 'catalog') return null;
    return store.transaction(() => {
        if (store.privateRecords.services.getProviderDefaults(provider.id).services[BUILTIN_CATALOG_ID]?.initialized) return null;
        require('../public-fhir').requireDefinition(store, canonical);
        const registrations = store.getAll('HealthcareService').filter(item => basedOnId(item) === canonical.id && ownerId(item) === provider.id);
        if (registrations.filter(item => businessStatus(item) !== 'cancelled').length > 1) throw new HealthcareServiceLifecycleError('Ambiguous built-in provider registrations; reconcile the original owner first', 409);
        let instance = registrations.find(item => businessStatus(item) !== 'cancelled') || registrations.at(-1);
        if (!instance) {
            const id = instanceId || uuidv4();
            const draft = createInstanceShape({ request: {}, canonical, callerOrganization: provider, instanceId: id, clock });
            // Provisioning can approve an association; current provider/catalog checks still gate use.
            const state = organizationIsOperational(store, provider) ? 'active' : 'pending';
            instance = store.create(replaceBusinessStatus(draft, state), () => {}, { id });
        }
        const state = businessStatus(instance);
        recordProviderDefault(store, provider.id, state === 'cancelled' ? 'disconnected' : state === 'suspended' ? 'paused' : 'none');
        return instance;
    });
}

function registerHealthcareService({ store, callerOrganization, request, privateDefinition, clock = () => new Date(), idGenerator = uuidv4 }) {
    assertOperationalServiceProvider(store, callerOrganization);
    require('../public-fhir').assertPublic(request);
    const mode = classifyRegistrationRequest(request);
    if (mode === 'existing-catalog' && privateDefinition) throw new HealthcareServiceLifecycleError('A registration cannot override canonical private authority');
    return store.transaction(() => {
        let canonical;
        if (mode === 'existing-catalog') {
            const reference = localReference(
                extensions(request, EXTENSIONS.basedOnCanonicalHealthcareService)[0].valueReference?.reference,
                'HealthcareService'
            );
            canonical = reference ? store.get('HealthcareService', reference.id) : null;
            if (serviceKind(canonical) !== 'catalog' || canonical.active !== true || businessStatus(canonical) !== 'active') {
                throw new HealthcareServiceLifecycleError(
                    'HealthcareService.basedOn must reference an active, registrable canonical catalog service visible to the caller'
                );
            }
            if (store.getAll('HealthcareService').some(service =>
                serviceKind(service) === 'instance'
                && ownerId(service) === callerOrganization.id
                && basedOnId(service) === canonical.id
                && businessStatus(service) !== 'cancelled')) {
                throw new HealthcareServiceLifecycleError('This provider already has a registration for the canonical service', 409, 'conflict');
            }
        } else {
            canonical = createCatalogDefinition({ store, request, privateDefinition, clock, idGenerator });
        }
        require('../public-fhir').requireDefinition(store, canonical);
        const instanceId = idGenerator();
        const instance = store.create(createInstanceShape({
            request,
            canonical,
            callerOrganization,
            instanceId,
            clock
        }), () => {}, { id: instanceId });
        if (canonical.id === BUILTIN_CATALOG_ID) recordProviderDefault(store, callerOrganization.id, 'none');
        return { mode, canonical, instance };
    });
}

const OWNER_TRANSITIONS = Object.freeze({
    pending: new Set(['cancelled']),
    active: new Set(['suspended']),
    suspended: new Set(['active', 'cancelled']),
    cancelled: new Set()
});

function requestedOwnerStatus(request) {
    const statuses = extensions(request, EXTENSIONS.serviceBusinessStatus);
    if (statuses.length !== 1) {
        throw new HealthcareServiceLifecycleError('Instance update requires exactly one businessStatus extension');
    }
    assertUnknownKnownExtension(request, new Set([EXTENSIONS.serviceBusinessStatus]));
    if (Object.keys(statuses[0]).some(key => !['id', 'extension', 'url', 'valueCoding'].includes(key))) {
        throw new HealthcareServiceLifecycleError('businessStatus extension contains unsupported fields');
    }
    const coding = statuses[0].valueCoding;
    if (!coding || Object.keys(coding).some(key => !['id', 'extension', 'system', 'version', 'code', 'display', 'userSelected'].includes(key))
        || coding.system !== CODE_SYSTEMS.serviceBusinessStatus || !OWNER_STATES.has(coding.code)) {
        throw new HealthcareServiceLifecycleError('Instance owner businessStatus must be active, suspended, or cancelled');
    }
    return coding.code;
}

function replaceBusinessStatus(service, next) {
    return {
        ...service,
        active: next === 'active',
        extension: [
            statusExtension(next),
            ...ensureArray(service.extension).filter(extension => extension.url !== EXTENSIONS.serviceBusinessStatus)
        ]
    };
}

function transitionHealthcareService({ store, callerOrganization, existing, request, afterTransition = () => {} }) {
    assertOperationalServiceProvider(store, callerOrganization);
    if (serviceKind(existing) !== 'instance') {
        throw new HealthcareServiceLifecycleError(
            'Use $request-catalog-update for a non-material catalog change or submit a new-service registration request for a material change',
            422,
            'not-supported'
        );
    }
    if (ownerId(existing) !== callerOrganization.id) {
        throw new HealthcareServiceLifecycleError('The Service Provider may manage only its own service registrations', 403, 'forbidden');
    }
    const current = businessStatus(existing);
    const next = requestedOwnerStatus(request);
    if (!current) throw new HealthcareServiceLifecycleError('HealthcareService has no authoritative businessStatus', 409, 'conflict');
    if (current === next) return existing;
    if (!OWNER_TRANSITIONS[current]?.has(next)) {
        throw new HealthcareServiceLifecycleError(`Owner transition ${current} -> ${next} is not permitted`, 409, 'conflict');
    }
    return store.transaction(() => {
        const committed = store.privateRecords.lifecycle.command({ type: 'HealthcareService', id: existing.id, resource: replaceBusinessStatus(existing, next),
            event: { kind: 'owner-transition', previousStatus: current, status: next, provider: callerOrganization.id, at: store.clock().toISOString() },
            expectedRevision: store.privateState.revision, expectedVersions: { [`HealthcareService/${existing.id}`]: existing.meta.versionId } }).resource;
        if (current === 'pending' && next === 'cancelled') {
            const canonical = store.get('HealthcareService', basedOnId(existing));
            if (serviceKind(canonical) === 'catalog' && businessStatus(canonical) === 'pending') {
                const peers = store.getAll('HealthcareService').filter(service =>
                    service.id !== existing.id
                    && serviceKind(service) === 'instance'
                    && basedOnId(service) === canonical.id
                    && businessStatus(service) !== 'cancelled');
                if (peers.length === 0) store.update(replaceBusinessStatus(canonical, 'cancelled'));
            }
        }
        if (basedOnId(existing) === BUILTIN_CATALOG_ID) recordProviderDefault(store, callerOrganization.id, next === 'suspended' ? 'paused' : next === 'cancelled' ? 'disconnected' : 'none');
        afterTransition({ service: committed, previousStatus: current, nextStatus: next });
        return committed;
    });
}

function removeCodingDisplays(value) {
    if (Array.isArray(value)) return value.map(removeCodingDisplays);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'display')
        .map(([key, child]) => [key, removeCodingDisplays(child)]));
}

function sortSemantic(value) {
    if (Array.isArray(value)) {
        return value.map(sortSemantic).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortSemantic(value[key])]));
}

function protectedCatalogProjection(service) {
    const projected = clone(service);
    delete projected.name;
    delete projected.extraDetails;
    if (projected.meta) {
        delete projected.meta.versionId;
        delete projected.meta.lastUpdated;
        projected.meta.profile = [PROFILES.healthcareServiceCanonical];
    }
    projected.extension = ensureArray(projected.extension).filter(extension =>
        (KNOWN_EXTENSION_URLS.has(extension.url) || [CONFIDENTIALITY_POLICY_URL, MASTER_URL].includes(extension.url)) && extension.url !== EXTENSIONS.exampleQuery);
    return sortSemantic(removeCodingDisplays(projected));
}

function assertCompleteCatalogProposal(proposed, targetId) {
    if (!proposed || proposed.resourceType !== 'HealthcareService' || proposed.id !== targetId) {
        throw new HealthcareServiceLifecycleError('proposedCatalog must be a HealthcareService whose id matches the operation target');
    }
    if (!hasProfile(proposed, CATALOG_PROPOSAL_PROFILE)
        || !officialIdentifier(proposed, IDENTIFIER_SYSTEMS.healthcareServiceCatalog)
        || !hasClassificationTag(proposed, 'catalog')
        || proposed.providedBy !== undefined
        || typeof proposed.name !== 'string' || !proposed.name.trim()
        || typeof proposed.extraDetails !== 'string' || !proposed.extraDetails.trim()
        || !ensureArray(proposed.category).length || ensureArray(proposed.type).length !== 1
        || businessStatus(proposed) === null
        || typeof proposed.active !== 'boolean') {
        throw new HealthcareServiceLifecycleError('proposedCatalog is not a complete canonical HealthcareService representation');
    }
    for (const url of [EXTENSIONS.accessMode, EXTENSIONS.accessDuration, EXTENSIONS.allowPatientBucketChange]) {
        if (extensions(proposed, url).length !== 1) {
            throw new HealthcareServiceLifecycleError(`proposedCatalog requires exactly one ${url} extension`);
        }
    }
    if (!extensions(proposed, EXTENSIONS.informationBucket).length || !extensions(proposed, EXTENSIONS.exampleQuery).length) {
        throw new HealthcareServiceLifecycleError('proposedCatalog requires informationBucket and exampleQuery extensions');
    }
    if (typeof extensions(proposed, EXTENSIONS.allowPatientBucketChange)[0].valueBoolean !== 'boolean') {
        throw new HealthcareServiceLifecycleError('proposedCatalog allowPatientBucketChange requires a boolean');
    }
    assertDefinitionExtensions(proposed);
    try { require('../service-scope-authoring').assertServiceGrant(proposed); } catch (error) { throw new HealthcareServiceLifecycleError(error.message); }
}

function parseCatalogUpdateParameters(body) {
    if (!body || body.resourceType !== 'Parameters') {
        throw new HealthcareServiceLifecycleError('A closed Parameters catalog-update request is required');
    }
    const outerFields = new Set(['resourceType', 'id', 'meta', 'parameter']);
    const unknown = Object.keys(body).filter(key => !outerFields.has(key));
    if (unknown.length || body.meta?.versionId !== undefined || body.meta?.lastUpdated !== undefined
        || Object.keys(body.meta || {}).some(field => !['profile'].includes(field))) {
        throw new HealthcareServiceLifecycleError('Catalog-update Parameters contains unsupported metadata or fields');
    }
    const parameters = ensureArray(body.parameter);
    const proposed = parameters.filter(parameter => parameter.name === 'proposedCatalog');
    const reasons = parameters.filter(parameter => parameter.name === 'reason');
    if (proposed.length !== 1 || reasons.length > 1 || parameters.length !== proposed.length + reasons.length) {
        throw new HealthcareServiceLifecycleError('Parameters requires exactly one proposedCatalog and at most one reason');
    }
    if (Object.keys(proposed[0]).some(field => !['name', 'resource'].includes(field))) {
        throw new HealthcareServiceLifecycleError('proposedCatalog parameter contains an unsupported field');
    }
    if (reasons[0] && (typeof reasons[0].valueString !== 'string'
        || Object.keys(reasons[0]).some(field => !['name', 'valueString'].includes(field)))) {
        throw new HealthcareServiceLifecycleError('reason must contain only a valueString');
    }
    return { proposed: proposed[0].resource, reason: reasons[0]?.valueString };
}

function requestCatalogUpdate({ store, callerOrganization, targetId, body, requestIdGenerator = uuidv4 }) {
    assertOperationalServiceProvider(store, callerOrganization);
    require('../public-fhir').assertPublic(body);
    assertNoModifierExtensions(body);
    const existing = store.get('HealthcareService', targetId);
    if (serviceKind(existing) !== 'catalog') {
        throw new HealthcareServiceLifecycleError('Canonical HealthcareService not found', 404, 'not-found');
    }
    const { proposed, reason } = parseCatalogUpdateParameters(body);
    assertCompleteCatalogProposal(proposed, targetId);
    if (JSON.stringify(protectedCatalogProjection(existing)) !== JSON.stringify(protectedCatalogProjection(proposed))) {
        throw new HealthcareServiceLifecycleError(
            'Only name, extraDetails, and exampleQuery may differ in $request-catalog-update. Submit material changes through the new-service registration flow',
            422,
            'business-rule'
        );
    }
    if (normalizedName(proposed.name) !== normalizedName(existing.name)
        && duplicateCatalogByName(store, proposed.name, existing.id)) {
        throw new HealthcareServiceLifecycleError('Choose a unique service name or retain the current catalog name', 409, 'conflict');
    }
    return {
        reason,
        receipt: {
            resourceType: 'Parameters',
            meta: { profile: [CATALOG_UPDATE_RESPONSE_PROFILE] },
            parameter: [
                { name: 'requestId', valueString: requestIdGenerator() },
                { name: 'status', valueCode: 'received' },
                { name: 'message', valueString: 'PCM accepted the catalog update request for PCM/MoH review. The active HealthcareService remains unchanged until the request is approved and applied.' }
            ]
        }
    };
}

module.exports = {
    BUILTIN_CATALOG_ID,
    recordProviderDefault,
    enrollProviderDefault,
    CATALOG_PROPOSAL_PROFILE,
    CATALOG_UPDATE_REQUEST_PROFILE,
    CATALOG_UPDATE_RESPONSE_PROFILE,
    HealthcareServiceLifecycleError,
    assertOperationalServiceProvider,
    basedOnId,
    businessStatus,
    classifyRegistrationRequest,
    duplicateCatalogByName,
    ownerId,
    protectedCatalogProjection,
    registerHealthcareService,
    createCatalogDefinition,
    requestCatalogUpdate,
    serviceIsOperational,
    serviceKind,
    statusExtension,
    transitionHealthcareService
};
