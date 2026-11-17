/**
 * Seed PCM with initial FHIR resources and certificate thumbprints.
 */
const fs = require('fs');
const store = require('./fhir/store');
const { certToX5tS256 } = require('./crypto');
const { loadTeamConfig, certPath } = require('./team-config');
const { syncDataSourcesToStore } = require('./data-sources');
const {
    CODE_SYSTEMS,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    OPERATIONAL,
    PROFILES,
    validateSeedResource
} = require('../../shared/pcm-contract');

const PCM_ORG_TYPE = CODE_SYSTEMS.organizationType;
const EXT_CERTS = EXTENSIONS.applicableCertificates;
const EXT_REDIRECT = EXTENSIONS.oauthRedirectUri;
const FIXTURE_LAST_UPDATED = '2026-01-05T08:00:00Z';

/**
 * Compute x5t#S256 thumbprint (base64url) for a certificate on disk.
 * @param {string} filePath
 * @returns {string|null}
 */
function getThumbprint(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const cert = fs.readFileSync(filePath, 'utf8');
    return certToX5tS256(cert);
}

function certExtension(thumbprint) {
    return {
        url: EXT_CERTS,
        extension: [{ url: 'thumbprint', valueString: thumbprint || 'A'.repeat(43) }]
    };
}

/** Build the official Organization business identifier used in seed data. */
function businessIdentifier(configured, fallback) {
    return {
        use: 'official',
        system: configured?.system || IDENTIFIER_SYSTEMS.organization,
        value: configured?.value || fallback
    };
}

/** Build one profile-constrained Organization contact fixture. */
function organizationContact(system, code, name, telecomSystem = 'email') {
    return {
        purpose: { coding: [{ system, code }] },
        name: { text: name },
        telecom: [{
            system: telecomSystem,
            value: telecomSystem === 'email' ? `${code.toLowerCase()}@sandbox.invalid` : '+972-2-555-0100'
        }]
    };
}

/** Build the ADMIN, patient-information, and security parent contacts. */
function parentContacts(name) {
    return [
        organizationContact('http://terminology.hl7.org/CodeSystem/contactentity-type', 'ADMIN', `${name} Administration`),
        organizationContact('http://terminology.hl7.org/CodeSystem/contactentity-type', 'PATINF', `${name} Patient Information`, 'phone'),
        organizationContact(CODE_SYSTEMS.contactEntityType, 'SEC', `${name} Security`)
    ];
}

/** Build a parent Organization seed conforming to the pinned parent profile. */
function parentOrg(id, name, configuredIdentifier) {
    return {
        resourceType: 'Organization',
        id,
        meta: { profile: [PROFILES.organizationParent], lastUpdated: FIXTURE_LAST_UPDATED },
        identifier: [businessIdentifier(configuredIdentifier, `PCM-ORG-${id.toUpperCase()}`)],
        active: true,
        name,
        type: [
            { coding: [{ system: PCM_ORG_TYPE, code: 'parent-org' }] },
            { coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1' }] }
        ],
        contact: parentContacts(name)
    };
}

/** Build the required canonical or instance service extension set. */
function serviceExtensions(config, kind, canonicalId, createdAt) {
    // Fresh seed creation is an explicit new definition; bootstrap never rewrites an existing service.
    const definition = require('./service-definition-form').serviceDefinitionDraft({
        name: config.service.name || 'General Practice / Telehealth',
        purpose: config.service.purpose || 'Continuity of care at approved sources.', category: '35',
        accessMode: config.service.accessMode || 'continuous', duration: 6, durationUnit: 'mo', allowChanges: true,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 'rs' }],
        scopeOrigin: 'generated'
    }, { now: Math.floor(createdAt.getTime() / 1000) });
    return [
        ...definition.extension,
        {
            url: EXTENSIONS.serviceBusinessStatus,
            valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'active', display: 'Active' }
        },
        ...(kind === 'instance' ? [{
            url: EXTENSIONS.basedOnCanonicalHealthcareService,
            valueReference: { reference: `HealthcareService/${canonicalId}` }
        }, {
            url: EXTENSIONS.approvalWindow,
            valuePeriod: { start: '2026-01-01T00:00:00+02:00', end: '2027-01-01T00:00:00+02:00' }
        }] : []),

    ];
}

/** Build the common pinned-profile HealthcareService fixture shape. */
function serviceShape(config, kind, id, identifierSystem, identifierValue, createdAt = new Date()) {
    return {
        resourceType: 'HealthcareService',
        id,
        meta: {
            profile: [kind === 'catalog' ? PROFILES.healthcareServiceCanonical : PROFILES.healthcareServiceInstance],
            tag: [{ system: CODE_SYSTEMS.metaTag, code: kind, display: kind === 'catalog' ? 'Catalog' : 'Instance' }],
            lastUpdated: FIXTURE_LAST_UPDATED
        },
        identifier: [{ use: 'official', system: identifierSystem, value: identifierValue }],
        extension: serviceExtensions(config, kind, config.service.catalogId || 'service-catalog-1', createdAt),
        active: true,
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/service-category', code: '35' }] }],
        type: [{ coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            code: 'INFA',
            display: 'information access'
        }] }],
        name: config.service.name || 'General Practice / Telehealth',
        extraDetails: config.service.purpose || 'Permits authorized continuity-of-care access to configured clinical information.'
    };
}

