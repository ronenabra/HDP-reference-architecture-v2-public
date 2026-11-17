'use strict';

/** Complete v4 fixtures for tests; production readers never merge partial input. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { POLICY_VERSION, presetSimulationDefaults, presetSourceDefaults } = require('../src/shared/conformance-policy');
const example = require('../pcm-connectathon/example-team-config.json');

/** Merge focused test overrides into a complete fixture without changing the example. */
function mergeFixture(base, overrides) {
    const result = structuredClone(base);
    for (const [key, value] of Object.entries(overrides)) {
        result[key] = value && typeof value === 'object' && !Array.isArray(value)
            && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
            ? mergeFixture(result[key], value) : structuredClone(value);
    }
    return result;
}

/** Build a complete example-derived configuration for one supported preset. */
function buildTeamConfig(overrides = {}, preset = overrides.conformance?.preset || (overrides.conformance?.mode === 'strict' ? 'strict' : 'connectathon-easy')) {
    const config = structuredClone(example);
    // Existing authority tests explicitly exercise ordinary grants; feature tests opt in.
    config.sandbox = {};
    if (overrides.contract?.environment && !overrides.contract.operational) {
        const logical = require('../src/shared/pcm-environment').environmentEndpoints(overrides.contract.environment);
        config.contract.operational = { oauthBase: logical.oauthBase, fhirBase: logical.fhirBase };
    }
    const strict = preset === 'strict';
    const mtls = strict || preset === 'connectathon-mtls';
    config.conformance = { mode: strict ? 'strict' : 'connectathon', preset,
        policyVersion: POLICY_VERSION, compatibilityAdapters: strict ? [] : config.conformance.compatibilityAdapters };
    config.security.pcmApi.clientAuth = mtls ? 'mtls' : 'tls';
    config.security.pcmApi.accessTokenExpiresInSeconds = require('../src/shared/pcm-environment').tokenMaximumSeconds({ contract: { ...config.contract, ...(overrides.contract || {}) } });
    config.security.dataSourceGateway.clientAuth = mtls ? 'mtls' : 'tls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = mtls;
    config.security.dsGatewayToFhirServer.verifyServerCertificate = mtls;
    config.security.dsFhirServer.enforceMappedPatients = true;
    config.securitySimulation.global = presetSimulationDefaults(preset);
    config.securitySimulation.perSource = presetSourceDefaults(preset);
    config.legacyDataSource.enabled = !strict;
    return mergeFixture(config, overrides);
}

/** Install one isolated runtime before importing route modules that read configuration. */
function installTestRuntime(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'pcm-test-runtime-'));
    const config = buildTeamConfig(overrides);
    const env = {
        TEAM_CONFIG_PATH: path.join(directory, 'team-config.json'),
        STATE_DIR: path.join(directory, 'state'),
        LOG_DIR: path.join(directory, 'logs'),
        SHARED_LOGS_DIR: path.join(directory, 'shared-logs'),
        CERTS_DIR: path.join(directory, 'certs')
    };
    config.runtime = { ...config.runtime, certsDir: env.CERTS_DIR, logsDir: env.SHARED_LOGS_DIR, stateDir: env.STATE_DIR };
    fs.mkdirSync(env.CERTS_DIR);
    fs.writeFileSync(env.TEAM_CONFIG_PATH, JSON.stringify(config));
    Object.assign(process.env, env);
    process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
    return config;
}

module.exports = { buildTeamConfig, installTestRuntime };
