'use strict';
/** Generated callback and public Doctor address share one explicit bootstrap input. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { buildBootstrapPlan } = require('../scripts/bootstrap-local-team');
for (const base of [undefined, 'http://192.0.2.10:13100/app', 'https://doctor.example.test:9443/doctor']) test(`generated exact callback follows ${base || 'published port'}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-browser-bootstrap-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const args = ['pcm-connectathon/scripts/create-team.js', '--team-id', 'owned-browser', '--teams-root', root, '--sp-port', '13100', '--generate-certs', 'false', ...(base ? ['--doctor-base-url', base] : [])];
    cp.execFileSync(process.execPath, args, { stdio: 'pipe' });
    const config = JSON.parse(fs.readFileSync(path.join(root, 'owned-browser', 'team-config.json'))), expected = base || 'http://localhost:13100';
    assert.equal(config.publicBaseUrls.spClient, expected); assert.deepEqual(config.organizations.serviceProvider.redirectUris, [`${expected}/callback`]); assert.equal(config.organizations.serviceProvider.redirectUri, `${expected}/callback`);
    assert.equal(config.organizations.hospitalBServiceProvider.redirectUris, undefined);
});
test('canonical local bootstrap forwards the explicit Doctor browser base without deriving a request host', () => {
    const plan = buildBootstrapPlan({ teamId: 'owned', teamsRoot: '/tmp/owned', portIndex: 3, preset: 'strict', doctorBaseUrl: 'https://doctor.example.test/app' });
    assert.deepEqual(plan.createArgs.slice(plan.createArgs.indexOf('--doctor-base-url'), plan.createArgs.indexOf('--doctor-base-url') + 2), ['--doctor-base-url', 'https://doctor.example.test/app']);
});