/** Fail bootstrap before mutation when a generated seed violates the contract. */
function assertSeedResources(resources) {
    for (const resource of resources) {
        const failures = validateSeedResource(resource);
        if (failures.length) throw new Error(`${resource.resourceType}/${resource.id}: ${failures.join('; ')}`);
    }
    return resources;
}

/** Build deterministic baseline resources without mutating the FHIR store. */
function buildSeedDrafts(config, thumbprints = {}, clock = () => new Date()) {
    const orgs = config.organizations;
    const createdAt = clock();
    const resources = [
        parentOrg(orgs.serviceProvider.parentId, orgs.serviceProvider.parentName, orgs.serviceProvider.parentBusinessIdentifier),
        {
            resourceType: 'Organization',
            id: orgs.serviceProvider.id,
            meta: { profile: [PROFILES.organizationServiceProvider], lastUpdated: FIXTURE_LAST_UPDATED },
            identifier: [businessIdentifier(orgs.serviceProvider.businessIdentifier, 'PCM-ORG-SP-0001')],
            active: true,
            name: orgs.serviceProvider.name,
            type: [
                { coding: [{ system: PCM_ORG_TYPE, code: 'service-provider' }] },
                { coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1', display: 'General Hospital' }] }
            ],
            partOf: { reference: `Organization/${orgs.serviceProvider.parentId}` },
            contact: [organizationContact(CODE_SYSTEMS.contactEntityType, 'OPS', `${orgs.serviceProvider.name} Operations`)],
            extension: [
                { url: EXT_REDIRECT, valueUrl: orgs.serviceProvider.redirectUri },
                certExtension(thumbprints.serviceProvider)
            ]
        },
        {
            resourceType: 'Organization',
            id: orgs.pcm.id,
            meta: { profile: [PROFILES.organizationSystem], lastUpdated: FIXTURE_LAST_UPDATED },
            identifier: [{
                use: 'official',
                system: 'http://institutions.health.gov.il/Institutions',
                value: orgs.pcm.businessIdentifier?.value || 'PCM'
            }],
            active: true,
            name: orgs.pcm.name,
            type: [
                { coding: [{ system: PCM_ORG_TYPE, code: 'pcm' }] },
                { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'govt' }] }
            ],
            contact: parentContacts(orgs.pcm.name),
            extension: [certExtension(thumbprints.pcm)],
            endpoint: [{ reference: 'Endpoint/endpoint-pcm-system' }]
        },
        {
            resourceType: 'Endpoint',
            id: 'endpoint-pcm-system',
            meta: { profile: [PROFILES.endpointSystem], lastUpdated: FIXTURE_LAST_UPDATED },
            status: 'active',
            connectionType: {
                system: CODE_SYSTEMS.endpointConnectionType,
                code: 'hl7-fhir-rest',
                display: 'HL7 FHIR'
            },
            payloadType: [{ coding: [{ code: 'any', system: CODE_SYSTEMS.endpointPayloadType }] }],
            address: config.contract?.operational?.fhirBase || OPERATIONAL.fhirBase,
            managingOrganization: { reference: `Organization/${orgs.pcm.id}` },
            extension: [certExtension(thumbprints.pcm)]
        },
        serviceShape(
            config,
            'catalog',
            config.service.catalogId || 'service-catalog-1',
            IDENTIFIER_SYSTEMS.healthcareServiceCatalog,
            config.service.catalogIdentifier || 'PCM-HS-CAT-0001', createdAt
        ),
        {
            ...serviceShape(
                config,
                'instance',
                config.service.id || 'service-1',
                IDENTIFIER_SYSTEMS.healthcareServiceInstance,
                config.service.instanceIdentifier || 'PCM-HS-INST-0001', createdAt
            ),
            // The requesting SP application owns the executable instance; the
            // parent organization remains its organizational hierarchy only.
            providedBy: { reference: `Organization/${orgs.serviceProvider.id}` }
        }
    ];
    const hospitalB = orgs.hospitalBServiceProvider;
    if (hospitalB) {
        resources.push(
            parentOrg(hospitalB.parentId, hospitalB.parentName, hospitalB.parentBusinessIdentifier),
            {
                resourceType: 'Organization',
                id: hospitalB.id,
                meta: { profile: [PROFILES.organizationServiceProvider], lastUpdated: FIXTURE_LAST_UPDATED },
                identifier: [businessIdentifier(hospitalB.businessIdentifier, 'PCM-ORG-SP-0002')],
                active: true,
                name: hospitalB.name,
                type: [
                    { coding: [{ system: PCM_ORG_TYPE, code: 'service-provider' }] },
                    { coding: [{ system: 'http://fhir.health.gov.il/cs/institution-type-moh', code: '1' }] }
                ],
                partOf: { reference: `Organization/${hospitalB.parentId}` },
                contact: [organizationContact(CODE_SYSTEMS.contactEntityType, 'OPS', `${hospitalB.name} Operations`)],
                extension: [certExtension(thumbprints.hospitalB)]
            }
        );
    }
    const catalog = require('./catalog-bootstrap').buildCatalogServices(config, serviceShape, clock());
    const proposed = catalog ? [...resources.filter(resource => resource.resourceType !== 'HealthcareService'), ...catalog] : resources;
    return assertSeedResources(proposed);
}

