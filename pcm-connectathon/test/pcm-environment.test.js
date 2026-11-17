'use strict';

/** PCM-IG-040 environment/config migration is independent of the security preset. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { buildTeamConfig } = require('../../test-support/team-config');
const { buildEffectivePolicy, PRESETS } = require('../../src/shared/conformance-policy');
const { assertValidTeamConfig, validateTeamConfig } = require('../../src/shared/team-config-validator');
const { ENVIRONMENTS, PCM_PATH, environmentEndpoints, pcmTransportUrl } = require('../../src/shared/pcm-environment');
const { migrate } = require('../scripts/migrate-team-config');
const previous = require('../fixtures/team-config-v3.json');

for (const environment of ['production', 'test']) {
    for (const preset of PRESETS) {
        test(`${environment}/${preset} has its own token maximum with unchanged security controls`, () => {
            const config = buildTeamConfig({ contract: { environment } }, preset);
            assertValidTeamConfig(config, { env: {} });
            const policy = buildEffectivePolicy(config, {});
            assert.equal(policy.token.accessTokenExpiresInSeconds, ENVIRONMENTS[environment].tokenMaximumSeconds);
            assert.equal(policy.simulation.controls.oauthBearer, true);
            if (preset === 'strict') assert.ok(Object.values(policy.simulation.controls).every(Boolean));
            config.security.pcmApi.accessTokenExpiresInSeconds = 1;
            assertValidTeamConfig(config, { env: {} });
            for (const invalid of [0, -1, 1.5, ENVIRONMENTS[environment].tokenMaximumSeconds + 1]) {
                config.security.pcmApi.accessTokenExpiresInSeconds = invalid;
                assert.throws(() => assertValidTeamConfig(config, { env: {} }), /accessTokenExpiresInSeconds/);
            }
        });
    }
}

test('logical URI aliases and mixed environments fail; transport mapping changes only the exact origin', () => {
    const config = buildTeamConfig();
    const logical = environmentEndpoints('test');
    assert.equal(pcmTransportUrl(logical.tokenEndpoint, config), `${config.internalBaseUrls.pcmAuth}/token`);
    assert.equal(pcmTransportUrl(logical.authorizationEndpoint, config, { browser: true }), `${config.publicBaseUrls.pcmApi}/authorize`);
    for (const alias of [`${logical.oauthBase}/`, logical.oauthBase.replace('https:', 'http:'),
        environmentEndpoints('production').oauthBase, logical.oauthBase.replace('/api/', '/API/'), `${logical.oauthBase}?q=1`]) {
        const changed = structuredClone(config);
        changed.contract.operational.oauthBase = alias;
        assert.equal(validateTeamConfig(changed, { env: {} }).valid, false, alias);
        assert.throws(() => pcmTransportUrl(`${alias}/token`, config), /Unrecognized/);
    }
    const changed = structuredClone(config);
    changed.publicBaseUrls.pcmApi += '/';
    assert.equal(validateTeamConfig(changed, { env: {} }).valid, false);
});

test('older configuration requires explicit coordinated checkpoint review without inferring membership or authority', () => {
    const original = structuredClone(previous);
    for (const environment of ['production', 'test']) assert.throws(() => migrate(original, { environment }), /Coordinated scope migration/);
    assert.deepEqual(original, previous);
    const current = buildTeamConfig(); assert.deepEqual(migrate(current), current);
});

test('general CLI refuses old config even with write and produces no backup or partial migration', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-scope-required-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'team-config.json'), original = JSON.stringify(previous);
    fs.writeFileSync(target, original);
    for (const extra of [[], ['--write']]) {
        const result = spawnSync(process.execPath, ['pcm-connectathon/scripts/migrate-team-config.js', '--config', target, ...extra], { encoding: 'utf8' });
        assert.notEqual(result.status, 0); assert.match(result.stderr, /Coordinated scope migration/);
        assert.equal(fs.readFileSync(target, 'utf8'), original); assert.deepEqual(fs.readdirSync(directory), ['team-config.json']);
    }
});

test('workflow configuration rejects participant privilege escalation and ambiguous home HMO membership', () => {
    const config = buildTeamConfig();
    config.systemAuthorization.clientEntitlements[config.organizations.serviceProvider.clientId] = ['dependent-discovery'];
    assert.equal(validateTeamConfig(config, { env: {} }).valid, false);
    delete config.systemAuthorization.clientEntitlements[config.organizations.serviceProvider.clientId];
    config.systemAuthorization.participatingHmos = ['ho-a'];
    const membership = { identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }, homeHmoId: 'ho-a' };
    config.systemAuthorization.memberships = [membership];
    assertValidTeamConfig(config, { env: {} });
    config.systemAuthorization.memberships.push(structuredClone(membership));
    assert.equal(validateTeamConfig(config, { env: {} }).valid, false);
    config.systemAuthorization.memberships = [{ ...membership, homeHmoId: 'legacy-ds' }];
    assert.equal(validateTeamConfig(config, { env: {} }).valid, true, 'Dormant ordinary facts do not select a home HMO or grant authority');
    config.systemAuthorization.memberships[0].localSso = { birthDate: '1980-01-02' };
    assert.equal(validateTeamConfig(config, { env: {} }).valid, false, 'An explicit SSO simulation must select a registered classified HMO');
    config.systemAuthorization.memberships = [{ ...membership, identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' } }];
    assert.equal(validateTeamConfig(config, { env: {} }).valid, false);
});

test('explicit current config remains independent of security ledgers; older config requires coordinated migration', () => {
    const current = buildTeamConfig();
    assert.deepEqual(migrate(current), current);
    assert.throws(() => migrate({ ...current, configVersion: 'pcm-team-config/4' }), /Coordinated scope migration/);
});
