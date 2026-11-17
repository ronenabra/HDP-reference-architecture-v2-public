const { sourceInstitutionType } = require('../../shared/source-institution');
const { randomUUID: uuidv4 } = require('crypto');

const {
    CODE_SYSTEMS,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    PROFILES,
    SANDBOX_EXTENSIONS,
    SCOPES,
    createOpaqueClientId
} = require('../../shared/pcm-contract');

const PCM_ORG_TYPE = CODE_SYSTEMS.organizationType;
const EXT_CERTS = EXTENSIONS.applicableCertificates;
const EXT_APPROVED_SCOPE = SANDBOX_EXTENSIONS.approvedTokenScope;
const FIXTURE_LAST_UPDATED = '2026-01-05T08:00:00Z';
const STRICT_SANDBOX_TOKEN_SCOPE = [
    'patient/Observation.rs',
    'patient/Observation.s?status=final',
    'patient/Observation.s?status=preliminary',
    'patient/Observation.s?status=final&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|procedures&date=ge2026-01-01',
    'patient/Observation.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&date=ge2026-01-01',
    'patient/Observation.s?status=entered-in-error',
    'patient/Observation.s',
    'patient/Observation.r',
    'patient/Observation.r?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests',
    'system/Observation.s',
    'system/Observation.s?status=final',
    'system/Practitioner.r',
    'system/Practitioner.s',
    'system/Observation.r'
].join(' ');

const DEFAULT_TOKEN_SCOPE = 'patient/Observation.rs';

const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

const slug = value => String(value || 'data-source')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'data-source';

function certExtension(thumbprint) {
    return {
        url: EXT_CERTS,
        extension: [{ url: 'thumbprint', valueString: thumbprint || 'A'.repeat(43) }]
    };
}

function normalizeConfiguredSource(raw, index = 0) {
    if (!raw || !raw.endpoint) return null;
    const id = raw.id || `org-${slug(raw.name || raw.endpoint)}-${index + 1}`;
    const endpointId = raw.endpointId || `endpoint-${id.replace(/^org-/, '')}`;
    const parentId = raw.parentId || `${id}-parent`;
    const defaultClientId = createOpaqueClientId('pcm-ds', id);
    const pcmClientAuth = raw.pcmClientAuth || {};
    const serverTrust = raw.serverTrust || {};
    return {
        id,
        parentId,
        parentName: raw.parentName || `${raw.name || 'Data Source'} Org`,
        name: raw.name || raw.display || `Data Source ${index + 1}`,
        endpointId,
        institutionType: sourceInstitutionType(raw),
        endpoint: raw.endpoint,
        clientId: raw.clientId || pcmClientAuth.clientId || defaultClientId,
        businessIdentifier: raw.businessIdentifier || {
            system: IDENTIFIER_SYSTEMS.organization,
            value: `PCM-ORG-${id.toUpperCase()}`
        },
        parentBusinessIdentifier: raw.parentBusinessIdentifier || {
            system: IDENTIFIER_SYSTEMS.organization,
            value: `PCM-ORG-${parentId.toUpperCase()}`
        },
        certThumbprint: raw.certThumbprint || null,
        scopes: raw.scopes || ['introspection'],
        pcmClientAuth: {
            clientId: pcmClientAuth.clientId || raw.clientId || defaultClientId,
            managedBy: pcmClientAuth.managedBy || null,
            cert: pcmClientAuth.cert || raw.cert || null,
            key: pcmClientAuth.key || raw.key || null,
            mtlsCert: pcmClientAuth.mtlsCert || raw.mtlsCert || null,
            mtlsKey: pcmClientAuth.mtlsKey || raw.mtlsKey || null,
            certThumbprint: pcmClientAuth.certThumbprint || raw.pcmClientAuthCertThumbprint || null,
            assertionCertificates: pcmClientAuth.assertionCertificates || raw.assertionCertificates || {}
        },
        serverTrust: {
            mode: serverTrust.mode || raw.serverTrustMode || 'team-root-ca',
            caCert: serverTrust.caCert || raw.serverTrustCaCert || null,
            certThumbprint: serverTrust.certThumbprint || raw.certThumbprint || null
        },
        enabled: raw.enabled !== false
    };
}

