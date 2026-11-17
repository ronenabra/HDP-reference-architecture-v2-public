'use strict';

/** Verify browser fixture access without weakening original private keys. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stageBrowserCertificates } = require('../scripts/browser-certificates');

/** Create a temporary fixture and remove it after each test. */
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-certificate-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'client.key'), 'synthetic-private-key', { mode: 0o600 });
    return { root, source };
}

test('browser copies permit container access inside a private host parent and preserve source keys', t => {
    const { root, source } = fixture(t);
    const staged = stageBrowserCertificates(source, root);
    const parent = path.dirname(staged.directory);
    assert.equal(fs.statSync(parent).mode & 0o777, 0o700);
    assert.equal(fs.statSync(staged.directory).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(staged.directory, 'client.key')).mode & 0o777, 0o444);
    assert.equal(fs.readFileSync(path.join(staged.directory, 'client.key'), 'utf8'), 'synthetic-private-key');
    assert.equal(fs.statSync(path.join(source, 'client.key')).mode & 0o777, 0o600);
    staged.cleanup();
    staged.cleanup();
    assert.equal(fs.existsSync(parent), false);
    assert.equal(fs.readFileSync(path.join(source, 'client.key'), 'utf8'), 'synthetic-private-key');
});

test('failed preparation removes partial copies and refuses symlinked entries', t => {
    const { root, source } = fixture(t);
    fs.symlinkSync(path.join(source, 'client.key'), path.join(source, 'linked.key'));
    assert.throws(() => stageBrowserCertificates(source, root), /regular file/);
    assert.deepEqual(fs.readdirSync(root), ['source']);
    assert.throws(() => stageBrowserCertificates(path.join(root, 'missing'), root), /ENOENT/);
    assert.deepEqual(fs.readdirSync(root), ['source']);
});

test('custom identity subdirectories are copied while nested symlinks are rejected', t => {
    const { root, source } = fixture(t);
    const custom = path.join(source, 'custom/identity');
    fs.mkdirSync(custom, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(custom, 'assertion.key'), 'synthetic-custom-key', { mode: 0o600 });
    const staged = stageBrowserCertificates(source, root);
    assert.equal(fs.readFileSync(path.join(staged.directory, 'custom/identity/assertion.key'), 'utf8'), 'synthetic-custom-key');
    assert.equal(fs.statSync(path.join(staged.directory, 'custom/identity')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(staged.directory, 'custom/identity/assertion.key')).mode & 0o777, 0o444);
    assert.equal(fs.statSync(path.join(custom, 'assertion.key')).mode & 0o777, 0o600);
    staged.cleanup();
    fs.symlinkSync(path.join(source, 'client.key'), path.join(custom, 'linked.key'));
    assert.throws(() => stageBrowserCertificates(source, root), /regular file or directory/);
    assert.deepEqual(fs.readdirSync(root), ['source']);
});

test('runner removes staged credentials when Docker fails before browser startup', t => {
    const { root, source } = fixture(t);
    fs.writeFileSync(path.join(root, '.env'), 'TEAM_ADMIN_PASSWORD=synthetic-login-fixture\n', { mode: 0o600 });
    fs.renameSync(source, path.join(root, 'certs'));
    let staged;
    const runnerModule = { exports: {} };
    const localRequire = name => {
        if (name === './approval-modules.json') return require('../ui/approval-modules.json');
        if (name === '../scripts/lib') return {
            parseArgs: () => ({ 'team-config': path.join(root, 'team-config.json'), artifacts: path.join(root, 'artifacts') }),
            repoRoot: () => root, requireSafeTeamId: () => {},
            readJson: () => ({ publicBaseUrls: {} }),
            run: () => { throw new Error('synthetic Docker failure'); }
        };
        if (name === '../scripts/browser-certificates') return {
            stageBrowserCertificates: directory => (staged = stageBrowserCertificates(directory, root))
        };
        return require(name);
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/run-playwright.js'), 'utf8'), {
        process: { env: {} },
        require: localRequire, module: runnerModule, console
    });
    assert.throws(() => runnerModule.exports.main([]), /synthetic Docker failure/);
    assert.equal(fs.existsSync(path.dirname(staged.directory)), false);
    assert.equal(fs.statSync(path.join(root, 'certs/client.key')).mode & 0o777, 0o600);
});


test('the actual browser Docker command binds its shared assertion and Doctor form helpers read-only', t => {
    const { root, source } = fixture(t);
    fs.writeFileSync(path.join(root, '.env'), 'TEAM_ADMIN_PASSWORD=synthetic-login-fixture\n', { mode: 0o600 });
    fs.renameSync(source, path.join(root, 'certs'));
    const runnerModule = { exports: {} }; let browserArgs;
    const localRequire = name => {
        if (name === './approval-modules.json') return require('../ui/approval-modules.json');
        if (name === '../scripts/lib') return {
            parseArgs: () => ({ 'team-config': path.join(root, 'team-config.json'), artifacts: path.join(root, 'artifacts') }),
            repoRoot: () => root, requireSafeTeamId() {},
            readJson: () => ({ publicBaseUrls: {}, healthOrganizations: [], conformance: { preset: 'strict' } }),
            run: (program, args) => { if (program === 'docker' && args[0] === 'run') { browserArgs = args; throw new Error('observed browser invocation'); } }
        };
        if (name === '../scripts/fixture-patients') return { inspectTeamFixtures: () => ({ sources: [], patients: [] }) };
        if (name === '../scripts/browser-certificates') return { stageBrowserCertificates: directory => stageBrowserCertificates(directory, root) };
        return require(name);
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/run-playwright.js'), 'utf8'), { process: { env: {} }, require: localRequire, module: runnerModule, console });
    assert.throws(() => runnerModule.exports.main([]), /observed browser invocation/);
    assert.ok(browserArgs.includes(`${path.join(root, 'src/shared/assertion-keys.js')}:/src/shared/assertion-keys.js:ro`));
    assert.ok(browserArgs.includes(`${path.join(root, 'pcm-connectathon/scripts/sanity-data-state.js')}:/scripts/sanity-data-state.js:ro`));
    assert.ok(browserArgs.includes('PCM_NAV_REPO=/repo')); assert.ok(browserArgs.includes(`${root}:/repo:ro`));
    for (const file of require('../ui/approval-modules.json')) assert.ok(browserArgs.includes(`${path.join(root, 'src/shared', file)}:/src/shared/${file}:ro`));
    assert.equal(fs.statSync(path.join(root, 'certs/client.key')).mode & 0o777, 0o600);
});
