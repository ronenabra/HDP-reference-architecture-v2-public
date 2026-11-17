'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    buildReferenceHealthOrganizations,
    requireHealthOrganization,
    validateHealthOrganizations
} = require('../../src/shared/health-organizations');
const { resetDatabaseStatements } = require('../scripts/reset-health-organization');

const root = path.resolve(__dirname, '..', '..');
const example = () => JSON.parse(fs.readFileSync(path.join(root, 'pcm-connectathon/example-team-config.json'), 'utf8'));

test('reference topology is exactly three deterministic, pairwise-isolated HOs', () => {
    const first = buildReferenceHealthOrganizations('team-qa', 8280);
    const second = buildReferenceHealthOrganizations('team-qa', 8280);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map(ho => ho.id), ['ho-a', 'ho-b', 'ho-c']);
    assert.deepEqual(first.map(ho => ho.gatewayPort), [8280, 8281, 8282]);
    assert.equal(validateHealthOrganizations({ healthOrganizations: first }).length, 0);
    for (const field of ['endpoint', 'clientId', 'adapterIssuer', 'adapterAudience']) {
        assert.equal(new Set(first.map(ho => ho[field])).size, 3, field);
    }
    assert.equal(new Set(first.map(ho => ho.clinicalData.serverId)).size, 3);
    assert.ok(first.every(ho => ho.clinicalData.bootstrap.policy === 'disabled'));
    assert.ok(first.every(ho => !Object.hasOwn(ho, 'fixtureSet')));
    assert.equal(new Set(first.map(ho => ho.database.name)).size, 3);
    assert.equal(new Set(first.map(ho => ho.database.user)).size, 3);
    assert.equal(new Set(first.flatMap(ho => Object.values(ho.certificates))).size, 24);
});

test('HO reset keeps PostgreSQL database lifecycle commands transaction-safe and rerunnable', () => {
    assert.deepEqual(resetDatabaseStatements('pcm_team_ho_a', 'pcm_team_a'), [
        'DROP DATABASE IF EXISTS pcm_team_ho_a WITH (FORCE);',
        'CREATE DATABASE pcm_team_ho_a OWNER pcm_team_a;',
        'REVOKE CONNECT ON DATABASE pcm_team_ho_a FROM PUBLIC; GRANT CONNECT ON DATABASE pcm_team_ho_a TO pcm_team_a;'
    ]);
});

test('missing, not-three, duplicate, and cross-binding configurations fail closed', () => {
    assert.match(validateHealthOrganizations({})[0], /exactly/);
    const mutations = [
        list => list.pop(),
        list => { list[2].id = 'ho-b'; },
        list => { list[2].endpoint = list[0].endpoint; },
        list => { list[2].gatewayPort = list[0].gatewayPort; },
        list => { list[2].database.name = list[0].database.name; },
        list => { list[2].database.user = list[0].database.user; },
        list => { list[2].database.passwordEnv = list[0].database.passwordEnv; },
        list => { list[2].import.stateNamespace = '../unsafe'; },
        list => { list[2].adapterAudience = list[0].adapterAudience; },
        list => { list[2].certificates.hapiServerCert = list[0].certificates.hapiServerCert; },
        list => { list[2].dataSourceOrganization.id = list[0].parentOrganization.id; },
        list => { list[2].dataSourceOrganization.businessIdentifier.value = list[0].parentOrganization.businessIdentifier.value; }
    ];
    for (const mutate of mutations) {
        const config = example();
        mutate(config.healthOrganizations);
        assert.ok(validateHealthOrganizations(config).length > 0);
    }
    assert.throws(() => requireHealthOrganization(example(), 'ho-x'), /unknown/);
});