/**
 * Load baseline organizations, endpoints, and services into the FHIR store.
 * @returns {void} Completes synchronously so maintenance can use the existing atomic transaction.
 */
function bootstrapSynchronous() {
    const config = loadTeamConfig();
    if (require('./migration-checkpoint').restore({ store, configPath: require('./team-config').getConfigPath(),
        stateDirectory: process.env.STATE_DIR || config.runtime.stateDir, runtimeId: process.env.PCM_MIGRATION_RUNTIME_ID })) {
        require('./public-fhir').assertRetainedCompatibility(store);
        return;
    }
    const orgs = config.organizations;

    console.log(`Bootstrapping PCM data for team ${config.teamId || 'local'}...`);

    const gatewayThumbprint = getThumbprint(certPath(config, 'referenceDataSource', 'cert', 'server')) || 'A'.repeat(43);
    const clientThumbprint = getThumbprint(certPath(config, 'serviceProvider', 'cert', 'assertion')) || 'B'.repeat(43);
    const pcmThumbprint = getThumbprint(certPath(config, 'pcm', 'cert', 'server')) || 'C'.repeat(43);
    const hospitalBThumbprint = getThumbprint(certPath(config, 'hospitalBServiceProvider', 'cert', 'assertion')) || 'D'.repeat(43);

    require('./public-fhir').assertRetainedCompatibility(store);
    // Validate all seeds and policies in an isolated graph before touching live state.
    const now = Math.floor(Date.now() / 1000);
    const seeds = buildSeedDrafts(config, { serviceProvider: clientThumbprint, pcm: pcmThumbprint, hospitalB: hospitalBThumbprint });
    const candidate = new store.FHIRStore();
    syncDataSourcesToStore(candidate, config, gatewayThumbprint);
    for (const resource of seeds) require('./public-fhir').publishNewResource(candidate, resource);
    const policies = require('./fhir/system-policy').buildSystemPolicyDrafts(config, now);
    for (const resource of policies) require('./public-fhir').publishNewResource(candidate, resource);
    for (const resource of policies.filter(resource => resource.resourceType === 'Contract')) {
        require('./fhir/system-policy').validatePolicy(candidate, resource, orgs.pcm.id);
    }
    const { publishCatalog, previewCatalog } = require('./catalog-bootstrap');
    const localPolicies = require('./fhir/sampling-policy').samplingResourceDrafts(config);
    for (const resource of localPolicies) require('./public-fhir').publishNewResource(candidate, resource);
    for (const resource of localPolicies.filter(item => item.resourceType === 'Contract')) require('./fhir/system-policy').validatePolicy(candidate, resource, orgs.pcm.id);
    const managed = [...seeds.filter(resource => resource.resourceType === 'HealthcareService'), ...policies, ...localPolicies];
    if (config.serviceCatalog && previewCatalog(store, managed).conflicts.length) throw new Error('Catalog definitions changed; preview explicit reconciliation before bootstrap');
    store.transaction(() => {
        for (const type of ['Organization', 'Endpoint']) for (const resource of candidate.getAll(type)) {
            if (!store.get(type, resource.id)) store.add(resource);
        }
        for (const resource of seeds.filter(resource => resource.resourceType !== 'HealthcareService')) {
            if (!store.get(resource.resourceType, resource.id)) require('./public-fhir').publishNewResource(store, resource);
        }
        if (config.serviceCatalog) publishCatalog(store, managed);
        else {
            for (const resource of managed) if (!store.get(resource.resourceType, resource.id)) require('./public-fhir').publishNewResource(store, resource);
        }
        // Enrollment belongs to actual provisioning, never a Services read/render.
        const lifecycle = require('./fhir/healthcare-service-lifecycle');
        for (const provider of store.getAll('Organization')) lifecycle.enrollProviderDefault({ store, provider });
    });
    console.log('Bootstrap complete. Organizations and system policies loaded.');
}

/** Preserve the established asynchronous startup interface around the synchronous seed transaction. */
async function bootstrap() { return bootstrapSynchronous(); }
module.exports = bootstrap;
// Maintenance uses this synchronous owner inside the existing atomic store transaction.
module.exports.synchronous = bootstrapSynchronous;
/** Public examples contain no private authoring or provisioning fields. */
function buildSeedResources(...args) { return buildSeedDrafts(...args).map(item => require('./public-fhir').splitProduced(item).resource); }
module.exports.buildSeedResources = buildSeedResources;
module.exports.buildSeedDrafts = buildSeedDrafts;
module.exports.certExtension = certExtension;
module.exports.serviceShape = serviceShape;
