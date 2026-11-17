#!/usr/bin/env node
'use strict';

/** Recreate a local team's listeners for a preset, preserving data and identity. */
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, repoRoot, requireSafeTeamId, readValidatedTeamConfig, run, DEFAULT_TEAMS_ROOT } = require('./lib');
const { composeBase, composeUpArgs, readinessEnvironment } = require('./lifecycle');
const { PRESETS, presetSimulationDefaults, presetSourceDefaults, buildEffectivePolicy } = require('../../src/shared/conformance-policy');
const { planReadinessState } = require('./readiness-state');
const { prepareHapiLogMounts } = require('./hapi-log-preflight');
const { parseOutboundUrl } = require('../../src/shared/outbound-destination');
const { assertValidTeamConfig } = require('../../src/shared/team-config-validator');

/** Build a validated replacement without touching files, certificates or runtime state. */
function planReconfiguration(current, environment, preset, { acknowledgeLegacyUpstream = false } = {}) {
    assertValidTeamConfig(current, { env: {} });
    if (!PRESETS.includes(preset)) throw new Error(`--preset must be one of ${PRESETS.join(', ')}`);
    const config = structuredClone(current);
    const customUrl = config.security.dsGatewayToFhirServer.customUrl;
    if (customUrl) parseOutboundUrl(customUrl);
    if (customUrl && config.security.dsGatewayToFhirServer.customUrlScope !== 'legacy-ds' && !acknowledgeLegacyUpstream) {
        throw new Error('Existing custom upstream previously affected every gateway. It will now affect legacy-ds only; managed HOs retain their own HAPI targets. Review this change and pass --acknowledge-legacy-upstream to preserve the URL with that scope.');
    }
    if (customUrl) config.security.dsGatewayToFhirServer.customUrlScope = 'legacy-ds';
    const strict = preset === 'strict';
    const full = strict || preset === 'connectathon-mtls';
    config.conformance = { ...config.conformance, preset, mode: strict ? 'strict' : 'connectathon', compatibilityAdapters: strict ? [] : config.conformance.compatibilityAdapters };
    config.sandbox = {};
    config.securitySimulation = { global: presetSimulationDefaults(preset), perSource: presetSourceDefaults(preset), awsCredentialIsolation: true };
    config.legacyDataSource.enabled = !strict;
    config.security.pcmApi = { ...config.security.pcmApi, clientAuth: full ? 'mtls' : 'tls', accessTokenExpiresInSeconds: current.security.pcmApi.accessTokenExpiresInSeconds, allowAnyTokenResource: false };
    // Entering Strict drops an explicit compatibility exception; leaving restores its default.
    if (strict) delete config.security.pcmApi.allowServiceProviderOwnTokenIntrospection;
    config.security.dataSourceGateway.clientAuth = full ? 'mtls' : 'tls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = config.securitySimulation.global.serverCertificateVerification;
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = config.securitySimulation.global.serverCertificateVerification;
    config.security.dsFhirServer.enforceMappedPatients = true;
    config.runtime = { ...config.runtime, revision: (config.runtime.revision || 0) + 1 };
    assertValidTeamConfig(config, { env: {} });
    buildEffectivePolicy(config, {});
    // Compose accepts quoted dotenv values; quoted empty passwords are still empty.
    const readEnv = name => {
        const raw = environment.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() || '';
        if (raw.startsWith('\"') || raw.startsWith("'")) return raw.slice(1, raw.indexOf(raw[0], 1));
        return raw.startsWith('#') ? '' : raw.replace(/\s+#.*$/, '').trim();
    };
    if (strict && !readEnv('TEAM_ADMIN_PASSWORD')) throw new Error('Set TEAM_ADMIN_PASSWORD in the existing team .env before selecting strict; no files were changed.');
    const values = {
        PCM_CONFORMANCE_MODE: config.conformance.mode,
        PCM_API_CLIENT_AUTH_MODE: config.security.pcmApi.clientAuth,
        PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS: config.security.pcmApi.accessTokenExpiresInSeconds,
        PCM_ALLOW_ANY_TOKEN_RESOURCE: false,
        DS_GATEWAY_CLIENT_AUTH_MODE: config.security.dataSourceGateway.clientAuth,
        SP_DS_VERIFY_SERVER_CERTIFICATE: config.security.serviceProviderToDataSource.verifyServerCertificate,
        DS_FHIR_UPSTREAM_PROTOCOL: 'https',
        DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE: config.security.dsGatewayToFhirServer.verifyServerCertificate,
        DS_FHIR_UPSTREAM_CUSTOM_URL: customUrl || '',
        FHIR_SERVER_TLS: true
    };
    let envText = environment;
    for (const [name, value] of Object.entries(values)) {
        const expression = new RegExp(`^${name}=.*$`, 'm');
        const line = `${name}=${value}`;
        envText = expression.test(envText) ? envText.replace(expression, () => line) : `${envText.trimEnd()}\n${line}\n`;
    }
    return { config, environment: envText, legacyUpstream: customUrl ? { previousTargets: 'all gateways', targets: ['legacy-ds'], url: customUrl } : null };
}

/** Stop the selected project, publish both files offline, then recreate its listeners. */
function applyReconfiguration({ teamId, configPath, envPath, plan, execute = run, root = repoRoot(), waitTimeout, publishCredentials, restoreCredentials }) {
    const previousConfig = fs.readFileSync(configPath);
    const previousEnv = fs.readFileSync(envPath);
    const readiness = planReadinessState(previousEnv.toString('utf8'), waitTimeout);
    const seconds = readiness.waitTimeout;
    const envNumber = name => Number(previousEnv.toString('utf8').match(new RegExp(`^${name}=(\\d+)$`, 'm'))?.[1] || 1000);
    prepareHapiLogMounts(path.dirname(configPath), plan.config.healthOrganizations, envNumber('LOCAL_UID'), envNumber('LOCAL_GID'));
    const options = { cwd: root, env: { ...readinessEnvironment(process.env, seconds), COMPOSE_PROJECT_NAME: teamId } };
    // down without --volumes preserves all clinical databases. Nothing is regenerated.
    execute('docker', [...composeBase(envPath), 'down', '--remove-orphans'], options);
    try {
        publishCredentials?.();
        fs.writeFileSync(configPath, `${JSON.stringify(plan.config, null, 2)}\n`);
        const healthLine = `PCM_HAPI_HEALTH_START_PERIOD=${options.env.PCM_HAPI_HEALTH_START_PERIOD}`;
        const nextEnvironment = /^PCM_HAPI_HEALTH_START_PERIOD=.*$/m.test(plan.environment)
            ? plan.environment.replace(/^PCM_HAPI_HEALTH_START_PERIOD=.*$/m, healthLine)
            : `${plan.environment.trimEnd()}\n${healthLine}\n`;
        fs.writeFileSync(envPath, nextEnvironment);
        execute('docker', composeUpArgs(envPath, { config: plan.config, noBuild: true, waitTimeout: seconds }), options);
    } catch (error) {
        // Stop partially started listeners before restoring a coherent previous pair.
        try {
            execute('docker', [...composeBase(envPath), 'down', '--remove-orphans'], options);
        } catch (cleanupError) {
            throw new Error(`Recreation failed: ${error.message}. Stopping partial listeners also failed: ${cleanupError.message}. Runtime state is uncertain; the new config/environment pair is retained. Stop this team's Compose project successfully before restoring or retrying.`, { cause: error });
        }
        try { restoreCredentials?.(); }
        catch (credentialError) {
            throw new Error(`Credential restoration failed; runtime is stopped but state is uncertain. Retain the private backup and repair credentials before restoring configuration. ${credentialError.message}`, { cause: error });
        }
        fs.writeFileSync(configPath, previousConfig);
        fs.writeFileSync(envPath, previousEnv);
        throw new Error(`Recreation failed; previous config and environment restored, team stopped. Restart with start-local-team.js --team-id ${teamId} --teams-root ${path.dirname(path.dirname(configPath))} --no-build. ${error.message}`, { cause: error });
    }
}

/** CLI entry point; --print-plan validates without stopping or writing anything. */
function main(argv = process.argv) {
    const args = parseArgs(argv);
    requireSafeTeamId(args['team-id']);
    const teamDir = path.resolve(repoRoot(), args['teams-root'] || DEFAULT_TEAMS_ROOT, args['team-id']);
    const configPath = path.join(teamDir, 'team-config.json');
    const envPath = path.join(teamDir, '.env');
    const current = readValidatedTeamConfig(configPath, { checkFiles: true, certsDir: path.join(teamDir, 'certs') });
    const plan = planReconfiguration(current, fs.readFileSync(envPath, 'utf8'), args.preset, {
        acknowledgeLegacyUpstream: args['acknowledge-legacy-upstream'] === true
    });
    console.log(JSON.stringify({ teamId: current.teamId, from: current.conformance.preset, to: args.preset,
        preserved: ['volumes', 'certificates', 'team identity', 'import ledger'], legacyUpstream: plan.legacyUpstream }));
    if (!args['print-plan']) applyReconfiguration({ teamId: args['team-id'], configPath, envPath, plan, waitTimeout: args['wait-timeout'] });
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { planReconfiguration, applyReconfiguration, main };
