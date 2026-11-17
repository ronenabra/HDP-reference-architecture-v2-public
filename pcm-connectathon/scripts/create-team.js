#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { planTeamCredentials } = require('./team-credentials');
const { writePrivateEnvironment } = require('./private-env');
const { composeHostPath, parseArgs, repoRoot, readJson, writeJson, copyFile, requireSafeTeamId, teamClientId, run, DEFAULT_TEAMS_ROOT } = require('./lib');
const { environmentEndpoints, tokenMaximumSeconds, PCM_PATH } = require('../../src/shared/pcm-environment');
const { IDENTIFIER_SYSTEMS } = require('../../src/shared/pcm-contract');
const { CONFORMANCE_MODES, POLICY_VERSION, buildEffectivePolicy, presetSimulationDefaults, presetSourceDefaults } = require('../../src/shared/conformance-policy');
const { buildReferenceHealthOrganizations, validateHealthOrganizations } = require('../../src/shared/health-organizations');
const { CONFIG_VERSION, PRESETS, assertValidTeamConfig } = require('../../src/shared/team-config-validator');

const args = parseArgs(process.argv);
const teamId = args['team-id'];
requireSafeTeamId(teamId);

const root = repoRoot();
const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
const teamDir = path.join(teamsRoot, teamId);
const config = readJson(path.join(root, 'pcm-connectathon', 'example-team-config.json'));
const displayName = teamId.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const preset = args.preset || (args.mode === 'strict' ? 'strict' : config.conformance?.preset) || 'connectathon-easy';
if (!PRESETS.includes(preset)) throw new Error(`--preset must be ${PRESETS.join(', ')}`);
const credentials = planTeamCredentials(teamDir, preset);
const mode = preset === 'strict' ? 'strict' : 'connectathon';
if (!CONFORMANCE_MODES.includes(mode)) throw new Error(`--mode must be ${CONFORMANCE_MODES.join(' or ')}`);

config.configVersion = CONFIG_VERSION;
config.contract.environment = args.environment || config.contract.environment;
const logical = environmentEndpoints(config.contract.environment);
config.contract.operational = { oauthBase: logical.oauthBase, fhirBase: logical.fhirBase };
config.teamId = teamId;
config.healthOrganizations = buildReferenceHealthOrganizations(teamId, Number(args['ds-port'] || 8180));
config.conformance = {
    mode,
    preset,
    policyVersion: POLICY_VERSION,
    compatibilityAdapters: mode === 'connectathon'
        ? [...(config.conformance?.compatibilityAdapters || [])]
        : []
};
delete config.sandboxSampler;
config.sandboxSampling = { sourceIds: config.healthOrganizations.map(ho => ho.id) };
config.sandbox = {};
config.securitySimulation = {
    global: presetSimulationDefaults(preset),
    perSource: presetSourceDefaults(preset),
    awsCredentialIsolation: true
};
config.organizations.pcm.clientId = teamClientId(teamId, 'system');
config.organizations.serviceProvider.assertionCertificates = { ES384: ['sp-client-assertion-es384.crt'] };
config.organizations.serviceProvider.clientId = teamClientId(teamId, 'sp');
config.organizations.hospitalBServiceProvider.clientId = teamClientId(teamId, 'sp-b');
config.organizations.referenceDataSource.clientId = teamClientId(teamId, 'ds');
config.organizations.teamDataSource.clientId = teamClientId(teamId, 'team-ds');
config.organizations.untrustedClient.clientId = teamClientId(teamId, 'negative');
for (const role of ['serviceProvider', 'hospitalBServiceProvider']) config.systemAuthorization.clientEntitlements[config.organizations[role].clientId] = ['sandbox-patient-sample'];
for (const [suffix, organization] of Object.entries({
    SYSTEM: config.organizations.pcm,
    SP: config.organizations.serviceProvider,
    'SP-B': config.organizations.hospitalBServiceProvider,
    DS: config.organizations.referenceDataSource,
    'TEAM-DS': config.organizations.teamDataSource
})) {
    organization.businessIdentifier = {
        system: IDENTIFIER_SYSTEMS.organization,
        value: `PCM-ORG-${teamId.toUpperCase()}-${suffix}`
    };
    if (organization.parentId) {
        organization.parentBusinessIdentifier = {
            system: IDENTIFIER_SYSTEMS.organization,
            value: `PCM-ORG-${teamId.toUpperCase()}-${suffix}-PARENT`
        };
    }
}
config.security.pcmApi.clientAuth = args['pcm-api-client-auth'] || config.security.pcmApi.clientAuth;
config.security.pcmApi.allowAnyTokenResource = args['pcm-allow-any-token-resource'] === 'true';
config.security.pcmApi.accessTokenExpiresInSeconds = Number.isSafeInteger(Number(args['pcm-access-token-expires-in-seconds']))
    ? Number(args['pcm-access-token-expires-in-seconds'])
    : tokenMaximumSeconds(config);