function getConfiguredDataSources(config, { includeDisabled = false } = {}) {
    const orgs = config.organizations || {};
    const result = [];

    if (Array.isArray(config.healthOrganizations)) {
        for (const [index, ho] of config.healthOrganizations.entries()) {
            const source = normalizeConfiguredSource({
                id: ho.dataSourceOrganization?.id,
                institutionType: sourceInstitutionType(ho, { managed: true }),
                parentId: ho.parentOrganization?.id,
                parentName: ho.name,
                name: `${ho.name} Data Source`,
                endpointId: ho.endpointId,
                endpoint: ho.endpoint,
                clientId: ho.clientId,
                businessIdentifier: ho.dataSourceOrganization?.businessIdentifier,
                parentBusinessIdentifier: ho.parentOrganization?.businessIdentifier,
                // A Data Source uses the same coarse management ceiling for
                // its own Organization/Endpoint lifecycle and the distinct
                // introspection audience for protected-resource decisions.
                scopes: ['introspection', SCOPES.management],
                pcmClientAuth: {
                    clientId: ho.clientId,
                    cert: ho.certificates?.gatewayAssertionCert,
                    key: ho.certificates?.gatewayAssertionKey,
                    mtlsCert: ho.certificates?.gatewayMtlsCert,
                    mtlsKey: ho.certificates?.gatewayMtlsKey,
                    assertionCertificates: ho.assertionCertificates || {}
                },
                serverTrust: { mode: 'team-root-ca' },
                enabled: true
            }, index);
            if (source) result.push({ ...source, builtIn: true, healthOrganizationId: ho.id });
        }
        if (config.legacyDataSource?.enabled && orgs.referenceDataSource) {
            const legacyRoles = config.certificateRoles?.referenceDataSource || {};
            const legacy = normalizeConfiguredSource({
                ...orgs.referenceDataSource,
                institutionType: sourceInstitutionType(config.legacyDataSource),
                id: orgs.referenceDataSource.id || 'org-legacy-ds',
                name: `${orgs.referenceDataSource.name || 'Legacy Node Data Source'} (compatibility)`,
                endpoint: config.legacyDataSource.internalFhirBaseUrl,
                pcmClientAuth: {
                    clientId: orgs.referenceDataSource.clientId,
                    cert: legacyRoles.assertion?.cert,
                    key: legacyRoles.assertion?.key,
                    mtlsCert: legacyRoles.mtls?.cert,
                    mtlsKey: legacyRoles.mtls?.key,
                    assertionCertificates: orgs.referenceDataSource.assertionCertificates || {}
                },
                enabled: true
            }, config.healthOrganizations.length);
            if (legacy) result.push({ ...legacy, builtIn: true, healthOrganizationId: 'legacy-ds', compatibilityOnly: true, managedHapi: false });
        }
    } else if (orgs.referenceDataSource?.endpoint) {
        result.push({
            ...normalizeConfiguredSource({ ...orgs.referenceDataSource, enabled: true }, 0),
            builtIn: true
        });
    }

    ensureArray(orgs.dataSources)
        .map((source, index) => normalizeConfiguredSource(source, index))
        .filter(Boolean)
        .forEach(source => result.push({ ...source, builtIn: false }));

    return includeDisabled ? result : result.filter(source => source.enabled !== false);
}

function toConfigDataSource(raw, index = 0) {
    const normalized = normalizeConfiguredSource(raw, index);
    if (!normalized) return null;
    return normalized;
}

