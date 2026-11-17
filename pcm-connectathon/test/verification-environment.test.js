'use strict';

/** The strict runtime must receive a coherent config/Compose pair in either environment. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { planVerificationEnvironment } = require('../scripts/verification-environment');
const { planReconfiguration } = require('../scripts/reconfigure-local-team');
const { buildEffectivePolicy } = require('../../src/shared/conformance-policy');

test('explicit strict test/production switches synchronize Compose and preserve identities and workflow settings', () => {
    const initial = structuredClone(require('../example-team-config.json'));
    const strict = planReconfiguration(initial, 'TEAM_ADMIN_PASSWORD=local-test\nOTHER=keep\n', 'strict');
    const original = JSON.stringify(strict.config);
    for (const [environment, seconds] of [['test', 86400], ['production', 30]]) {
        const plan = planVerificationEnvironment(strict.config, strict.environment, environment);
        assert.equal(plan.config.contract.environment, environment);
        assert.equal(plan.config.security.pcmApi.accessTokenExpiresInSeconds, seconds);
        assert.match(plan.environment, new RegExp(`^PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=${seconds}$`, 'm'));
        assert.match(plan.environment, /^OTHER=keep$/m);
        assert.equal((plan.environment.match(/^PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=/gm) || []).length, 1);
        assert.deepEqual(plan.config.organizations, strict.config.organizations);
        assert.deepEqual(plan.config.systemAuthorization, strict.config.systemAuthorization);
        assert.deepEqual(plan.config.healthOrganizations, strict.config.healthOrganizations);
        assert.doesNotThrow(() => buildEffectivePolicy(plan.config, { PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS: String(seconds) }));
        assert.throws(() => buildEffectivePolicy(plan.config, { PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS: String(seconds === 30 ? 86400 : 30) }), /match/);
    }
    assert.equal(JSON.stringify(strict.config), original);
});

test('missing Compose lifetime is added once and invalid environments fail before mutation', () => {
    const initial = structuredClone(require('../example-team-config.json'));
    const plan = planVerificationEnvironment(initial, 'UNRELATED=unchanged\n', 'test');
    assert.equal(plan.environment, 'UNRELATED=unchanged\nPCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=86400\n');
    assert.throws(() => planVerificationEnvironment(initial, 'UNRELATED=unchanged\n', 'other'), /environment/i);
    assert.equal(initial.contract.environment, 'test');
});


test('verification transition refreshes gateway addresses after Node recreation without changing database services', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pcm-environment-activation-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json');
    const envPath = path.join(directory, '.env');
    const initial = planReconfiguration(structuredClone(require('../example-team-config.json')), 'TEAM_ADMIN_PASSWORD=local-test\n', 'strict');
    fs.writeFileSync(configPath, JSON.stringify(initial.config));
    fs.writeFileSync(envPath, initial.environment);
    const plan = planVerificationEnvironment(initial.config, initial.environment, 'test');
    let stopped = false;
    let recreated = false;
    let adapterAddresses = { 'ho-a': 'old-a', 'ho-b': 'old-b' };
    let gatewayAddresses = { ...adapterAddresses };
    const calls = [];
    require('../scripts/verification-environment').applyVerificationEnvironment({ configPath, envPath, plan, compose: ['compose', '-p', 'owned-test'], execute(name, program, args) {
        calls.push(name);
        assert.equal(program, 'docker');
        assert.equal(args.some(value => /hapi|postgres/.test(value)), false);
        if (name === 'strict-test-stop') {
            assert.equal(JSON.parse(fs.readFileSync(configPath)).contract.environment, initial.config.contract.environment);
            stopped = true;
        } else if (name === 'strict-test-restart') {
            assert.ok(stopped);
            assert.equal(JSON.parse(fs.readFileSync(configPath)).contract.environment, 'test');
            assert.match(fs.readFileSync(envPath, 'utf8'), /^PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS=86400$/m);
            assert.ok(args.includes('--force-recreate'));
            adapterAddresses = { 'ho-a': 'old-b', 'ho-b': 'old-a' };
            assert.equal(gatewayAddresses['ho-a'], adapterAddresses['ho-b'], 'the stale address would reach the wrong HO');
            recreated = true;
        } else {
            assert.ok(recreated);
            assert.deepEqual(args.slice(-3), ['ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway']);
            gatewayAddresses = { ...adapterAddresses };
        }
    } });
    assert.deepEqual(gatewayAddresses, adapterAddresses);
    assert.deepEqual(calls, ['strict-test-stop', 'strict-test-restart', 'strict-test-gateway-restart']);
});

test('a failed offline stop leaves the prior config/environment pair byte-exact', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pcm-environment-stop-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(configPath, 'prior config bytes'); fs.writeFileSync(envPath, 'prior environment bytes');
    assert.throws(() => require('../scripts/verification-environment').applyVerificationEnvironment({ configPath, envPath, plan: {}, compose: [], execute() { throw new Error('stop failed'); } }), /stop failed/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'prior config bytes');
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'prior environment bytes');
});
