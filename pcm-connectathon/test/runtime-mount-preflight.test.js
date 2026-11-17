'use strict';

/** Regression coverage for retained logs/state without destructive reset. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkRuntimeMounts, repairRuntimeMounts, repairTrees } = require('../scripts/runtime-mount-preflight');

/** Create one isolated team tree and remove it after each test. */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-preflight-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'logs'));
    fs.mkdirSync(path.join(root, 'state'));
    return root;
}

test('fresh and reused log/state trees pass with contents retained', t => {
    const root = fixture(t);
    checkRuntimeMounts(root, process.getuid(), process.getgid());
    const history = path.join(root, 'logs/pcm-core/history');
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, 'old.log'), 'retained log');
    fs.writeFileSync(path.join(root, 'state/operation-lock'), 'reserved');
    checkRuntimeMounts(root, process.getuid(), process.getgid());
    assert.equal(fs.readFileSync(path.join(root, 'state/operation-lock'), 'utf8'), 'reserved');
});

for (const relative of ['logs/pcm-core/history', 'logs/sp-client/current.log', 'logs/ho-a-adapter/current.log', 'logs/ho-a-gateway/current.log', 'state/access-tokens/token.json', 'state/import/operation-lock']) {
    test(`reports restricted ${relative} before startup`, t => {
        const root = fixture(t), target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (relative.endsWith('history')) fs.mkdirSync(target);
        else fs.writeFileSync(target, 'retained');
        let parent = path.dirname(target);
        while (parent !== root) { fs.chmodSync(parent, 0o777); parent = path.dirname(parent); }
        fs.chmodSync(target, 0o700);
        // Root trees allow traversal to isolate the failing descendant for another identity.
        fs.chmodSync(path.join(root, 'logs'), 0o777);
        fs.chmodSync(path.join(root, 'state'), 0o777);
        assert.throws(() => checkRuntimeMounts(root, process.getuid() + 10000, process.getgid() + 10000), error => {
            assert.match(error.message, /owner=.*mode=.*service.*--force/);
            assert.ok(error.message.includes(relative));
            return true;
        });
    });
}

test('repair preserves bytes and private file modes while restoring owner access', t => {
    const root = fixture(t), file = path.join(root, 'state/token');
    fs.writeFileSync(file, 'keep token'); fs.chmodSync(file, 0o400);
    const changes = [];
    const io = Object.create(fs);
    io.chownSync = (target, uid, gid) => changes.push({ target, uid, gid });
    assert.equal(repairTrees([path.join(root, 'logs'), path.join(root, 'state')], process.getuid(), process.getgid(), io), 3);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep token');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(changes.length, 3);
    checkRuntimeMounts(root, process.getuid(), process.getgid());
});

for (const kind of ['symlink', 'hardlink']) {
    test(`rejects ${kind} before any repair in either tree`, t => {
        const root = fixture(t), outside = path.join(root, 'outside');
        fs.writeFileSync(outside, 'outside');
        const link = path.join(root, 'state/link');
        if (kind === 'symlink') fs.symlinkSync(outside, link);
        else fs.linkSync(outside, link);
        const io = Object.create(fs);
        io.chownSync = () => assert.fail('must not change ownership before complete validation');
        assert.throws(() => repairTrees([path.join(root, 'logs'), path.join(root, 'state')], 1000, 1000, io), /unsafe link/);
        assert.throws(() => checkRuntimeMounts(root, 1000, 1000), /unsafe link/);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    });
}

test('rejects symlinked team ancestors before creating directories', t => {
    const root = fixture(t), alias = path.join(root, 'alias');
    fs.symlinkSync(root, alias);
    assert.throws(() => checkRuntimeMounts(alias, 1000, 1000), /symlink ancestor/);
});

test('force repair mounts only named trees and uses offline pinned image; failures are actionable', t => {
    const root = fixture(t);
    const file = path.join(root, 'state/token');
    fs.writeFileSync(file, 'keep'); fs.chmodSync(file, 0o400);
    let command;
    repairRuntimeMounts(root, process.getuid(), process.getgid(), (name, args) => { command = { name, args }; fs.chmodSync(file, 0o600); });
    assert.equal(command.name, 'docker');
    assert.ok(command.args.includes('none'));
    assert.ok(command.args.includes('never'));
    const mounts = command.args.filter(arg => arg.startsWith('type=bind'));
    assert.equal(mounts.length, 3);
    assert.ok(mounts[0].includes('dst=/repair/logs'));
    assert.ok(mounts[1].includes('dst=/repair/state'));
    assert.ok(mounts[2].endsWith('readonly'));
    fs.chmodSync(file, 0o400);
    assert.throws(() => repairRuntimeMounts(root, process.getuid(), process.getgid(), () => { throw new Error('image missing'); }), /image missing.*Team remains stopped.*No files were deleted/);
    assert.throws(() => checkRuntimeMounts(root, NaN, 1000), /nonnegative integers/);
});

test('lifecycle orders preflight/force repair before Compose and preserves stop bind mounts', () => {
    const start = fs.readFileSync(path.join(__dirname, '../scripts/start-local-team.js'), 'utf8');
    assert.ok(start.indexOf('stop-local-team.js') < start.indexOf('repairRuntimeMounts(teamDir'));
    assert.ok(start.indexOf('checkRuntimeMounts(teamDir') < start.indexOf('const composeArgs'));
    const bootstrap = fs.readFileSync(path.join(__dirname, '../scripts/bootstrap-local-team.js'), 'utf8');
    assert.ok(bootstrap.indexOf('repairRuntimeMounts(teamDir') < bootstrap.indexOf('run(\'node\', plan.createArgs'));
    const stop = fs.readFileSync(path.join(__dirname, '../scripts/stop-local-team.js'), 'utf8');
    assert.match(stop, /Retained host bind directories/);
    assert.doesNotMatch(stop, /rmSync|unlinkSync|chownSync|chmodSync/);
});