function parentOrg(id, name, businessIdentifier) {
    return {
        resourceType: 'Organization',
        id,
        meta: { profile: [PROFILES.organizationParent], lastUpdated: FIXTURE_LAST_UPDATED },
        identifier: [{ use: 'official', ...(businessIdentifier || { system: IDENTIFIER_SYSTEMS.organization, value: `PCM-ORG-${id.toUpperCase()}` }) }],
        active: true,
        name,
        type: [
            { coding: [{ system: PCM_ORG_TYPE, code: 'parent-org' }] },
            { coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1' }] }
        ],
        contact: [
            contact('http://terminology.hl7.org/CodeSystem/contactentity-type', 'ADMIN', `${name} Administration`),
            contact('http://terminology.hl7.org/CodeSystem/contactentity-type', 'PATINF', `${name} Patient Information`),
            contact(CODE_SYSTEMS.contactEntityType, 'SEC', `${name} Security`)
        ]
    };
}

/** Build a deterministic contact fixture for a generated Data Source. */
function contact(system, code, name) {
    return {
        purpose: { coding: [{ system, code }] },
        name: { text: name },
        telecom: [{ system: 'email', value: `${code.toLowerCase()}@sandbox.invalid` }]
    };
}

function sourceEndpoint(source, fallbackThumbprint) {
    const serverTrust = source.serverTrust || {};
    return {
        resourceType: 'Endpoint',
        id: source.endpointId,
        meta: { profile: [PROFILES.endpoint], lastUpdated: FIXTURE_LAST_UPDATED },
        status: 'active',
        connectionType: {
            system: CODE_SYSTEMS.endpointConnectionType,
            code: 'hl7-fhir-rest',
            display: 'HL7 FHIR'
        },
        payloadType: [{
            coding: [{
                code: 'any',
                system: CODE_SYSTEMS.endpointPayloadType
            }]
        }],
        address: source.endpoint,
        managingOrganization: { reference: `Organization/${source.id}` },
        extension: [
            certExtension(serverTrust.certThumbprint || source.certThumbprint || fallbackThumbprint)
        ]
    };
}

function sourceOrg(source) {
    return {
        resourceType: 'Organization',
        id: source.id,
        meta: { profile: [PROFILES.organizationSource], lastUpdated: FIXTURE_LAST_UPDATED },
        identifier: [{ use: 'official', ...source.businessIdentifier }],
        active: true,
        name: source.name,
        type: [
            { coding: [{ system: PCM_ORG_TYPE, code: 'source' }] },
            { coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1' }] }
        ],
        partOf: { reference: `Organization/${source.parentId}` },
        contact: [contact(CODE_SYSTEMS.contactEntityType, 'OPS', `${source.name} Operations`)],
        endpoint: [{ reference: `Endpoint/${source.endpointId}` }]
    };
}

function upsert(store, resource) {
    if (store.get(resource.resourceType, resource.id)) return store.update(resource);
    return store.add(resource);
}

function syncDataSourcesToStore(store, config, fallbackThumbprint, { preserveExisting = false } = {}) {
    return store.transaction(() => {
        for (const source of getConfiguredDataSources(config)) {
            for (const resource of [parentOrg(source.parentId, source.parentName, source.parentBusinessIdentifier), sourceEndpoint(source, fallbackThumbprint), sourceOrg(source)]) {
                const current = store.get(resource.resourceType, resource.id);
                if (!current || !preserveExisting) upsert(store, resource);
                else if (resource.resourceType === 'Endpoint') {
                    const certificateExtensions = (resource.extension || []).filter(item => item.url === EXT_CERTS);
                    const extensions = [...(current.extension || []).filter(item => item.url !== EXT_CERTS), ...certificateExtensions];
                    if (JSON.stringify(extensions) !== JSON.stringify(current.extension || [])) store.update({ ...current, extension: extensions });
                }
            }
        }
    });
}

function getApprovedTokenScope(consent, store) {
    const decision = consent && store?.privateRecords.approvals.getDecision(consent.id);
    return decision?.status === 'ok' ? decision.snapshot.scope : '';
}

/** Reject the retired public draft writer; the private approval command owns choices. */
function setApprovedTokenScope(consent, scope, origin = { kind: 'custom', label: 'Custom scope' }) {
    if (consent.status && !['proposed', 'draft'].includes(consent.status)) throw Object.assign(new Error('Approved scope is read-only; create a new Consent.'), { status: 409 });
    if (typeof scope !== 'string') throw new TypeError('Approved scope must be a string');
    throw Object.assign(new Error('Pending scope drafts belong to the private approval command; public Consent scope metadata is prohibited.'), { status: 409 });
}

function newDataSourceConfig(name, endpoint, options = {}) {
    const id = `org-${slug(name || endpoint)}-${uuidv4().slice(0, 8)}`;
    const certBase = `custom/${id}`;
    const clientId = options.clientId || createOpaqueClientId('pcm-ds', id);
    return toConfigDataSource({
        id,
        endpointId: `endpoint-${id.replace(/^org-/, '')}`,
        parentId: `${id}-parent`,
        parentName: `${name || 'Custom Data Source'} Org`,
        name,
        endpoint,
        clientId,
        institutionType: options.institutionType ?? 'other',
        scopes: options.scopes || ['introspection'],
        pcmClientAuth: {
            clientId,
            cert: options.cert || `${certBase}.crt`,
            key: options.key || `${certBase}.key`,
            certThumbprint: options.pcmClientAuthCertThumbprint || null
        },
        serverTrust: {
            mode: options.serverTrustMode || 'team-root-ca',
            caCert: options.serverTrustCaCert || null,
            certThumbprint: options.serverTrustCertThumbprint || null
        },
        certThumbprint: options.serverTrustCertThumbprint || null,
        enabled: true
    });
}

module.exports = {
    DEFAULT_TOKEN_SCOPE,
    EXT_APPROVED_SCOPE,
    STRICT_SANDBOX_TOKEN_SCOPE,
    getApprovedTokenScope,
    getConfiguredDataSources,
    newDataSourceConfig,
    setApprovedTokenScope,
    syncDataSourcesToStore,
    toConfigDataSource
};