test('strict and connectathon local generation preserve the same three-HO topology', () => {
    for (const mode of ['strict', 'connectathon']) {
        const teamsRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pcm-${mode}-`));
        const result = require('node:child_process').spawnSync('node', [
            'pcm-connectathon/scripts/create-team.js', '--team-id', `team-${mode}`,
            '--teams-root', teamsRoot, '--mode', mode, '--ds-port', '8380'
        ], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const generated = JSON.parse(fs.readFileSync(path.join(teamsRoot, `team-${mode}`, 'team-config.json'), 'utf8'));
        assert.deepEqual(generated.healthOrganizations.map(ho => ho.id), ['ho-a', 'ho-b', 'ho-c']);
        assert.deepEqual(generated.healthOrganizations.map(ho => ho.gatewayPort), [8380, 8381, 8382]);
        assert.equal(generated.conformance.mode, mode);
        assert.equal(validateHealthOrganizations(generated).length, 0);
        const envFile = path.join(teamsRoot, `team-${mode}`, '.env');
        const composeResult = require('node:child_process').spawnSync('docker', [
            'compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml',
            '--env-file', envFile, 'config', '--format', 'json'
        ], { cwd: root, encoding: 'utf8' });
        assert.equal(composeResult.status, 0, composeResult.stderr || composeResult.stdout);
        const compose = JSON.parse(composeResult.stdout);
        assert.equal(compose.services['ho-a-hapi'].environment.HO_FHIR_TLS_ENABLED, 'true');
        assert.equal(compose.services['ho-a-gateway'].environment.DS_FHIR_UPSTREAM_PROTOCOL, 'https');
        assert.equal(compose.services['ho-a-gateway'].environment.DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE, mode === 'strict' ? 'true' : 'false');
    }
});

test('Compose topology publishes only three gateway ports and keeps import private', () => {
    const result = require('node:child_process').spawnSync('docker', [
        'compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--profile', 'import', '--profile', 'maintenance', 'config', '--format', 'json'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const compose = JSON.parse(result.stdout);
    const publicServices = Object.entries(compose.services).filter(([name, service]) => name.startsWith('ho-') && Array.isArray(service.ports) && service.ports.length).map(([name]) => name).sort();
    assert.deepEqual(publicServices, ['ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway']);
    for (const name of ['ho-a-hapi', 'ho-b-hapi', 'ho-c-hapi', 'ho-a-adapter', 'ho-b-adapter', 'ho-c-adapter', 'ho-postgres', 'clinical-loader', 'clinical-import-hapi', 'ho-reset-helper']) {
        assert.equal(compose.services[name].ports, undefined, name);
    }
    for (const name of ['ho-a-hapi', 'ho-b-hapi', 'ho-c-hapi']) {
        assert.equal(typeof compose.services[name].environment.PCM_IMPORT_CREDENTIAL, 'string', name);
    }
    assert.equal(compose.services['clinical-import-hapi'].environment.PCM_IMPORT_CREDENTIAL, '');
    assert.equal(compose.networks['pcm-ho-private'].internal, true);

    const integration = require('node:child_process').spawnSync('docker', [
        'compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml',
        '-f', 'clinical-data/test/compose.integration.yaml', '--env-file', 'pcm-connectathon/example.env',
        'config', '--format', 'json'
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(integration.status, 0, integration.stderr || integration.stdout);
    const integrationCompose = JSON.parse(integration.stdout);
    assert.equal(integrationCompose.services['ho-a-hapi'].environment.PCM_IMPORT_CREDENTIAL, 'local-only-team-a-ho-a-import-0001');
});

test('HO-C defaults to an 8 GiB heap and explicit overrides remain target-specific', () => {
    const { spawnSync } = require('node:child_process');
    for (const target of ['', 'A', 'B', 'C']) {
        const env = { ...process.env };
        for (const key of ['A', 'B', 'C']) delete env[`PCM_${key}_HAPI_JAVA_TOOL_OPTIONS`];
        if (target) env[`PCM_${target}_HAPI_JAVA_TOOL_OPTIONS`] = '-Xmx6g';
        const result = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f',
            'pcm-connectathon/compose.ho.yaml', 'config', '--format', 'json'],
        { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const compose = JSON.parse(result.stdout);
        for (const key of ['A', 'B', 'C']) {
            const id = `ho-${key.toLowerCase()}`;
            assert.equal(compose.services[`${id}-hapi`].environment.JAVA_TOOL_OPTIONS,
                key === target ? '-Xmx6g' : (key === 'C' ? '-Xmx8g' : ''));
            assert.equal(compose.services[`${id}-adapter`].environment.JAVA_TOOL_OPTIONS, undefined);
        }
    }
});

/** Empty HO-C options select the reference default instead of an undersized ergonomic heap. */
test('an empty HO-C heap override still uses the 8 GiB default', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f',
        'pcm-connectathon/compose.ho.yaml', 'config', '--format', 'json'],
    { cwd: root, env: { ...process.env, PCM_C_HAPI_JAVA_TOOL_OPTIONS: '' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).services['ho-c-hapi'].environment.JAVA_TOOL_OPTIONS, '-Xmx8g');
});

test('Admin and CLI receive the same explicit clinical deadlines and preserve defaults', () => {
    const { spawnSync } = require('node:child_process');
    const defaults = { CLINICAL_DATA_CONNECT_UPLOAD_TIMEOUT_MS: '120000',
        CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '3600000', CLINICAL_DATA_VERIFICATION_TIMEOUT_MS: '300000' };
    const overrides = { CLINICAL_DATA_CONNECT_UPLOAD_TIMEOUT_MS: '60000',
        CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '1800000', CLINICAL_DATA_VERIFICATION_TIMEOUT_MS: '1800000' };
    for (const selected of [defaults, overrides]) {
        const env = { ...process.env };
        for (const name of Object.keys(defaults)) delete env[name];
        if (selected === overrides) Object.assign(env, overrides);
        const result = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f',
            'pcm-connectathon/compose.ho.yaml', '--profile', 'import', '--profile', 'legacy-diagnostic',
            'config', '--format', 'json'],
        { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const compose = JSON.parse(result.stdout);
        for (const service of ['pcm-core', 'clinical-loader']) {
            for (const [name, value] of Object.entries(selected)) {
                assert.equal(compose.services[service].environment[name], value);
            }
        }
    }
});

/** Generated teams and portable examples must agree on large HMO import ceilings. */
test('reference teams and portable examples use shared large-bundle defaults', () => {
    const { DEFAULT_LIMITS } = require('../../src/shared/clinical-import-limits');
    assert.deepEqual(DEFAULT_LIMITS, { maxBytes: 805306368, maxEntries: 200000 });
    const targets = buildReferenceHealthOrganizations('large-bundle');
    for (const ho of [...targets, ...example().healthOrganizations]) assert.deepEqual(ho.clinicalData.limits, DEFAULT_LIMITS);
    const descriptor = JSON.parse(fs.readFileSync(path.join(root, 'pcm-connectathon/sut-descriptor.example.json'), 'utf8'));
    for (const ho of descriptor.healthOrganizations) assert.deepEqual(ho.clinicalData.limits, DEFAULT_LIMITS);
});
