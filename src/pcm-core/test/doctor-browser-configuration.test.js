'use strict';
/** Reviewed callback configuration preserves retained authority and rolls back coherent state. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { dataGrantFixture } = require('../../../test-support/data-grants');
const { doctorBrowserPlan, applyDoctorBrowser } = require('../src/doctor-browser-configuration');
const { EXTENSIONS } = require('../../shared/pcm-contract');
function fixture(t) {
    const h = dataGrantFixture(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-browser-config-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json'); fs.writeFileSync(configPath, JSON.stringify(h.config) + '\n');
    const consent = h.store.get('Consent', h.consent.id); consent.status = 'inactive'; h.store.update(consent);
    for (const contract of h.store.getAll('Contract')) { contract.status = 'terminated'; h.store.update(contract); }
    return { ...h, directory, configPath, options: { store: h.store, configPath, stateDirectory: directory, doctorBase: 'http://doctor.example.test:13100/app', publish: next => fs.writeFileSync(configPath, JSON.stringify(next)) } };
}
test('reviewed update changes only address/redirect metadata, preserves terminal authority and remains idempotent', t => {
    const h = fixture(t), originalBytes = fs.readFileSync(h.configPath), original = JSON.parse(originalBytes);
    const retained = Object.fromEntries(['Consent', 'Contract', 'Endpoint', 'HealthcareService'].map(type => [type, h.store.getAll(type)]));
    const before = h.store.get('Organization', original.organizations.serviceProvider.id); before.active = false; h.store.update(before);
    const plan = doctorBrowserPlan(original, h.store, h.options.doctorBase, originalBytes);
    assert.equal(plan.registrations.length, 1); assert.equal(plan.changes, true);
    const result = applyDoctorBrowser({ ...h.options, reviewDigest: plan.reviewDigest }); assert.equal(result.status, 'applied');
    const next = JSON.parse(fs.readFileSync(h.configPath)); assert.equal(next.organizations.serviceProvider.redirectUri, 'http://doctor.example.test:13100/app/callback');
    for (const key of ['contract', 'healthOrganizations', 'oauthClients', 'certificateRoles']) assert.deepEqual(next[key], original[key]);
    assert.deepEqual(next.organizations.hospitalBServiceProvider, original.organizations.hospitalBServiceProvider);
    for (const [type, resources] of Object.entries(retained)) assert.deepEqual(h.store.getAll(type), resources, type);
    const organization = h.store.get('Organization', before.id); assert.equal(organization.active, false);
    assert.equal(organization.extension.find(item => item.url === EXTENSIONS.oauthRedirectUri).valueUrl, next.organizations.serviceProvider.redirectUri);
    const backup = path.join(h.directory, 'doctor-browser-backups', fs.readdirSync(path.join(h.directory, 'doctor-browser-backups'))[0]);
    assert.equal(fs.statSync(backup).mode & 0o777, 0o600); assert.equal(JSON.parse(fs.readFileSync(backup)).configText, originalBytes.toString());
    assert.throws(() => applyDoctorBrowser({ ...h.options, reviewDigest: plan.reviewDigest }), /stale/);
    const currentBytes = fs.readFileSync(h.configPath), unchanged = doctorBrowserPlan(next, h.store, h.options.doctorBase, currentBytes);
    assert.equal(applyDoctorBrowser({ ...h.options, reviewDigest: unchanged.reviewDigest }).status, 'unchanged'); assert.deepEqual(fs.readFileSync(h.configPath), currentBytes);
});
test('stale resource/config review and maintenance fences reject before publication', t => {
    const h = fixture(t), original = fs.readFileSync(h.configPath);
    const plan = doctorBrowserPlan(h.config, h.store, h.options.doctorBase, original);
    h.store.update(h.store.get('Organization', h.config.organizations.serviceProvider.id));
    assert.throws(() => applyDoctorBrowser({ ...h.options, reviewDigest: plan.reviewDigest }), /stale/); assert.deepEqual(fs.readFileSync(h.configPath), original);
    fs.writeFileSync(path.join(h.directory, 'pcm-ig-041-maintenance'), 'owned test fence');
    assert.throws(() => applyDoctorBrowser({ ...h.options, reviewDigest: plan.reviewDigest }), /maintenance/);
    assert.equal(fs.existsSync(path.join(h.directory, 'doctor-browser-backups')), false);
});
test('publication failure restores exact configuration and the entire retained graph', t => {
    const h = fixture(t), original = fs.readFileSync(h.configPath), graph = JSON.stringify(h.store.data, (_, value) => value instanceof Map ? [...value] : value);
    const plan = doctorBrowserPlan(h.config, h.store, h.options.doctorBase, original);
    assert.throws(() => applyDoctorBrowser({ ...h.options, reviewDigest: plan.reviewDigest, publish(next) { fs.writeFileSync(h.configPath, JSON.stringify(next)); throw new Error('injected disk publication failure'); } }), /injected/);
    assert.deepEqual(fs.readFileSync(h.configPath), original); assert.equal(JSON.stringify(h.store.data, (_, value) => value instanceof Map ? [...value] : value), graph);
});

test('protected configuration option rejects unauthenticated, extra-field and stale requests without a new registration API', async t => {
    const runtime = await require('../../../test-support/pcm-042-runtime').startRuntime(); t.after(() => runtime.close());
    await require('../src/bootstrap')();
    const base = runtime.config.publicBaseUrls.pcmUi, headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-admin-password': '04102-local-fixture-only' };
    const post = (action, body, authenticated = true) => fetch(`${base}/admin/config/doctor-browser/${action}`, { method: 'POST', headers: authenticated ? headers : { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('preview', { doctorBase: 'http://doctor.example.test:13100/app' }, false)).status, 401);
    assert.equal((await post('apply', { doctorBase: 'http://doctor.example.test:13100/app', clientId: 'invented', reviewDigest: 'invented' })).status, 400);
    const preview = await post('preview', { doctorBase: 'http://doctor.example.test:13100/app' }); assert.equal(preview.status, 200, await preview.clone().text()); const plan = await preview.json();
    assert.equal(plan.registrations[0].clientId, runtime.config.organizations.serviceProvider.clientId);
    assert.equal((await post('apply', { doctorBase: plan.doctorBase, reviewDigest: 'invented' })).status, 409);
    const applied = await post('apply', { doctorBase: plan.doctorBase, reviewDigest: plan.reviewDigest }); assert.equal(applied.status, 200); assert.equal((await applied.json()).status, 'applied');
    const config = require('../src/team-config').loadTeamConfig(); assert.deepEqual(config.organizations.serviceProvider.redirectUris, ['http://doctor.example.test:13100/app/callback']);
    assert.equal((await post('apply', { doctorBase: plan.doctorBase, reviewDigest: plan.reviewDigest })).status, 409);
});
