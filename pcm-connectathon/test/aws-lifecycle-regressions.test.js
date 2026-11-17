'use strict';

/** Exercise AWS lifecycle regressions with disposable files and dry-run cloud calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTeamConfig } = require('../../test-support/team-config');
const { buildEffectivePolicy } = require('../../src/shared/conformance-policy');

const root = path.resolve(__dirname, '../..');

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm aws lifecycle '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('AWS delete/destroy --dry-run --delete-local preserves every local team file', t => {
    const directory = temporaryDirectory(t);
    for (const name of ['pcm-connectathon/aws/scripts/manage-team.js', 'pcm-connectathon/aws/scripts/deploy-lib.js', 'pcm-connectathon/scripts/lib.js']) {
        const destination = path.join(directory, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(root, name), destination);
    }
    fs.cpSync(path.join(root, 'src/shared'), path.join(directory, 'src/shared'), { recursive: true });
    const files = {
        'pcm-connectathon/aws/generated/backend-team.s3.hcl': 'bucket = "unused-test-bucket"\n',
        'pcm-connectathon/aws/terraform/team/dry-team.tfvars': 'team_id = "dry-team"\nregion = "il-central-1"\n',
        'pcm-connectathon/aws/generated/dry-team-aws-env.json': '{}\n',
        'teams/dry-team/team-config.json': '{}\n',
        'teams/dry-team/.env': 'TEAM_ADMIN_PASSWORD=disposable-test-only\n',
        'teams/dry-team/state/sentinel': 'preserve local state\n'
    };
    for (const [name, contents] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
        fs.writeFileSync(path.join(directory, name), contents);
    }
    for (const action of ['delete', 'destroy']) {
        const result = spawnSync(process.execPath, ['pcm-connectathon/aws/scripts/manage-team.js', action,
            '--team-id', 'dry-team', '--dry-run', '--delete-local'], {
            cwd: directory, encoding: 'utf8', env: { ...process.env, PCM_AUTONOMOUS_LOCAL_ONLY: 'false' }
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /\[dry-run\] aws ecs delete-service/);
        assert.match(result.stdout, /\[dry-run\] terraform .* destroy /);
        for (const [name, contents] of Object.entries(files)) {
            assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), contents, `${action}: ${name}`);
        }
    }
});

test('fresh Strict runtime seeds from the ECS-generated environment and preserves it on restart', t => {
    const directory = temporaryDirectory(t);
    const configPath = path.join(directory, 'deployment-team.json');
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({}, 'strict')));
    const deployment = spawnSync(process.execPath, ['pcm-connectathon/aws/scripts/deploy-team-environment.js',
        '--team-id', 'strict-seed', '--config', configPath,
        '--aws-config', 'pcm-connectathon/aws/example-aws-env.json', '--dry-run'], { cwd: root, encoding: 'utf8' });
    assert.equal(deployment.status, 0, deployment.stderr || deployment.stdout);
    const registration = deployment.stdout.split('\n').find(line => line.includes('--container-definitions '));
    const containers = JSON.parse(registration.split('--container-definitions ')[1]);
    const seedEnvironment = Object.fromEntries(containers.find(container => container.name === 'runtime-seed')
        .environment.map(({ name, value }) => [name, value]));
    const runtime = path.join(directory, 'runtime');
    const env = { ...process.env, ...seedEnvironment, RUNTIME_DIR: runtime,
        TEAM_CONFIG_PATH: path.join(runtime, 'team-config.json'), CERTS_DIR: path.join(runtime, 'certs'),
        EXAMPLE_TEAM_CONFIG_PATH: path.join(root, 'pcm-connectathon/example-team-config.json'),
        GENERATE_TEAM_CERTS_SCRIPT: path.join(root, 'pcm-connectathon/scripts/generate-team-certs.js'),
        SEED_UPDATE_PUBLIC_URLS: 'false' };
    const runSeed = () => {
        const result = spawnSync(process.execPath, ['pcm-connectathon/aws/scripts/seed-runtime.js'], { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return result.stdout;
    };
    assert.match(runSeed(), /Runtime initialization complete/);
    const configBytes = fs.readFileSync(env.TEAM_CONFIG_PATH);
    const config = JSON.parse(configBytes);
    assert.equal(config.conformance.mode, 'strict');
    assert.equal(config.conformance.preset, 'strict');
    assert.deepEqual(config.conformance.compatibilityAdapters, []);
    assert.equal(config.legacyDataSource.enabled, false);
    assert.equal(buildEffectivePolicy(config, env).mode, 'strict');
    const certificate = path.join(env.CERTS_DIR, 'pcm-core.crt');
    const certificateBytes = fs.readFileSync(certificate);
    assert.match(runSeed(), /Certificate directory already initialized/);
    assert.deepEqual(fs.readFileSync(env.TEAM_CONFIG_PATH), configBytes);
    assert.deepEqual(fs.readFileSync(certificate), certificateBytes);
});