test('healthy force preflight needs no utility invocation and file roots fail closed', t => {
    const root = fixture(t);
    repairRuntimeMounts(root, process.getuid(), process.getgid(), () => assert.fail('healthy tree needs no repair'));
    fs.rmdirSync(path.join(root, 'logs')); fs.writeFileSync(path.join(root, 'logs'), 'not a directory');
    assert.throws(() => repairRuntimeMounts(root, process.getuid(), process.getgid(), () => assert.fail('unsafe root')), /unsafe directory/);
});

test('executed start checks access before Compose; force stops, repairs and rechecks in order', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../scripts/start-local-team.js'), 'utf8');
    for (const force of [false, true]) {
        const calls = [];
        const sandbox = {
            module: { exports: {} }, process, console: { log() {} },
            require(name) {
                if (name === 'fs') return { existsSync: () => true, readFileSync: () => 'LOCAL_UID=1000\nLOCAL_GID=1000\n' };
                if (name === './lib') return {
                    parseArgs: () => ({ 'team-id': 'selected', force }), repoRoot: () => '/repo',
                    requireSafeTeamId() {}, DEFAULT_TEAMS_ROOT: '/teams', readValidatedTeamConfig: () => ({ healthOrganizations: [] }),
                    run: (command, args) => calls.push(args.includes('pcm-connectathon/scripts/stop-local-team.js') ? 'stop' : 'compose')
                };
                if (name.endsWith('conformance-policy')) return { buildEffectivePolicy: () => ({ exposure: {} }), effectivePolicyReport: () => ({}) };
                if (name === './readiness-state') return { planReadinessState: text => ({ waitTimeout: 600, environment: text }) };
                if (name === './hapi-log-preflight') return { prepareHapiLogMounts: () => calls.push('hapi-check') };
                if (name === './runtime-mount-preflight') return {
                    repairRuntimeMounts: () => calls.push('repair'),
                    checkRuntimeMounts: () => { calls.push('check'); if (!force) throw new Error('inaccessible retained log'); }
                };
                return name.startsWith('./') ? require(path.join(__dirname, '../scripts', name)) : require(name);
            }
        };
        vm.runInNewContext(source, sandbox);
        if (force) {
            sandbox.module.exports.main();
            assert.deepEqual(calls, ['stop', 'repair', 'check', 'hapi-check', 'compose']);
        } else {
            assert.throws(() => sandbox.module.exports.main(), /inaccessible retained log/);
            assert.deepEqual(calls, ['check']);
        }
    }
});

test('repeated stop --volumes retains host log/state bytes and explains retention', t => {
    const { spawnSync } = require('node:child_process');
    const parent = fixture(t), teamId = 'selected', team = path.join(parent, teamId);
    fs.mkdirSync(path.join(team, 'logs'), { recursive: true }); fs.mkdirSync(path.join(team, 'state'));
    fs.writeFileSync(path.join(team, '.env'), 'TEAM_ID=test\n');
    fs.writeFileSync(path.join(team, 'logs/current.log'), 'keep log');
    fs.writeFileSync(path.join(team, 'state/lock'), 'reserved');
    const bin = path.join(team, 'bin'); fs.mkdirSync(bin);
    // Stub only Docker: execute the real stop CLI twice without touching running projects.
    fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const flags of [[], ['--volumes']]) for (let i = 0; i < 2; i++) {
        const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/stop-local-team.js'), '--team-id', teamId, '--teams-root', path.dirname(team), ...flags], {
            encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Retained host bind directories/);
        assert.equal(fs.readFileSync(path.join(team, 'logs/current.log'), 'utf8'), 'keep log');
        assert.equal(fs.readFileSync(path.join(team, 'state/lock'), 'utf8'), 'reserved');
    }
});

test('executed bootstrap force stops and repairs before rewriting generated team files', async t => {
    const vm = require('node:vm');
    const parent = fixture(t), team = path.join(parent, 'selected');
    fs.mkdirSync(team); fs.writeFileSync(path.join(team, '.env'), 'retained');
    const calls = [];
    const sandbox = { module: { exports: {} }, process, console: { log() {}, error() {} }, require(name) {
        if (name === './lib') return {
            parseArgs: () => ({ 'team-id': 'selected', 'teams-root': parent, force: true }),
            repoRoot: () => '/repo', requireSafeTeamId() {}, portSet: () => ({}),
            run(command, args) {
                if (args[0].endsWith('stop-local-team.js')) calls.push('stop');
                else { calls.push('create'); throw new Error('captured create'); }
            }
        };
        if (name === './runtime-mount-preflight') return { repairRuntimeMounts: () => calls.push('repair') };
        if (name === './team-credentials') return { planTeamCredentials: () => calls.push('credentials') };
        if (name === './configure-system-workflow-fixtures') return {};
        if (name === './lifecycle') return { readinessWaitTimeout: () => 600, readinessEnvironment: env => env, checkPorts: async () => [] };
        return require(name);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/bootstrap-local-team.js'), 'utf8'), sandbox);
    await assert.rejects(sandbox.module.exports.main(), /captured create/);
    assert.deepEqual(calls, ['credentials', 'stop', 'repair', 'create']);
    assert.equal(fs.readFileSync(path.join(team, '.env'), 'utf8'), 'retained');
});
