'use strict';

/** Authoritative Organization and Endpoint lifecycle rules. */
const { randomUUID: uuidv4 } = require('crypto');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS, PROFILES } = require('../../../shared/pcm-contract');

const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const PARTICIPANT_ENDPOINT_STATES = new Set(['active', 'suspended', 'off']);
const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

class ParticipantLifecycleError extends Error {
    constructor(message, status = 400, code = 'business-rule') {
        super(message);
        this.name = 'ParticipantLifecycleError';
        this.status = status;
        this.code = code;
    }
}

function localReference(reference, expectedType = null) {
    const match = /^([A-Za-z]+)\/([A-Za-z0-9.-]{1,64})$/.exec(reference || '');
    if (!match || (expectedType && match[1] !== expectedType)) return null;
    return { type: match[1], id: match[2] };
}

function officialOrganizationIdentifier(organization) {
    const pcmIdentifier = ensureArray(organization?.identifier).find(identifier =>
        identifier.use === 'official'
        && identifier.system === IDENTIFIER_SYSTEMS.organization
        && typeof identifier.value === 'string'
        && identifier.value);
    if (pcmIdentifier) return pcmIdentifier;
    if (organizationRole(organization) !== 'pcm') return undefined;
    return ensureArray(organization?.identifier).find(identifier =>
        identifier.use === 'official'
        && identifier.system === 'http://institutions.health.gov.il/Institutions'
        && typeof identifier.value === 'string'
        && identifier.value);
}

function organizationRole(organization) {
    const roles = ensureArray(organization?.type).flatMap(type => ensureArray(type.coding))
        .filter(coding => coding.system === CODE_SYSTEMS.organizationType)
        .map(coding => coding.code);
    return roles.length === 1 ? roles[0] : null;
}

function organizationIsOperational(store, organization) {
    if (!organization || organization.active !== true || !officialOrganizationIdentifier(organization)) return false;
    const role = organizationRole(organization);
    if (!role) return false;
    if (!organization.partOf?.reference) return role === 'parent-org' || role === 'pcm';
    const parentRef = localReference(organization.partOf.reference, 'Organization');
    const parent = parentRef ? store.get('Organization', parentRef.id) : null;
    return Boolean(parent
        && parent.active === true
        && organizationRole(parent) === 'parent-org'
        && officialOrganizationIdentifier(parent));
}

function endpointCertificateExtensions(endpoint) {
    return ensureArray(endpoint?.extension).filter(extension => {
        if (extension.url !== EXTENSIONS.applicableCertificates) return false;
        const thumbprints = ensureArray(extension.extension)
            .filter(value => value.url === 'thumbprint')
            .map(value => value.valueString);
        return thumbprints.length > 0 && thumbprints.every(value => THUMBPRINT.test(value));
    });
}

function participantEndpoint(store, organization, { requireActive = false } = {}) {
    if (!organization || ensureArray(organization.endpoint).length !== 1) return null;
    const reference = localReference(organization.endpoint[0]?.reference, 'Endpoint');
    if (!reference) return null;
    const endpoint = store.get('Endpoint', reference.id);
    const owner = localReference(endpoint?.managingOrganization?.reference, 'Organization');
    if (!endpoint || owner?.id !== organization.id || !PARTICIPANT_ENDPOINT_STATES.has(endpoint.status)) return null;
    if (requireActive && endpoint.status !== 'active') return null;
    return endpoint;
}

function findOperationalDataSourceByAddress(store, address) {
    if (typeof address !== 'string' || !address) return null;
    for (const organization of store.getAll('Organization')) {
        if (organizationRole(organization) !== 'source' || !organizationIsOperational(store, organization)) continue;
        const endpoint = participantEndpoint(store, organization, { requireActive: true });
        if (endpoint?.address === address) return { organization, endpoint };
    }
    return null;
}

function institutionalTypes(organization) {
    return ensureArray(organization?.type).filter(type =>
        ensureArray(type.coding).length > 0
        && ensureArray(type.coding).every(coding => coding.system !== CODE_SYSTEMS.organizationType));
}

function assertNoManagedOrganizationExtensions(extensions) {
    const managed = new Set([EXTENSIONS.oauthRedirectUri, EXTENSIONS.applicableCertificates]);
    if (ensureArray(extensions).some(extension => managed.has(extension.url))) {
        throw new ParticipantLifecycleError('OAuth redirect and certificate extensions are PCM-managed');
    }
}