config.security.dataSourceGateway.clientAuth = args['ds-gateway-client-auth'] || config.security.dataSourceGateway.clientAuth;
config.security.serviceProviderToDataSource.verifyServerCertificate = args['sp-ds-verify-server-certificate'] === 'true';
config.security.dsGatewayToFhirServer.protocol = args['ds-fhir-upstream-protocol'] || config.security.dsGatewayToFhirServer.protocol;
config.security.dsGatewayToFhirServer.verifyServerCertificate = args['ds-fhir-upstream-verify-server-certificate'] === 'true';
config.security.dsGatewayToFhirServer.customUrl = args['ds-fhir-upstream-custom-url'] || config.security.dsGatewayToFhirServer.customUrl || '';
if (config.security.dsGatewayToFhirServer.customUrl) config.security.dsGatewayToFhirServer.customUrlScope = 'legacy-ds';
config.security.dsFhirServer.enforceMappedPatients = true;
if (preset === 'connectathon-easy') {
    config.security.pcmApi.clientAuth = 'tls';
    config.security.dataSourceGateway.clientAuth = 'tls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = false;
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = false;
} else if (preset === 'connectathon-mtls') {
    config.security.pcmApi.clientAuth = 'mtls';
    config.security.dataSourceGateway.clientAuth = 'mtls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = true;
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = true;
} else if (preset === 'connectathon-balanced') {
    config.security.pcmApi.clientAuth = 'tls';
    config.security.dataSourceGateway.clientAuth = 'tls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = true;
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = true;
    config.security.dsFhirServer.enforceMappedPatients = true;
} else {
    config.security.pcmApi.clientAuth = 'mtls';
    config.security.pcmApi.allowAnyTokenResource = false;
    config.security.dataSourceGateway.clientAuth = 'mtls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = true;
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = true;
    config.security.dsFhirServer.enforceMappedPatients = true;
}
if (config.legacyDataSource) config.legacyDataSource.enabled = mode !== 'strict';
buildEffectivePolicy(config, {});
for (const ho of config.healthOrganizations) {
    ho.clinicalData.privateFhirBaseUrl = `${config.security.dsGatewayToFhirServer.protocol}://${ho.id}-hapi:8080/fhir`;
}
config.publicBaseUrls.spClient = require('../../src/shared/doctor-browser-address').doctorBrowserBase(args['doctor-base-url'] || `http://localhost:${args['sp-port'] || 3100}`);
config.organizations.serviceProvider.redirectUri = require('../../src/shared/doctor-browser-address').doctorCallback(config.publicBaseUrls.spClient);
config.organizations.serviceProvider.redirectUris = [config.organizations.serviceProvider.redirectUri];
config.publicBaseUrls.pcmUi = `http://localhost:${args['pcm-ui-port'] || 4100}`;
config.publicBaseUrls.pcmApi = `https://localhost:${args['pcm-api-port'] || 4101}${PCM_PATH}`;
config.publicBaseUrls.pcmMetadata = `https://localhost:${args['pcm-metadata-port'] || Number(args['pcm-api-port'] || 4101) + 1}${PCM_PATH}`;
const legacyDsPort = Number(args['ds-port'] || 8180) + 3;
config.publicBaseUrls.referenceDataSource = `https://localhost:${legacyDsPort}/fhir`;
config.publicBaseUrls.dataSourceMetadata = `http://localhost:${args['ds-http-port'] || legacyDsPort + 1}`;
config.publicBaseUrls.healthOrganizations = Object.fromEntries(config.healthOrganizations.map(ho => [
    ho.id,
    `https://localhost:${ho.gatewayPort}/fhir`
]));
config.legacyDataSource = {
    ...(config.legacyDataSource || {}),
    id: 'legacy-ds',
    enabled: mode !== 'strict',
    compatibilityOnly: true,
    managedHapi: false,
    publicFhirBaseUrl: `https://localhost:${legacyDsPort}/fhir`,
    internalFhirBaseUrl: 'https://legacy-ds-gateway:8080/fhir',
    fixtureResetSupported: true
};
config.internalBaseUrls.healthOrganizations = Object.fromEntries(config.healthOrganizations.map(ho => [ho.id, ho.endpoint]));
config.internalBaseUrls.pcmUi = 'http://pcm-core:3001';
config.organizations.serviceProvider.parentName = `${displayName} Hospital`;
config.organizations.serviceProvider.name = `${displayName} Service Provider`;
config.organizations.referenceDataSource.parentName = `${displayName} Reference Data Source Org`;
config.organizations.referenceDataSource.name = `${displayName} Reference Data Source`;
config.organizations.teamDataSource.parentName = `${displayName} Data Source Org`;
config.organizations.teamDataSource.name = `${displayName} Data Source`;
config.organizations.dataSources = [];
// Only newly created teams adopt the external catalog; retained service settings stay stable.
const demoCatalog = readJson(path.join(root, 'config/demo-services.json'));
config.serviceCatalog = {
    file: 'catalog/demo-services.json',
    bindings: Object.entries({ doctor: 'serviceProvider', 'doctor-b': 'hospitalBServiceProvider' }).flatMap(([application, providerRole]) => demoCatalog.clinicalServices.map(definition => ({
        application, providerRole, serviceKey: definition.key,
        instanceId: application === 'doctor' && definition.key === 'lab-follow-up' ? config.service.id : `demo-${application}-${definition.key}`,
        instanceIdentifier: `PCM-DEMO-${application.toUpperCase()}-${definition.key.toUpperCase()}`
    })))
};
config.service.catalogId = 'demo-catalog-lab-follow-up';
require('../../src/shared/service-catalog').validateCatalogGraph(demoCatalog, config);
const hoErrors = validateHealthOrganizations(config);
if (hoErrors.length) throw new Error(hoErrors.join('; '));
assertValidTeamConfig(config, { schemaPath: path.join(root, 'pcm-connectathon', 'team-config.schema.json') });

