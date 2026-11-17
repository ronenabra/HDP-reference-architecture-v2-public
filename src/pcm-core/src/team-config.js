/**
 * Team configuration loader for pcm-connectathon stack-copy deployments.
 */
const fs = require('fs');
const path = require('path');
const { getEffectiveBusinessIdOverrides } = require('../../shared/identity-mapping');

const { buildEffectivePolicy } = require('../../shared/conformance-policy');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');

const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';
const TEAM_CONFIG_PATHS = [
    '/runtime/team-config.json',
    path.join(process.cwd(), 'team-config.json')
].filter(Boolean);

function getConfigPath() {
    if (process.env.TEAM_CONFIG_PATH) return process.env.TEAM_CONFIG_PATH;
    return TEAM_CONFIG_PATHS.find(filePath => {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        } catch (err) {
            return false;
        }
    }) || null;
}

let runningSnapshot = null;

/** Validate a candidate in full before publishing its runtime revision.
 * @returns {object} The complete validated team configuration.
 * @throws {Error} The selected file cannot be read or validated.
 */
function reloadTeamConfig() {
    const configPath = getConfigPath();
    if (!configPath) throw new Error('A complete v4 team configuration is required; set TEAM_CONFIG_PATH');

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const config = assertValidTeamConfig(raw, { env: process.env });
        if (config.serviceCatalog) require('../../shared/service-catalog').loadServiceCatalog(config, { teamDirectory: path.dirname(configPath) });
        config.identityMapping = config.identityMapping || {};
        config.identityMapping.businessIdOverrides = getEffectiveBusinessIdOverrides(config);
        buildEffectivePolicy(config, process.env);
        require('./fhir/store').authorityState.observeConfig(config);
        require('./system-flow-store').getSystemFlowStore(config);
        runningSnapshot = { path: configPath, config: structuredClone(config) };
        return config;
    } catch (err) {
        throw new Error(`Failed to load team config ${configPath}: ${err.message}`, { cause: err });
    }
}

/** Read the current candidate, retaining the validated snapshot on a failed live reload.
 * @returns {object} Validated configuration for this selected path.
 */
function loadTeamConfig() {
    try {
        return reloadTeamConfig();
    } catch (error) {
        if (!runningSnapshot || runningSnapshot.path !== getConfigPath()) throw error;
        console.warn(`[Config] Reload rejected; retaining revision ${runningSnapshot.config.runtime?.revision}: ${error.message}`);
        return structuredClone(runningSnapshot.config);
    }
}

function saveTeamConfig(config) {
    return require('../../shared/migration-maintenance').withConfigurationMutation(process.env.STATE_DIR || config.runtime?.stateDir,
        () => require('./workflow-source-configuration').withWorkflowSourceConfiguration(require('./fhir/store'), config, () => publishTeamConfig(config)));
}

/** Publish under the same private mutex used by retained-team checkpoint capture. */
function publishTeamConfig(config) {
    require('../../shared/migration-maintenance').assertAvailable(process.env.STATE_DIR || config.runtime?.stateDir);
    assertValidTeamConfig(config, { env: process.env });
    const configPath = getConfigPath() || process.env.TEAM_CONFIG_PATH;
    if (!configPath) {
        throw new Error('TEAM_CONFIG_PATH is not set and no config file exists');
    }
    require('../../shared/source-registration-history').validateSourceRegistrationHistory(config, JSON.parse(fs.readFileSync(configPath)));
    const tmpPath = `${configPath}.tmp`;
    if (config.serviceCatalog) require('../../shared/service-catalog').loadServiceCatalog(config, { teamDirectory: path.dirname(configPath) });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`);
    try {
        fs.renameSync(tmpPath, configPath);
    } catch (err) {
        if (!['EBUSY', 'EPERM', 'EXDEV'].includes(err.code)) throw err;
        // Docker bind-mounted files cannot always be atomically replaced.
        // Fall back to direct overwrite while preserving atomic writes for normal files.
        fs.writeFileSync(configPath, fs.readFileSync(tmpPath));
        fs.rmSync(tmpPath, { force: true });
    }
    require('./fhir/store').authorityState.observeConfig(config);
    require('./migration-checkpoint').recordConfig(process.env.STATE_DIR || config.runtime.stateDir, configPath);
}

function markRuntimeChange(config, reason) {
    const nextConfig = config || loadTeamConfig();
    nextConfig.runtime = nextConfig.runtime || {};
    nextConfig.runtime.revision = (Number(nextConfig.runtime.revision) || 0) + 1;
    if (reason === 'clinical-query-limits') nextConfig.runtime.queryLimitsRevisionOffset = (nextConfig.runtime.queryLimitsRevisionOffset || 0) + 1;
    nextConfig.runtime.updatedAt = new Date().toISOString();
    nextConfig.runtime.lastChangeReason = reason || 'config';
    return nextConfig;
}

function markCertificateChange(config) {
    const nextConfig = markRuntimeChange(config, 'certificates');
    nextConfig.runtime.certificateRevision = (Number(nextConfig.runtime.certificateRevision) || 0) + 1;
    return nextConfig;
}

function certPath(config, role, field = 'cert', purpose = 'assertion') {
    const certsDir = process.env.CERTS_DIR || config.runtime?.certsDir || CERTS_DIR;
    const roleConfig = config.certificateRoles?.[role]?.[purpose];
    const certName = roleConfig?.[field];
    if (!certName) throw new Error(`Missing certificate role ${role}.${purpose}.${field}`);
    return path.join(certsDir, certName);
}

function dataSourceClientCertPath(config, source, field = 'cert') {
    const certsDir = process.env.CERTS_DIR || config.runtime?.certsDir || CERTS_DIR;
    const fileName = source?.pcmClientAuth?.[field] || source?.[field];
    if (!fileName) return null;
    return path.join(certsDir, fileName);
}

function getPcmApiClientAuth(config = loadTeamConfig()) {
    return getEffectiveConformancePolicy(config).transport.pcmPublic.clientAuth;
}

function getAllowAnyTokenResource(config = loadTeamConfig()) {
    return getEffectiveConformancePolicy(config).debug.allowAnyTokenResource;
}

function getPcmAccessTokenExpiresInSeconds(config = loadTeamConfig()) {
    return getEffectiveConformancePolicy(config).token.accessTokenExpiresInSeconds;
}

function getDataSourceGatewayClientAuth(config = loadTeamConfig()) {
    return getEffectiveConformancePolicy(config).transport.dataSourceGateway.clientAuth;
}

function getDsGatewayToFhirServerProtocol(config = loadTeamConfig()) {
    return getEffectiveConformancePolicy(config).transport.dataSourceGatewayToFhir.protocol;
}

function getEffectiveConformancePolicy(config = loadTeamConfig()) {
    return buildEffectivePolicy(config, process.env);
}

module.exports = {
    loadTeamConfig,
    reloadTeamConfig,
    saveTeamConfig,
    // Low-level publication is used only inside the existing private config mutex.
    publishTeamConfig,
    markRuntimeChange,
    markCertificateChange,
    certPath,
    dataSourceClientCertPath,
    getConfigPath,
    getPcmApiClientAuth,
    getAllowAnyTokenResource,
    getPcmAccessTokenExpiresInSeconds,
    getDataSourceGatewayClientAuth,
    getDsGatewayToFhirServerProtocol,
    getEffectiveConformancePolicy
};