function assertNoManagedEndpointExtensions(extensions) {
    if (ensureArray(extensions).some(extension => extension.url === EXTENSIONS.applicableCertificates)) {
        throw new ParticipantLifecycleError('Endpoint certificate inventory is PCM-managed');
    }
}

function createServiceProviderChild({ store, callerOrganization, request, idGenerator = uuidv4 }) {
    if (organizationRole(callerOrganization) !== 'service-provider'
        || !organizationIsOperational(store, callerOrganization)) {
        throw new ParticipantLifecycleError('Only an operational Service Provider may create a Service Provider child', 403, 'forbidden');
    }
    const parentRef = localReference(callerOrganization.partOf?.reference, 'Organization');
    const parent = parentRef ? store.get('Organization', parentRef.id) : null;
    if (!parent || organizationRole(parent) !== 'parent-org' || parent.active !== true) {
        throw new ParticipantLifecycleError('Caller has no active authoritative Parent Organization', 403, 'forbidden');
    }
    assertNoManagedOrganizationExtensions(request.extension);
    const normalizedName = request.name.trim().toLocaleLowerCase();
    if (store.getAll('Organization').some(organization =>
        organizationRole(organization) === 'service-provider'
        && localReference(organization.partOf?.reference, 'Organization')?.id === parent.id
        && organization.name?.trim().toLocaleLowerCase() === normalizedName)) {
        throw new ParticipantLifecycleError('A Service Provider child with this authoritative name already exists', 409, 'conflict');
    }
    const id = idGenerator();
    return store.transaction(() => {
        const provider = store.create({
            resourceType: 'Organization',
            meta: { profile: [PROFILES.organizationServiceProvider] },
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-ORG-${id.toUpperCase()}` }],
            active: true,
            name: request.name.trim(),
            type: [
                { coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider', display: 'Service Provider' }] },
                ...institutionalTypes(callerOrganization)
            ],
            partOf: { reference: `Organization/${parent.id}` },
            ...(request.contact ? { contact: request.contact } : {}),
            ...(request.extension ? { extension: request.extension } : {})
        }, () => {}, { id });
        require('./healthcare-service-lifecycle').enrollProviderDefault({ store, provider });
        return provider;
    });
}

function replaceOrganization({ store, callerOrganization, existing, request, pcmAdmin = false }) {
    if (!pcmAdmin && callerOrganization?.id !== existing.id) {
        throw new ParticipantLifecycleError('Organization update is limited to its owner', 403, 'forbidden');
    }
    if (pcmAdmin) return store.update({ ...request, resourceType: 'Organization', id: existing.id });
    if (request.name !== existing.name) {
        throw new ParticipantLifecycleError('Organization.name must be repeated unchanged');
    }
    assertNoManagedOrganizationExtensions(request.extension);
    const role = organizationRole(existing);
    if (!['parent-org', 'service-provider', 'source'].includes(role)) {
        throw new ParticipantLifecycleError('This Organization role has no participant update interaction', 403, 'forbidden');
    }
    let endpoint = existing.endpoint;
    if (role === 'source') {
        if (ensureArray(request.endpoint).length !== 1) {
            throw new ParticipantLifecycleError('Data Source update requires exactly one Endpoint reference');
        }
        const endpointRef = localReference(request.endpoint[0]?.reference, 'Endpoint');
        const candidate = endpointRef ? store.get('Endpoint', endpointRef.id) : null;
        const owner = localReference(candidate?.managingOrganization?.reference, 'Organization');
        if (!candidate || owner?.id !== existing.id || candidate.status === 'off') {
            throw new ParticipantLifecycleError('Data Source Endpoint must reference its own non-retired Endpoint');
        }
        endpoint = [{ reference: `Endpoint/${candidate.id}` }];
    } else if (request.endpoint !== undefined) {
        throw new ParticipantLifecycleError('Only a Data Source may replace its Endpoint reference');
    }
    const managedUrls = new Set([EXTENSIONS.oauthRedirectUri, EXTENSIONS.applicableCertificates]);
    const extension = [
        ...ensureArray(existing.extension).filter(value => managedUrls.has(value.url)),
        ...ensureArray(request.extension).filter(value => !managedUrls.has(value.url))
    ];
    return store.update({
        resourceType: 'Organization',
        id: existing.id,
        meta: { profile: existing.meta?.profile || [] },
        identifier: existing.identifier,
        active: existing.active,
        type: existing.type,
        name: existing.name,
        ...(existing.partOf ? { partOf: existing.partOf } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(request.contact ? { contact: request.contact } : {}),
        ...(extension.length ? { extension } : {})
    });
}

function assertSourceOwner(organization) {
    if (organizationRole(organization) !== 'source') {
        throw new ParticipantLifecycleError('Only a Data Source may manage participant Endpoints', 403, 'forbidden');
    }
}

function deriveEndpointCertificates(store, owner) {
    const direct = endpointCertificateExtensions(owner);
    if (direct.length) return direct;
    return store.getAll('Endpoint')
        .filter(endpoint => localReference(endpoint.managingOrganization?.reference, 'Organization')?.id === owner.id)
        .flatMap(endpointCertificateExtensions)
        .slice(0, 1);
}

function createEndpoint({ store, callerOrganization, request }) {
    assertSourceOwner(callerOrganization);
    assertNoManagedEndpointExtensions(request.extension);
    if (store.getAll('Endpoint').some(endpoint => endpoint.address === request.address)) {
        throw new ParticipantLifecycleError('Endpoint.address is already registered', 409, 'conflict');
    }
    const certificates = deriveEndpointCertificates(store, callerOrganization);
    return store.create({
        resourceType: 'Endpoint',
        meta: { profile: [PROFILES.endpoint] },
        status: request.status,
        connectionType: request.connectionType,
        payloadType: request.payloadType,
        address: request.address,
        managingOrganization: { reference: `Organization/${callerOrganization.id}` },
        ...(certificates.length
            ? { extension: certificates }
            : {})
    });
}

function endpointIsReferenced(store, endpointId) {
    return store.getAll('Organization').some(organization =>
        ensureArray(organization.endpoint).some(reference =>
            localReference(reference.reference, 'Endpoint')?.id === endpointId));
}

function replaceEndpoint({ store, callerOrganization, existing, request, pcmAdmin = false }) {
    const ownerRef = localReference(existing.managingOrganization?.reference, 'Organization');
    if (!pcmAdmin && (organizationRole(callerOrganization) !== 'source' || ownerRef?.id !== callerOrganization.id)) {
        throw new ParticipantLifecycleError('Endpoint update is limited to its Data Source owner', 403, 'forbidden');
    }
    if (!PARTICIPANT_ENDPOINT_STATES.has(existing.status)) {
        throw new ParticipantLifecycleError('PCM system Endpoint state is not participant-managed', 403, 'forbidden');
    }
    assertNoManagedEndpointExtensions(request.extension);
    if (existing.status === 'off' && request.status !== 'off') {
        throw new ParticipantLifecycleError('Endpoint.off is terminal', 422);
    }
    if (request.address !== existing.address && existing.status !== 'suspended') {
        throw new ParticipantLifecycleError('Endpoint.address may change only while the current Endpoint is suspended', 422);
    }
    if (request.status === 'off' && endpointIsReferenced(store, existing.id)) {
        throw new ParticipantLifecycleError('A referenced Endpoint cannot be retired; link a replacement first', 409, 'conflict');
    }
    if (request.status === existing.status && request.address === existing.address) return existing;
    const certificates = endpointCertificateExtensions(existing);
    return store.update({
        resourceType: 'Endpoint',
        id: existing.id,
        meta: { profile: existing.meta?.profile || [PROFILES.endpoint] },
        status: request.status,
        connectionType: request.connectionType,
        payloadType: request.payloadType,
        address: request.address,
        managingOrganization: existing.managingOrganization,
        ...(certificates.length ? { extension: certificates } : {})
    });
}

module.exports = {
    ParticipantLifecycleError,
    THUMBPRINT,
    createEndpoint,
    createServiceProviderChild,
    endpointCertificateExtensions,
    endpointIsReferenced,
    findOperationalDataSourceByAddress,
    localReference,
    officialOrganizationIdentifier,
    organizationIsOperational,
    organizationRole,
    participantEndpoint,
    replaceEndpoint,
    replaceOrganization
};