for (const dir of [
    'certs', 'logs/pcm-core', 'logs/sp-client', 'logs/ds-auth-adapter',
    'logs/ds-fhir-server', 'logs/ds-gateway', 'state', 'state/import',
    ...config.healthOrganizations.flatMap(ho => [`logs/${ho.id}-gateway`, `logs/${ho.id}-adapter`,
        `logs/${ho.id}-hapi`, `state/${ho.id}-adapter`])
]) {
    fs.mkdirSync(path.join(teamDir, dir), { recursive: true });
}

fs.mkdirSync(path.join(teamDir, 'catalog'), { recursive: true });
copyFile(path.join(root, 'config/demo-services.json'), path.join(teamDir, config.serviceCatalog.file));
writeJson(path.join(teamDir, 'team-config.json'), config);

// Generated teams never reuse the example's private operational credentials.
let env = credentials.retained?.text ?? fs.readFileSync(path.join(root, 'pcm-connectathon', 'example.env'), 'utf8');
for (const name of ['PCM_POSTGRES_ADMIN_PASSWORD', 'TEAM_ADMIN_PASSWORD']) {
    const value = credentials.values[name];
    const line = `${name}=${value}`;
    env = new RegExp(`^${name}=`, 'm').test(env) ? env.replace(new RegExp(`^${name}=.*$`, 'm'), () => line) : `${env.trimEnd()}\n${line}\n`;
}
env = env
    .replace(/^TEAM_ID=.*$/m, `TEAM_ID=${teamId}`)
    .replace(/^TEAM_RUNTIME_DIR=.*$/m, `TEAM_RUNTIME_DIR=${composeHostPath(root, teamDir)}`)
    .replace(/^TEAM_CONFIG_HOST_PATH=.*$/m, `TEAM_CONFIG_HOST_PATH=${composeHostPath(root, path.join(teamDir, 'team-config.json'))}`)
    .replace(/^PCM_CONFORMANCE_MODE=.*$/m, `PCM_CONFORMANCE_MODE=${mode}`)
    .replace(/^PCM_API_CLIENT_AUTH_MODE=.*$/m, `PCM_API_CLIENT_AUTH_MODE=${config.security.pcmApi.clientAuth}`)
    .replace(/^PCM_ALLOW_ANY_TOKEN_RESOURCE=.*$/m, `PCM_ALLOW_ANY_TOKEN_RESOURCE=${config.security.pcmApi.allowAnyTokenResource}`)
    .replace(/^PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=.*$/m, `PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=${config.security.pcmApi.accessTokenExpiresInSeconds}`)
    .replace(/^DS_GATEWAY_CLIENT_AUTH_MODE=.*$/m, `DS_GATEWAY_CLIENT_AUTH_MODE=${config.security.dataSourceGateway.clientAuth}`)
    .replace(/^SP_DS_VERIFY_SERVER_CERTIFICATE=.*$/m, `SP_DS_VERIFY_SERVER_CERTIFICATE=${config.security.serviceProviderToDataSource.verifyServerCertificate}`)
    .replace(/^DS_FHIR_UPSTREAM_PROTOCOL=.*$/m, `DS_FHIR_UPSTREAM_PROTOCOL=${config.security.dsGatewayToFhirServer.protocol}`)
    .replace(/^DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE=.*$/m, `DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE=${config.security.dsGatewayToFhirServer.verifyServerCertificate}`)
    .replace(/^DS_FHIR_UPSTREAM_CUSTOM_URL=.*$/m, `DS_FHIR_UPSTREAM_CUSTOM_URL=${config.security.dsGatewayToFhirServer.customUrl}`)
    .replace(/^FHIR_SERVER_TLS=.*$/m, `FHIR_SERVER_TLS=${config.security.dsGatewayToFhirServer.protocol === 'https'}`)
    .replace(/^SP_PORT=.*$/m, `SP_PORT=${args['sp-port'] || 3100}`)
    .replace(/^PCM_UI_PORT=.*$/m, `PCM_UI_PORT=${args['pcm-ui-port'] || 4100}`)
    .replace(/^PCM_API_PORT=.*$/m, `PCM_API_PORT=${args['pcm-api-port'] || 4101}`)
    .replace(/^PCM_METADATA_PORT=.*$/m, `PCM_METADATA_PORT=${args['pcm-metadata-port'] || Number(args['pcm-api-port'] || 4101) + 1}`)
    .replace(/^DS_GATEWAY_PORT=.*$/m, `DS_GATEWAY_PORT=${legacyDsPort}`)
    .replace(/^DS_GATEWAY_HTTP_PORT=.*$/m, `DS_GATEWAY_HTTP_PORT=${args['ds-http-port'] || legacyDsPort + 1}`);
