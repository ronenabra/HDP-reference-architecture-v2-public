'use strict';

const { DEFAULT_LIMITS, validateImportLimits } = require('./clinical-import-limits');

const { IDENTIFIER_SYSTEMS, isOpaqueClientId } = require('./pcm-contract');

const REFERENCE_HO_IDS = Object.freeze(['ho-a', 'ho-b', 'ho-c']);
const HO_ID_PATTERN = /^ho-[abc]$/;
const PG_NAME_PATTERN = /^[a-z][a-z0-9_]{2,62}$/;

function requireString(value, path, errors) {
    if (typeof value !== 'string' || !value.trim()) errors.push(`${path} is required`);
}

function unique(items, selector, path, errors) {
    const seen = new Map();
    for (const [index, item] of items.entries()) {
        const value = selector(item);
        if (value == null || value === '') continue;
        if (seen.has(value)) errors.push(`${path}[${index}] duplicates ${path}[${seen.get(value)}]: ${value}`);
        else seen.set(value, index);
    }
}

function certFiles(ho) {
    return Object.values(ho?.certificates || {}).filter(value => typeof value === 'string');
}

/** Validate the closed, exactly-three local Health Organization topology. */
function validateHealthOrganizations(config) {
    const errors = [];
    const organizations = config?.healthOrganizations;
    if (!Array.isArray(organizations)) return ['healthOrganizations must be an array of exactly ho-a, ho-b, and ho-c'];
    if (organizations.length !== 3) errors.push('healthOrganizations must contain exactly three entries');

    for (const [index, ho] of organizations.entries()) {
        const base = `healthOrganizations[${index}]`;
        if (!ho || typeof ho !== 'object' || Array.isArray(ho)) {
            errors.push(`${base} must be an object`);
            continue;
        }
        if (!HO_ID_PATTERN.test(ho.id || '')) errors.push(`${base}.id must be ho-a, ho-b, or ho-c`);
        for (const path of ['name', 'endpointId', 'endpoint', 'clientId', 'adapterIssuer', 'adapterAudience']) {
            requireString(ho[path], `${base}.${path}`, errors);
        }
        if (!isOpaqueClientId(ho.clientId || '')) errors.push(`${base}.clientId must be an opaque client identifier`);
        if (!/^https:\/\//.test(ho.endpoint || '')) errors.push(`${base}.endpoint must be HTTPS`);
        if (!/^https:\/\//.test(ho.adapterIssuer || '')) errors.push(`${base}.adapterIssuer must be HTTPS`);
        if (!/^urn:pcm:ho:[a-c]:fhir-server$/.test(ho.adapterAudience || '')) errors.push(`${base}.adapterAudience must be the HO-bound FHIR audience`);
        if (!Number.isInteger(ho.gatewayPort) || ho.gatewayPort < 1024 || ho.gatewayPort > 65535) errors.push(`${base}.gatewayPort must be an integer from 1024 to 65535`);

        for (const kind of ['parentOrganization', 'dataSourceOrganization']) {
            const organization = ho[kind];
            requireString(organization?.id, `${base}.${kind}.id`, errors);
            if (organization?.businessIdentifier?.system !== IDENTIFIER_SYSTEMS.organization || !organization?.businessIdentifier?.value) {
                errors.push(`${base}.${kind}.businessIdentifier must use the PCM organization identifier system`);
            }
        }
        if (!PG_NAME_PATTERN.test(ho.database?.name || '')) errors.push(`${base}.database.name must be a safe PostgreSQL name`);
        if (!PG_NAME_PATTERN.test(ho.database?.user || '')) errors.push(`${base}.database.user must be a safe PostgreSQL name`);
        requireString(ho.database?.passwordEnv, `${base}.database.passwordEnv`, errors);
        requireString(ho.import?.credentialEnv, `${base}.import.credentialEnv`, errors);
        requireString(ho.import?.stateNamespace, `${base}.import.stateNamespace`, errors);
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(ho.import?.stateNamespace || '')) errors.push(`${base}.import.stateNamespace must be a safe local namespace`);
        try { validateImportLimits(ho.clinicalData?.limits, { configuration: true }); } catch (error) { errors.push(`${base}.clinicalData.limits: ${error.message}`); }
        for (const role of ['gatewayServerCert', 'gatewayServerKey', 'gatewayMtlsCert', 'gatewayMtlsKey', 'gatewayAssertionCert', 'gatewayAssertionKey', 'hapiServerCert', 'hapiServerKey']) {
            requireString(ho.certificates?.[role], `${base}.certificates.${role}`, errors);
        }
        if (ho.clinicalData?.managed !== true) errors.push(`${base}.clinicalData.managed must be true for a HAPI server`);
        if (ho.clinicalData?.serverId !== ho.id) errors.push(`${base}.clinicalData.serverId must equal the Health Organization id`);
        if (!/^https?:\/\/[a-z0-9-]+-hapi:8080\/fhir$/.test(ho.clinicalData?.privateFhirBaseUrl || '')) errors.push(`${base}.clinicalData.privateFhirBaseUrl must identify the private named HAPI service`);
        if (!['disabled', 'if-empty', 'replace'].includes(ho.clinicalData?.bootstrap?.policy)) errors.push(`${base}.clinicalData.bootstrap.policy is invalid`);
    }

    const selectors = {
        id: ho => ho.id,
        endpointId: ho => ho.endpointId,
        endpoint: ho => ho.endpoint,
        clientId: ho => ho.clientId,
        gatewayPort: ho => ho.gatewayPort,
        adapterIssuer: ho => ho.adapterIssuer,
        adapterAudience: ho => ho.adapterAudience,
        databaseName: ho => ho.database?.name,
        databaseUser: ho => ho.database?.user,
        databasePassword: ho => ho.database?.passwordEnv,
        clinicalServer: ho => ho.clinicalData?.serverId,
        parentId: ho => ho.parentOrganization?.id,
        sourceId: ho => ho.dataSourceOrganization?.id,
        parentBusinessIdentifier: ho => ho.parentOrganization?.businessIdentifier?.value,
        sourceBusinessIdentifier: ho => ho.dataSourceOrganization?.businessIdentifier?.value,
        importCredential: ho => ho.import?.credentialEnv,
        importState: ho => ho.import?.stateNamespace
    };
    for (const [name, selector] of Object.entries(selectors)) unique(organizations, selector, `healthOrganizations.${name}`, errors);
    unique(organizations.flatMap(ho => [ho.endpointId, ho.parentOrganization?.id, ho.dataSourceOrganization?.id]), value => value, 'healthOrganizations.resourceId', errors);
    unique(organizations.flatMap(ho => [ho.parentOrganization?.businessIdentifier?.value, ho.dataSourceOrganization?.businessIdentifier?.value]), value => value, 'healthOrganizations.businessIdentifier', errors);
    unique(organizations.flatMap((ho, hoIndex) => certFiles(ho).map(file => ({ file, hoIndex }))), item => item.file, 'healthOrganizations.certificateFile', errors);

    const actualIds = organizations.map(ho => ho?.id).sort();
    if (actualIds.join(',') !== REFERENCE_HO_IDS.join(',')) errors.push('healthOrganizations ids must be exactly ho-a, ho-b, and ho-c');
    return errors;
}

/** Return the configured HO or fail instead of falling back to another tenant. */
function requireHealthOrganization(config, hoId) {
    const errors = validateHealthOrganizations(config);
    if (errors.length) throw new TypeError(errors.join('; '));
    const organization = config.healthOrganizations.find(ho => ho.id === hoId);
    if (!organization) throw new TypeError(`unknown Health Organization ${hoId}`);
    return organization;
}

/** Build deterministic three-HO configuration values for a local team. */
function buildReferenceHealthOrganizations(teamId, firstGatewayPort = 8180) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(teamId || '')) throw new TypeError('teamId is invalid');
    if (!Number.isInteger(firstGatewayPort) || firstGatewayPort < 1024 || firstGatewayPort > 65533) throw new TypeError('firstGatewayPort is invalid');
    return REFERENCE_HO_IDS.map((id, index) => {
        const letter = id.slice(-1);
        const upper = letter.toUpperCase();
        return {
            id,
            institutionType: 'hmo',
            name: `Reference Health Organization ${upper}`,
            parentOrganization: {
                id: `org-${teamId}-${id}-parent`,
                businessIdentifier: { system: IDENTIFIER_SYSTEMS.organization, value: `PCM-ORG-${teamId.toUpperCase()}-${upper}-PARENT` }
            },
            dataSourceOrganization: {
                id: `org-${teamId}-${id}-source`,
                businessIdentifier: { system: IDENTIFIER_SYSTEMS.organization, value: `PCM-ORG-${teamId.toUpperCase()}-${upper}-SOURCE` }
            },
            endpointId: `endpoint-${teamId}-${id}`,
            endpoint: `https://${id}-gateway:8080/fhir`,
            gatewayPort: firstGatewayPort + index,
            clientId: `pcm-ds-${teamId}-${id}-0001`,
            adapterIssuer: `https://${id}-adapter.internal/${id}`,
            adapterAudience: `urn:pcm:ho:${letter}:fhir-server`,
            database: { name: `pcm_${teamId.replace(/-/g, '_')}_${id.replace(/-/g, '_')}`, user: `pcm_${teamId.replace(/-/g, '_')}_${letter}`, passwordEnv: `PCM_${upper}_DB_PASSWORD` },
            certificates: {
                gatewayServerCert: `${id}-gateway.crt`, gatewayServerKey: `${id}-gateway.key`,
                gatewayMtlsCert: `${id}-gateway-mtls.crt`, gatewayMtlsKey: `${id}-gateway-mtls.key`,
                gatewayAssertionCert: `${id}-gateway-assertion.crt`, gatewayAssertionKey: `${id}-gateway-assertion.key`,
                hapiServerCert: `${id}-hapi.crt`, hapiServerKey: `${id}-hapi.key`
            },
            import: { credentialEnv: `PCM_${upper}_IMPORT_CREDENTIAL`, stateNamespace: `${teamId}-${id}` },
            clinicalData: {
                managed: true,
                serverId: id,
                privateFhirBaseUrl: `http://${id}-hapi:8080/fhir`,
                bundleRoot: '/runtime/bundles',
                bootstrap: { policy: 'disabled', bundleReference: '', expectedSource: '' },
                limits: { ...DEFAULT_LIMITS }
            }
        };
    });
}

module.exports = {
    REFERENCE_HO_IDS,
    buildReferenceHealthOrganizations,
    requireHealthOrganization,
    validateHealthOrganizations
};
