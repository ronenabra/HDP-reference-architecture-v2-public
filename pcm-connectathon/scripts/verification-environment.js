'use strict';

/** Plan an explicit environment switch for an owned disposable verification team. */
const { environmentEndpoints, tokenMaximumSeconds } = require('../../src/shared/pcm-environment');
const { assertValidTeamConfig } = require('../../src/shared/team-config-validator');
const { buildEffectivePolicy } = require('../../src/shared/conformance-policy');
const fs = require('node:fs');

/** Preserve participant/state settings and synchronize the strict Compose lifetime. */
function planVerificationEnvironment(current, environmentText, environment) {
    const config = structuredClone(current);
    const endpoints = environmentEndpoints(environment);
    config.contract.environment = environment;
    config.contract.operational = { oauthBase: endpoints.oauthBase, fhirBase: endpoints.fhirBase };
    config.security.pcmApi.accessTokenExpiresInSeconds = tokenMaximumSeconds(config);
    const lifetime = config.security.pcmApi.accessTokenExpiresInSeconds;
    const line = `PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=${lifetime}`;
    const expression = /^PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=.*$/m;
    const nextEnvironment = expression.test(environmentText)
        ? environmentText.replace(expression, () => line) : `${environmentText.trimEnd()}\n${line}\n`;
    assertValidTeamConfig(config, { env: {} });
    buildEffectivePolicy(config, { PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS: String(lifetime) });
    return { config, environment: nextEnvironment };
}

/** Publish a coherent pair offline, then refresh nginx after backend IP recreation. */
function applyVerificationEnvironment({ configPath, envPath, plan, compose, execute }) {
    const nodes = ['pcm-core', 'sp-client', 'ho-a-adapter', 'ho-b-adapter', 'ho-c-adapter'];
    execute('strict-test-stop', 'docker', [...compose, 'stop', ...nodes]);
    fs.writeFileSync(configPath, `${JSON.stringify(plan.config, null, 2)}\n`);
    fs.writeFileSync(envPath, plan.environment);
    execute('strict-test-restart', 'docker', [...compose, 'up', '-d', '--force-recreate', '--no-deps', ...nodes]);
    // nginx resolves static upstream names at startup. Recycled container IPs
    // can otherwise send HO A's request to HO B's correctly denying adapter.
    execute('strict-test-gateway-restart', 'docker', [...compose, 'restart', 'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway']);
}

module.exports = { planVerificationEnvironment, applyVerificationEnvironment };
