'use strict';

/** Prove offline mode conversion preserves identity/state and fails atomically. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTeamConfig } = require('../../test-support/team-config');
const { planReconfiguration, applyReconfiguration } = require('../scripts/reconfigure-local-team');

const environment = 'PCM_CONFORMANCE_MODE=connectathon\nTEAM_ADMIN_PASSWORD=local-test-only\nHO_A_DB_PASSWORD=unchanged\n';

test('strict recreation changes policy/environment and retains identity and inventory mapping', () => {
    const before = buildTeamConfig();
    const plan = planReconfiguration(before, environment, 'strict');
    assert.equal(before.conformance.mode, 'connectathon');
    assert.equal(plan.config.conformance.mode, 'strict');
    assert.equal(plan.config.legacyDataSource.enabled, false);
    assert.deepEqual(plan.config.healthOrganizations, before.healthOrganizations);
    assert.deepEqual(plan.config.certificates, before.certificates);
    assert.equal(plan.config.teamId, before.teamId);
    assert.match(plan.environment, /^PCM_CONFORMANCE_MODE=strict$/m);
    assert.match(plan.environment, /^HO_A_DB_PASSWORD=unchanged$/m);
    assert.equal(plan.config.runtime.certificateRevision, before.runtime.certificateRevision);
});

test('strict requires an existing Admin password and unknown presets fail before any mutation', () => {
    for (const value of ['', 'TEAM_ADMIN_PASSWORD=""', "TEAM_ADMIN_PASSWORD=''", 'TEAM_ADMIN_PASSWORD= # comment']) {
        assert.throws(() => planReconfiguration(buildTeamConfig(), value, 'strict'), /TEAM_ADMIN_PASSWORD/);
    }
    assert.throws(() => planReconfiguration(buildTeamConfig(), environment, 'unknown'), /--preset/);
});

test('existing custom URL scope changes only after explicit acknowledgement', () => {
    const before = buildTeamConfig({ security: { dsGatewayToFhirServer: { customUrl: 'https://example.org/fhir' } } });
    assert.throws(() => planReconfiguration(before, environment, 'connectathon-easy'), /previously affected every gateway/);
    const plan = planReconfiguration(before, environment, 'connectathon-easy', { acknowledgeLegacyUpstream: true });
    assert.equal(plan.config.security.dsGatewayToFhirServer.customUrl, 'https://example.org/fhir');
    assert.equal(plan.config.security.dsGatewayToFhirServer.customUrlScope, 'legacy-ds');
    assert.deepEqual(plan.legacyUpstream.targets, ['legacy-ds']);
});

test('failed recreation restores exact files and never removes volumes or certificates', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reconfigure-team-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json');
    const envPath = path.join(directory, '.env');
    const original = JSON.stringify(buildTeamConfig());
    fs.writeFileSync(configPath, original);
    fs.writeFileSync(envPath, environment);
    fs.writeFileSync(path.join(directory, 'import-owner.json'), 'retained owner');
    const calls = [];
    const execute = (command, args) => {
        calls.push(args);
        assert.equal(command, 'docker');
        assert.ok(!args.includes('--volumes'));
        if (args.includes('up')) throw new Error('listener failed');
    };
    assert.throws(() => applyReconfiguration({ teamId: 'test-team', configPath, envPath,
        plan: planReconfiguration(buildTeamConfig(), environment, 'strict'), execute }), /previous config and environment restored/);
    assert.equal(calls.length, 3);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(envPath, 'utf8'), environment);
    assert.equal(fs.readFileSync(path.join(directory, 'import-owner.json'), 'utf8'), 'retained owner');
});

test('gateway renderer scopes acknowledged custom upstream to legacy and rejects unacknowledged migration', t => {
    const { spawnSync } = require('node:child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-scope-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team.json');
    const template = path.join(directory, 'template');
    const output = path.join(directory, 'output');
    fs.writeFileSync(path.join(directory, 'nginx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(template, '${DS_FHIR_PROXY_PASS} ${DS_FHIR_PROXY_SSL_VERIFY}\n');
    const config = buildTeamConfig({ security: { dsGatewayToFhirServer: { customUrl: 'https://custom.invalid/fhir', customUrlScope: 'legacy-ds' } } });
    fs.writeFileSync(configPath, JSON.stringify(config));
    const render = ho => spawnSync('sh', [path.resolve(__dirname, '../../src/ds-gateway/runtime-reload.sh')], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
            TEAM_CONFIG_PATH: configPath, NGINX_TEMPLATE_PATH: template, NGINX_OUTPUT_PATH: output,
            DS_GATEWAY_LOG_DIR: path.join(directory, 'logs'), DS_GATEWAY_LOG_OWNER: '',
            HO_ID: ho, DS_FHIR_SERVER_HOST: `${ho}-hapi`, DS_FHIR_SERVER_PORT: '8080' }
    });
    for (const ho of ['ho-a', 'ho-b', 'ho-c', 'legacy-ds']) {
        const result = render(ho);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, 'utf8').trim(), `${ho === 'legacy-ds' ? 'https://custom.invalid/fhir' : `https://${ho}-hapi:8080/fhir`} off`);
    }
    delete config.security.dsGatewayToFhirServer.customUrlScope;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const blocked = render('ho-a');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /migration required/);
});

test('failed partial-listener cleanup retains the new pair and reports both failures', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reconfigure-stop-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig()));
    fs.writeFileSync(envPath, environment);
    const plan = planReconfiguration(buildTeamConfig(), environment, 'strict');
    let calls = 0;
    const execute = () => { if (++calls === 2) throw new Error('up failed'); if (calls === 3) throw new Error('down failed'); };
    assert.throws(() => applyReconfiguration({ teamId: 'test-team', configPath, envPath, plan, execute }),
        /Recreation failed: up failed.*also failed: down failed.*Runtime state is uncertain/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), plan.config);
    assert.equal(fs.readFileSync(envPath, 'utf8'), `${plan.environment.trimEnd()}\nPCM_HAPI_HEALTH_START_PERIOD=600s\n`);
});

test('recreation rejects protected custom destinations before mutation', () => {
    const config = buildTeamConfig({ security: { dsGatewayToFhirServer: { customUrl: 'http://169.254.169.254/latest/meta-data/' } } });
    assert.throws(() => planReconfiguration(config, environment, 'connectathon-easy', { acknowledgeLegacyUpstream: true }), /AWS|metadata|blocked|credential/i);
});

test('entering Strict removes own-token compatibility override and leaving restores preset default', () => {
    const before = buildTeamConfig({ security: { pcmApi: { allowServiceProviderOwnTokenIntrospection: true } } });
    const strict = planReconfiguration(before, environment, 'strict');
    assert.equal(Object.hasOwn(strict.config.security.pcmApi, 'allowServiceProviderOwnTokenIntrospection'), false);
    const capability = require('../../src/shared/conformance-policy').serviceProviderOwnTokenIntrospection;
    assert.equal(capability(strict.config).enabled, false);
    assert.equal(capability(planReconfiguration(strict.config, strict.environment, 'connectathon-balanced').config).enabled, true);
    assert.equal(before.security.pcmApi.allowServiceProviderOwnTokenIntrospection, true);
});
