'use strict';

/** Verify bounded readiness budgets reach Compose without running a disposable stack. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { composeUpArgs, readinessWaitTimeout, readinessEnvironment } = require('../scripts/lifecycle');

/** Load a CLI module with only external command and runtime inventory dependencies replaced. */
function loadCli(filename, replacements) {
    const full = path.resolve(__dirname, '../scripts', filename);
    const localRequire = createRequire(full);
    const exported = { exports: {} };
    const wrappedRequire = name => Object.hasOwn(replacements, name) ? replacements[name] : localRequire(name);
    vm.runInNewContext(fs.readFileSync(full, 'utf8'), {
        require: wrappedRequire, module: exported, exports: exported.exports,
        __dirname: path.dirname(full), process, console: { log() {}, error() {} }
    }, { filename: full });
    return exported.exports;
}

test('readiness wait preserves the default and accepts only bounded whole seconds', () => {
    assert.equal(readinessWaitTimeout(undefined), 600);
    for (const value of [1, '600', 3600]) assert.equal(readinessWaitTimeout(value), Number(value));
    for (const value of [0, -1, 3601, 1.5, '', ' ', 'nonsense', true, null, NaN, Infinity]) {
        assert.throws(() => readinessWaitTimeout(value), /whole number.*1 through 3600/);
    }
    assert.equal(composeUpArgs('/tmp/team.env').at(-1), '600');
    assert.equal(composeUpArgs('/tmp/team.env', { waitTimeout: 600 }).at(-1), '600');
    assert.throws(() => composeUpArgs('/tmp/team.env', { waitTimeout: 0 }), /wait-timeout/);
});

test('bootstrap and full qualification forward the explicit readiness budget to their child CLI', async t => {
    const lib = require('../scripts/lib');
    const lifecycle = require('../scripts/lifecycle');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-wait-forward-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let started;
    let startEnvironment;
    const bootstrap = loadCli('bootstrap-local-team.js', {
        './lib': { ...lib, repoRoot: () => root, readValidatedTeamConfig: () => ({}),
            run: (program, args, options) => {
                if (args[0].endsWith('/start-local-team.js')) { startEnvironment = options.env; started = args; throw new Error('captured start'); }
            } },
        './lifecycle': { ...lifecycle, checkPorts: async ports => ports.map(port => ({ port, available: true })) }
    });
    await assert.rejects(bootstrap.main(['node', 'bootstrap', '--team-id', 'wait-fixture', '--teams-root', path.join(root, 'teams'), '--wait-timeout', '600']), /captured start/);
    assert.equal(started[started.indexOf('--wait-timeout') + 1], '600');
    assert.equal(startEnvironment.PCM_HAPI_HEALTH_START_PERIOD, '600s');
    let bootstrapped;
    let bootstrapEnvironment;
    const full = loadCli('run-full-verification.js', {
        './lib': { ...lib, repoRoot: () => root, run: (program, args, options) => {
            if (args[0].endsWith('/discover-required-browser.js')) {
                const output = args[args.indexOf('--output') + 1]; fs.mkdirSync(output, { recursive: true });
                fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ unitOnly: true, phases: [] }));
            }
            if (args[0].endsWith('/bootstrap-local-team.js')) { bootstrapEnvironment = options.env; bootstrapped = args; throw new Error('captured bootstrap'); }
        } },
        child_process: { execFileSync: () => 'test-source-revision\n' },
        './source-identity': { sourceIdentity: () => ({ sha256: 'readiness-fixture' }) }
    });
    await assert.rejects(full.main(['node', 'full', '--run-id', '20261003T000000Z', '--wait-timeout', '600']), /bootstrap failed/);
    assert.equal(bootstrapped[bootstrapped.indexOf('--wait-timeout') + 1], '600');
    assert.equal(bootstrapEnvironment.PCM_HAPI_HEALTH_START_PERIOD, '600s');
});

test('all three runtime entry points reject invalid readiness budgets before creating a team', () => {
    for (const filename of ['start-local-team.js', 'bootstrap-local-team.js', 'run-full-verification.js']) {
        for (const value of ['0', '-1', '3601', '1.5', 'invalid']) {
            const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts', filename), '--wait-timeout', value], { encoding: 'utf8' });
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /--wait-timeout must be a whole number/);
        }
    }
});


test('HAPI health grace follows the selected bounded wait while preserving other environment values', () => {
    const original = { PCM_FIXTURE: 'preserved', PCM_HAPI_HEALTH_START_PERIOD: '1s' };
    assert.equal(readinessEnvironment(original, 600).PCM_HAPI_HEALTH_START_PERIOD, '600s');
    assert.equal(readinessEnvironment(original, undefined).PCM_HAPI_HEALTH_START_PERIOD, '600s');
    assert.equal(readinessEnvironment(original, 1).PCM_HAPI_HEALTH_START_PERIOD, '90s');
    assert.equal(readinessEnvironment(original, 3600).PCM_HAPI_HEALTH_START_PERIOD, '3600s');
    assert.equal(readinessEnvironment(original, 600).PCM_FIXTURE, 'preserved');
    assert.equal(original.PCM_HAPI_HEALTH_START_PERIOD, '1s');
    assert.throws(() => readinessEnvironment(original, 3601), /wait-timeout/);
});

test('effective Compose HAPI healthchecks use the readiness-selected grace', () => {
    const root = path.resolve(__dirname, '../..');
    for (const seconds of [90, 600]) {
        const result = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml',
            '--env-file', 'pcm-connectathon/example.env', 'config', '--format', 'json'], {
            cwd: root, env: { ...process.env, PCM_HAPI_HEALTH_START_PERIOD: `${seconds}s` }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const compose = JSON.parse(result.stdout);
        for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
            const period = compose.services[`${ho}-hapi`].healthcheck.start_period;
            assert.equal(period, `${seconds === 90 ? '1m30s' : '10m0s'}`);
        }
    }
});


test('team generation persists the selected HAPI grace so later Compose commands keep the same configuration', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-health-env-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const period of ['', '600s']) {
        const teamId = period ? 'selected-health-grace' : 'default-health-grace';
        const environment = { ...process.env };
        if (period) environment.PCM_HAPI_HEALTH_START_PERIOD = period;
        else delete environment.PCM_HAPI_HEALTH_START_PERIOD;
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/create-team.js'),
            '--team-id', teamId, '--teams-root', directory, '--preset', 'connectathon-easy'], {
            env: environment, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const saved = fs.readFileSync(path.join(directory, teamId, '.env'), 'utf8');
        assert.ok(saved.includes(`PCM_HAPI_HEALTH_START_PERIOD=${period || '90s'}\n`));
    }
});