for (const [name, value] of Object.entries({
    PCM_HAPI_HEALTH_START_PERIOD: process.env.PCM_HAPI_HEALTH_START_PERIOD || '90s',
    ...(process.env.VERSION ? { VERSION: process.env.VERSION } : {}),
    ...(process.env.PCM_HAPI_VERSION ? { PCM_HAPI_VERSION: process.env.PCM_HAPI_VERSION } : {}),
    LOCAL_UID: typeof process.getuid === 'function' ? process.getuid() : 1000,
    LOCAL_GID: typeof process.getgid === 'function' ? process.getgid() : 1000
})) {
    const line = `${name}=${value}`;
    env = new RegExp(`^${name}=`, 'm').test(env) ? env.replace(new RegExp(`^${name}=.*$`, 'm'), () => line) : `${env.trimEnd()}\n${line}\n`;
}
for (const ho of config.healthOrganizations) {
    const letter = ho.id.slice(-1).toUpperCase();
    const defaults = {
        [`PCM_${letter}_DB_NAME`]: ho.database.name,
        [`PCM_${letter}_DB_USER`]: ho.database.user,
        [ho.database.passwordEnv]: credentials.values[ho.database.passwordEnv],
        [ho.import.credentialEnv]: credentials.values[ho.import.credentialEnv]
    };
    for (const [name, value] of Object.entries(defaults)) {
        const line = `${name}=${value}`;
        env = new RegExp(`^${name}=`, 'm').test(env) ? env.replace(new RegExp(`^${name}=.*$`, 'm'), () => line) : `${env.trimEnd()}\n${line}\n`;
    }
    const gatewayPortName = `HO_${letter}_GATEWAY_PORT`;
    const gatewayPortLine = `${gatewayPortName}=${ho.gatewayPort}`;
    env = new RegExp(`^${gatewayPortName}=`, 'm').test(env)
        ? env.replace(new RegExp(`^${gatewayPortName}=.*$`, 'm'), gatewayPortLine)
        : `${env.trimEnd()}\n${gatewayPortLine}\n`;
}
writePrivateEnvironment(path.join(teamDir, '.env'), env);

if (args['generate-certs'] === 'true' || args['generate-certs'] === true) {
    run('node', [
        'pcm-connectathon/scripts/generate-team-certs.js',
        '--team-id', teamId,
        '--out', path.join(teamDir, 'certs'),
        '--pcm-api-host', args['pcm-api-host'] || 'localhost',
        '--sp-host', args['sp-host'] || 'localhost',
        '--ds-host', args['ds-host'] || 'localhost'
    ], { cwd: root });
}

console.log(`Created ${path.relative(root, teamDir)}`);
if (!(args['generate-certs'] === 'true' || args['generate-certs'] === true)) {
    console.log(`Next: node pcm-connectathon/scripts/generate-team-certs.js --team-id ${teamId} --out ${path.join(teamDir, 'certs')}`);
}
