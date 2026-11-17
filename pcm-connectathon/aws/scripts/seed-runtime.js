#!/usr/bin/env node
/**
 * Initialize an ECS task's shared /runtime volume.
 *
 * This is designed to run as a short-lived ECS container before the app
 * containers. It creates team-config.json only when missing, refreshes public
 * URLs when requested, and generates demo certs only when cert files are
 * incomplete.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sharedModuleRoot } = require('../../scripts/lib');
const { buildEffectivePolicy } = require(path.join(sharedModuleRoot(), 'conformance-policy'));

const runtimeDir = process.env.RUNTIME_DIR || '/runtime';
const teamId = process.env.TEAM_ID || 'team-a';
const configPath = process.env.TEAM_CONFIG_PATH || path.join(runtimeDir, 'team-config.json');
const certsDir = process.env.CERTS_DIR || path.join(runtimeDir, 'certs');
const exampleConfigPath = process.env.EXAMPLE_TEAM_CONFIG_PATH || '/workspace/pcm-connectathon/example-team-config.json';
const generateCertsScript = process.env.GENERATE_TEAM_CERTS_SCRIPT || '/workspace/pcm-connectathon/scripts/generate-team-certs.js';

const requiredCertFiles = [
    'rootCA.crt',
    'rootCA.key',
    'pcm-core.crt',
    'pcm-core.key',
    'sp-client.crt',
    'sp-client.key',
    'sp-client-assertion.crt',
    'sp-client-assertion.key',
    'hospital-b-sp.crt',
    'hospital-b-sp.key',
    'hospital-b-sp-assertion.crt',
    'hospital-b-sp-assertion.key',
    'ds-gateway.crt',
    'ds-gateway.key',
    'ds-gateway-assertion.crt',
    'ds-gateway-assertion.key',
    'ds-fhir-server.crt',
    'ds-fhir-server.key',
    'untrusted-client.crt',
    'untrusted-client.key'
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function boolEnv(name, fallback = false) {
    if (process.env[name] === undefined) return fallback;
    return process.env[name] === 'true';
}

function hostFromUrl(value) {
    try {
        return value ? new URL(value).hostname : '';
    } catch (err) {
        return '';
    }
}

function publicUrlsFromEnv(existing = {}) {
    return {
        ...existing,
        spClient: process.env.PUBLIC_SP_CLIENT_URL || existing.spClient,
        pcmUi: process.env.PUBLIC_PCM_UI_URL || existing.pcmUi,
        pcmApi: process.env.PUBLIC_PCM_API_URL || existing.pcmApi,
        pcmMetadata: process.env.PUBLIC_PCM_METADATA_URL || existing.pcmMetadata,
        referenceDataSource: process.env.PUBLIC_REFERENCE_DS_URL || existing.referenceDataSource,
        dataSourceMetadata: process.env.PUBLIC_DS_METADATA_URL || existing.dataSourceMetadata
    };
}

function applyAwsRuntimeUrls(config) {
    const publicUrls = publicUrlsFromEnv(config.publicBaseUrls || {});
    config.publicBaseUrls = publicUrls;

    config.internalBaseUrls = {
        ...(config.internalBaseUrls || {}),
        pcmAuth: 'https://localhost:3000/api/fhir-service/r4',
        pcmFhir: 'https://localhost:3000/api/fhir-service/r4',
        referenceDataSource: 'https://localhost:8080/fhir',
        dsAuthAdapter: 'http://127.0.0.1:3003',
        dsFhirServer: 'http://127.0.0.1:3004'
    };

    config.organizations = config.organizations || {};
    config.organizations.referenceDataSource = {
        ...(config.organizations.referenceDataSource || {}),
        endpoint: publicUrls.referenceDataSource || config.organizations.referenceDataSource?.endpoint || 'https://localhost:8080/fhir'
    };

    return config;
}

function buildInitialConfig() {
    const config = readJson(exampleConfigPath);
    config.teamId = teamId;
    config.conformance = {
        ...(config.conformance || {}),
        mode: process.env.PCM_CONFORMANCE_MODE || config.conformance?.mode || 'connectathon'
    };
    // Fresh Strict installs must not inherit the example's compatibility settings.
    if (config.conformance.mode === 'strict') {
        config.conformance.preset = 'strict';
        config.conformance.compatibilityAdapters = [];
        config.legacyDataSource.enabled = false;
    }
    config.security = config.security || {};
    config.security.pcmApi = {
        ...(config.security.pcmApi || {}),
        clientAuth: process.env.PCM_API_CLIENT_AUTH_MODE || config.security?.pcmApi?.clientAuth || 'mtls',
        allowAnyTokenResource: boolEnv('PCM_ALLOW_ANY_TOKEN_RESOURCE', config.security?.pcmApi?.allowAnyTokenResource === true),
        accessTokenExpiresInSeconds: Number.isSafeInteger(Number(process.env.PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS))
            ? Number(process.env.PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS)
            : (Number.isSafeInteger(Number(config.security?.pcmApi?.accessTokenExpiresInSeconds))
                ? Number(config.security.pcmApi.accessTokenExpiresInSeconds)
                : 30)
    };
    config.security.dataSourceGateway = {
        ...(config.security.dataSourceGateway || {}),
        clientAuth: process.env.DS_GATEWAY_CLIENT_AUTH_MODE || config.security?.dataSourceGateway?.clientAuth || 'mtls'
    };
    config.security.serviceProviderToDataSource = {
        ...(config.security.serviceProviderToDataSource || {}),
        verifyServerCertificate: boolEnv('SP_DS_VERIFY_SERVER_CERTIFICATE', config.security?.serviceProviderToDataSource?.verifyServerCertificate === true)
    };
    config.security.dsGatewayToFhirServer = {
        ...(config.security.dsGatewayToFhirServer || {}),
        protocol: process.env.DS_FHIR_UPSTREAM_PROTOCOL || config.security?.dsGatewayToFhirServer?.protocol || 'http',
        verifyServerCertificate: boolEnv('DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE', config.security?.dsGatewayToFhirServer?.verifyServerCertificate === true),
        customUrl: process.env.DS_FHIR_UPSTREAM_CUSTOM_URL || config.security?.dsGatewayToFhirServer?.customUrl || ''
    };
    config.runtime = {
        ...(config.runtime || {}),
        certsDir,
        logsDir: path.join(runtimeDir, 'logs'),
        stateDir: path.join(runtimeDir, 'state')
    };
    const ready = applyAwsRuntimeUrls(config);
    buildEffectivePolicy(ready, process.env);
    return ready;
}

function ensureRuntimeDirs() {
    for (const dir of [
        certsDir,
        path.join(runtimeDir, 'state'),
        path.join(runtimeDir, 'logs', 'pcm-core'),
        path.join(runtimeDir, 'logs', 'sp-client'),
        path.join(runtimeDir, 'logs', 'ds-auth-adapter'),
        path.join(runtimeDir, 'logs', 'ds-fhir-server'),
        path.join(runtimeDir, 'logs', 'ds-gateway'),
        path.join(runtimeDir, 'shared-logs')
    ]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function ensureConfig() {
    if (!fs.existsSync(configPath)) {
        writeJson(configPath, buildInitialConfig());
        console.log(`[Seed] Created ${configPath}`);
        return;
    }

    if (process.env.SEED_UPDATE_PUBLIC_URLS === 'false') {
        buildEffectivePolicy(readJson(configPath), process.env);
        console.log(`[Seed] Preserved existing ${configPath}`);
        return;
    }

    const config = applyAwsRuntimeUrls(readJson(configPath));
    buildEffectivePolicy(config, process.env);
    writeJson(configPath, config);
    console.log(`[Seed] Refreshed AWS runtime URLs in ${configPath}`);
}

function hasAllCerts() {
    return requiredCertFiles.every(fileName => fs.existsSync(path.join(certsDir, fileName)));
}

function ensureCerts() {
    if (hasAllCerts()) {
        console.log(`[Seed] Certificate directory already initialized at ${certsDir}`);
        return;
    }

    const publicDsUrl = process.env.PUBLIC_REFERENCE_DS_URL || '';
    const result = spawnSync(process.execPath, [
        generateCertsScript,
        '--team-id',
        teamId,
        '--out',
        certsDir,
        '--pcm-api-host',
        process.env.PUBLIC_PCM_API_HOST || hostFromUrl(process.env.PUBLIC_PCM_API_URL) || 'pcm-core',
        '--sp-host',
        process.env.PUBLIC_SP_CLIENT_HOST || hostFromUrl(process.env.PUBLIC_SP_CLIENT_URL) || 'sp-client',
        '--ds-host',
        process.env.PUBLIC_REFERENCE_DS_HOST || hostFromUrl(publicDsUrl) || 'ds-gateway',
        '--ds-fhir-host',
        'ds-fhir-server'
    ], { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`certificate generation failed with status ${result.status}`);
    }
}

ensureRuntimeDirs();
ensureConfig();
ensureCerts();
console.log('[Seed] Runtime initialization complete');
