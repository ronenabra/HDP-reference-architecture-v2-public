const { buildTeamConfig } = require('../../../test-support/team-config');
/**
 * Tests for pcm-connectathon team configuration loading.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

test('authorization ceiling rejects the legacy allow-any-resource debug bypass', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-team-config-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        security: {
            pcmApi: {
                clientAuth: 'mtls',
                allowAnyTokenResource: true,
                accessTokenExpiresInSeconds: -45
            }
        }
    })));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { getAllowAnyTokenResource, getPcmAccessTokenExpiresInSeconds } = require('../src/team-config');

    assert.throws(() => getAllowAnyTokenResource(), /violates the authorization ceiling/);
    assert.throws(() => getPcmAccessTokenExpiresInSeconds(), /violates the authorization ceiling/);
    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('retired expired-token flag is rejected by the current configuration contract', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-team-config-legacy-expiry-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        security: {
            pcmApi: {
                introspectionReturnsExpiredTokens: true
            }
        }
    })));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { getPcmAccessTokenExpiresInSeconds } = require('../src/team-config');

    assert.throws(() => getPcmAccessTokenExpiresInSeconds(), /introspectionReturnsExpiredTokens.*not allowed/);
    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('configured patients prepopulate identity mapping overrides', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-team-config-patients-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        patients: [
            {
                idSystem: 'http://fhir.health.gov.il/identifier/il-national-id',
                idValue: '000000018',
                display: 'Connectathon Patient'
            }
        ],
        identityMapping: {
            businessIdOverrides: {
                'http://fhir.health.gov.il/identifier/il-national-id|000000029': 'Patient/custom-29'
            }
        }
    })));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { loadTeamConfig } = require('../src/team-config');

    assert.deepEqual(loadTeamConfig().identityMapping.businessIdOverrides, {
        '000000018': 'Patient/local-000000018',
        'http://fhir.health.gov.il/identifier/il-national-id|000000029': 'Patient/custom-29'
    });
    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('versioned config normalization does not persist invalid empty SMART scope arrays', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-team-config-smart-scopes-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const examplePath = path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json');
    const config = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    fs.writeFileSync(configPath, JSON.stringify(config));

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { loadTeamConfig } = require('../src/team-config');
    const loaded = loadTeamConfig();

    assert.deepEqual(loaded.organizations.serviceProvider.smartScopes, ['patient/*.rs', 'patient/Observation.rs']);
    assert.equal(loaded.organizations.hospitalBServiceProvider.smartScopes, undefined);
    assert.equal(loaded.organizations.referenceDataSource.smartScopes, undefined);
    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    delete require.cache[require.resolve('../src/team-config')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('token expiration is applied during token minting instead of introspection', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'token-service.js'), 'utf8');

    assert.match(source, /getPcmAccessTokenExpiresInSeconds/);
    assert.match(source, /tokenStore\.issue\(kind, claims, lifetime\)/);
    assert.doesNotMatch(source, /introspectionReturnsExpiredTokens: true/);
});

test('validated config save supports bind-mounted files without relaxing validation', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-config-bind-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previous = process.env.TEAM_CONFIG_PATH;
    const rename = fs.renameSync;
    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/team-config')];
    const { saveTeamConfig } = require('../src/team-config');
    const config = structuredClone(require('../../../pcm-connectathon/example-team-config.json'));
    config.runtime.stateDir = path.join(tmp, 'state');
    try {
        fs.writeFileSync(configPath, JSON.stringify(config));
        for (const code of ['EBUSY', 'EPERM', 'EXDEV']) {
            fs.renameSync = () => { throw Object.assign(new Error('mounted file'), { code }); };
            config.runtime = { ...(config.runtime || {}), revision: (config.runtime?.revision || 0) + 1 };
            saveTeamConfig(config);
            assert.equal(JSON.parse(fs.readFileSync(configPath)).runtime.revision, config.runtime.revision);
            assert.equal(fs.existsSync(`${configPath}.tmp`), false);
        }
        const saved = fs.readFileSync(configPath, 'utf8');
        config.securitySimulation.global.history = true;
        assert.throws(() => saveTeamConfig(config), /together|invalid/);
        assert.equal(fs.readFileSync(configPath, 'utf8'), saved);
    } finally {
        fs.renameSync = rename;
        if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous;
        delete require.cache[require.resolve('../src/team-config')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('selected configuration errors never select a default or a different team', t => {
    const directory = fs.mkdtempSync(path.join(tmpRoot, 'pcm-invalid-config-'));
    const previous = { TEAM_CONFIG_PATH: process.env.TEAM_CONFIG_PATH, PCM_CONFORMANCE_MODE: process.env.PCM_CONFORMANCE_MODE };
    process.env.TEAM_CONFIG_PATH = path.join(directory, 'selected.json');
    delete process.env.PCM_CONFORMANCE_MODE;
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
        delete require.cache[require.resolve('../src/team-config')];
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const invalidStrict = { configVersion: 'pcm-team-config/3', teamId: 'review-target', conformance: { mode: 'strict' } };
    const invalidPolicy = structuredClone(require('../../../pcm-connectathon/example-team-config.json'));
    invalidPolicy.conformance.preset = 'not-a-preset';
    for (const content of [null, '{broken', JSON.stringify(invalidStrict), JSON.stringify(invalidPolicy)]) {
        if (content !== null) fs.writeFileSync(process.env.TEAM_CONFIG_PATH, content);
        delete require.cache[require.resolve('../src/team-config')];
        assert.throws(() => require('../src/team-config').loadTeamConfig(), /config|ENOENT|JSON/i);
    }
});

test('invalid live revision reports failure while preserving the complete running snapshot', t => {
    const directory = fs.mkdtempSync(path.join(tmpRoot, 'pcm-config-reload-'));
    const previous = process.env.TEAM_CONFIG_PATH;
    process.env.TEAM_CONFIG_PATH = path.join(directory, 'selected.json');
    delete require.cache[require.resolve('../src/team-config')];
    t.after(() => {
        if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous;
        delete require.cache[require.resolve('../src/team-config')];
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const config = structuredClone(require('../../../pcm-connectathon/example-team-config.json'));
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    const reader = require('../src/team-config');
    const before = reader.loadTeamConfig();
    const invalid = structuredClone(config);
    invalid.teamId = 'review-target';
    invalid.runtime.revision = 2;
    invalid.conformance.preset = 'invalid';
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(invalid));
    assert.throws(() => reader.reloadTeamConfig(), /config|preset/i);
    assert.deepEqual(reader.loadTeamConfig(), before);
    config.runtime.revision = 3;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    assert.equal(reader.reloadTeamConfig().runtime.revision, config.runtime.revision);
    assert.equal(reader.loadTeamConfig().runtime.revision, config.runtime.revision);
});
