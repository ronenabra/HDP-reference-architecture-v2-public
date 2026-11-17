'use strict';

/** Execute the real full runner through bootstrap and its first authenticated request. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../scripts/run-full-verification.js');
const sourceRequire = createRequire(filename);
const { encodeEnvironmentValue } = require('../scripts/team-credentials');
const { readTeamAdminPassword } = require('../scripts/run-full-verification');
const { PRESETS } = require('../../src/shared/conformance-policy');

/** Stub external work only; preserve runner control flow and actual credential codecs. */
async function executeToAuthenticatedRequest(t, preset, password) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-full-admin-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const environment = password === undefined ? {} : { TEAM_ADMIN_PASSWORD: password };
    let bootstrap, authenticated, cleanup;
    const module = { exports: {} };
    const localRequire = name => {
        if (name === './lib') return {
            parseArgs: () => ({ 'run-id': '20261027T090000Z' }), repoRoot: () => root, LOCAL_ONLY_ENV: 'PCM_LOCAL_ONLY',
            run(program, args, options) {
                if (args[0]?.endsWith('discover-required-browser.js')) {
                    const output = args[args.indexOf('--output') + 1]; fs.mkdirSync(output, { recursive: true });
                    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ unitOnly: true, phases: [] }));
                }
                if (args[0]?.endsWith('bootstrap-local-team.js')) {
                    bootstrap = { args, environment: options.env };
                    const value = flag => args[args.indexOf(flag) + 1];
                    const teamDir = path.join(value('--teams-root'), value('--team-id'));
                    fs.mkdirSync(teamDir, { recursive: true });
                    fs.writeFileSync(path.join(teamDir, '.env'), `TEAM_ADMIN_PASSWORD=${encodeEnvironmentValue(options.env.TEAM_ADMIN_PASSWORD)}\n`, { mode: 0o600 });
                    fs.writeFileSync(path.join(teamDir, 'team-config.json'), JSON.stringify({ publicBaseUrls: { pcmUi: 'http://localhost:9100' } }));
                    fs.writeFileSync(value('--empty-sanity-output'), JSON.stringify({ status: 'pass', checks: [
                        { name: 'doctor-flow-not-applicable-without-verified-fixture' },
                        ...['ho-a', 'ho-b', 'ho-c'].map(id => ({ name: `${id}-online-presence-count-only`, total: 0, status: 'pass' }))
                    ] }));
                }
                if (args[0]?.endsWith('stop-local-team.js')) cleanup = options.env;
            }
        };
        if (name === 'child_process') return { execFileSync: () => 'unit-source-revision\n' };
        if (name === './source-identity') return { sourceIdentity: () => ({ sha256: 'unit-source-tree', files: [] }) };
        if (name === '../../src/shared/conformance-policy') return { PRESETS: [preset] };
        if (name === '../../src/shared/outbound-destination') return { guardedFetch: async (url, options) => {
            authenticated = { url, headers: options.headers };
            throw new Error('captured first authenticated inventory request');
        } };
        return sourceRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: localRequire, process: { env: environment }, console: { log() {} }, Buffer, AbortSignal });
    await assert.rejects(module.exports.main([]), /captured first authenticated inventory request/);
    assert.ok(bootstrap);
    assert.equal(bootstrap.args[bootstrap.args.indexOf('--preset') + 1], preset);
    const fixture = bootstrap.environment.TEAM_ADMIN_PASSWORD;
    assert.ok(fixture && fixture.length >= 20);
    if (password) assert.equal(fixture, password);
    assert.equal(authenticated.headers['x-admin-password'], fixture);
    assert.equal(cleanup.TEAM_ADMIN_PASSWORD, fixture);
    return fixture;
}

test('all four actual full-run bootstrap paths provide nonempty decoded Admin authentication', async t => {
    const generated = [];
    for (const preset of PRESETS) for (const password of [undefined, '', 'operator-literal$with"quotes']) {
        const fixture = await executeToAuthenticatedRequest(t, preset, password);
        if (!password) generated.push(fixture);
    }
    assert.equal(new Set(generated).size, generated.length);
});

test('the persisted Admin reader rejects ambiguous credentials rather than using a raw encoded value', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-full-admin-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '.env'), 'TEAM_ADMIN_PASSWORD=first\nTEAM_ADMIN_PASSWORD=second\n');
    assert.throws(() => readTeamAdminPassword(root), /ambiguous/);
});
