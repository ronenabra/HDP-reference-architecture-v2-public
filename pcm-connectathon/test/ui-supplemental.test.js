'use strict';
/** Missing browser fixtures must fail before a runtime job can silently skip them. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflight, manifest, REQUIRED_FIXTURE_FILES, expectedPlatformSkip } = require('../ui/run-supplemental');
const { previewFixture } = require('../ui/generate-preview-fixture');
test('supplemental manifest requires every named suite and rejects absent fixture inputs', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-missing-fixture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.throws(() => preflight(root, '/missing-team'), /Missing required supplemental fixture/);
    assert.throws(() => preflight(path.resolve(__dirname, '../..'), '/missing-team'), /existing disposable team/);
    for (const name of ['admin-plain', 'admin-refresh', 'admin-reload-http', 'approval-scopes', 'consent-cancellation', 'consent-banner', 'services', 'browser-navigation', 'doctor-selection', 'sampling', 'help-component', 'help-runtime', 'ui-ops-rem', 'logs-landmarks', 'logs-workbench', 'logs-bottom-event', 'logging-active-integration']) assert.ok(manifest.suites.find(suite => suite.name === name));
});
test('real-HAPI preview fixture is deterministic and contains >10 ordinary-patient matches across types', () => {
    const bytes = previewFixture(); assert.deepEqual(bytes, previewFixture());
    const resources = JSON.parse(bytes).entry.map(entry => entry.resource);
    assert.ok(resources.filter(resource => resource.resourceType === 'Observation' && resource.subject?.reference === 'Patient/patient-ho-a-0001').length > 10);
    assert.ok(resources.some(resource => resource.resourceType === 'DiagnosticReport' && resource.subject.reference === 'Patient/patient-ho-a-0001'));
});

test('an absent named authored sampling template fails before team admission or browser launch', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-missing-template-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const actualRoot = path.resolve(__dirname, '../..');
    for (const file of REQUIRED_FIXTURE_FILES) {
        const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(actualRoot, file), target);
    }
    fs.rmSync(path.join(root, 'src/sp-client/src/views/patients.ejs'));
    assert.throws(() => preflight(root, '/missing-team', []), /Missing required supplemental fixture: src\/sp-client\/src\/views\/patients\.ejs/);
});

test('only the named native CDP touch exclusions are accepted; authentication and missing fixtures never skip', () => {
    // Mirror Playwright's nested report and preserve the authored @smoke suffix.
    const title = 'Logs horizontal Event splitter accepts native Chromium touch drag and cancellation @smoke';
    const report = { suites: [{ suites: [{ specs: [{ title, tests: [
        { projectName: 'firefox-smoke', status: 'skipped' },
        { projectName: 'webkit-smoke', status: 'skipped' }
    ] }] }] }] };
    const skips = [];
    /** Extract skipped identities using the maintained runner's report shape. */
    function inspect(groups) {
        for (const group of groups || []) {
            for (const spec of group.specs || []) for (const entry of spec.tests || []) {
                if (entry.status === 'skipped') skips.push({ title: spec.title, project: entry.projectName });
            }
            inspect(group.suites);
        }
    }
    inspect(report.suites);
    assert.equal(skips.length, 2);
    for (const skip of skips) assert.equal(expectedPlatformSkip(skip), true, skip.project);
    for (const project of ['chromium-desktop', 'chromium-mobile', 'firefox', undefined]) {
        assert.equal(expectedPlatformSkip({ title, project }), false);
    }
    for (const invalidTitle of [title.replace(' @smoke', ''), `${title} extra`, `prefix ${title}`, undefined]) {
        assert.equal(expectedPlatformSkip({ title: invalidTitle, project: 'webkit-smoke' }), false);
    }
    for (const project of ['chromium-mobile', 'firefox-smoke', 'webkit-smoke']) {
        assert.equal(expectedPlatformSkip({ title: 'Explain this page works before Admin login and on authenticated SMART authorization', project }), false);
        assert.equal(expectedPlatformSkip({ title: 'requires authored repository templates', project }), false);
        assert.equal(expectedPlatformSkip({ title: 'another native touch case', project }), false);
    }
});

test('browser-owned login fixtures are fresh, preserve operator values and decode the selected persisted secret', () => {
    const { ownedBootstrapEnvironment, selectedAdminPassword } = require('../ui/run-playwright');
    const first = ownedBootstrapEnvironment({ PCM_A_DB_PASSWORD: 'retained-db-value' });
    const second = ownedBootstrapEnvironment({});
    assert.ok(first.TEAM_ADMIN_PASSWORD.length >= 32); assert.notEqual(first.TEAM_ADMIN_PASSWORD, second.TEAM_ADMIN_PASSWORD);
    assert.equal(first.PCM_A_DB_PASSWORD, 'retained-db-value');
    assert.equal(ownedBootstrapEnvironment({ TEAM_ADMIN_PASSWORD: 'operator-literal$value' }).TEAM_ADMIN_PASSWORD, 'operator-literal$value');
    assert.equal(selectedAdminPassword('TEAM_ADMIN_PASSWORD="operator-literal$$value"\n', {}), 'operator-literal$value');
    assert.equal(selectedAdminPassword('TEAM_ADMIN_PASSWORD=stored\n', { PCM_UI_ADMIN_PASSWORD: 'explicit' }), 'explicit');
    assert.equal(selectedAdminPassword('TEAM_ADMIN_PASSWORD=\n', {}), '');
});

test('missing Admin authentication is rejected before supplemental fixture or browser launch', async () => {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../ui/run-supplemental.js');
    const source = fs.readFileSync(filename, 'utf8');
    const requireFrom = createRequire(filename);
    let launches = 0;
    const module = { exports: {} };
    const context = {
        module, process, console, __dirname: path.dirname(filename), setInterval, clearInterval,
        require(name) {
            if (name === 'node:child_process') return { spawn() { launches++; }, spawnSync() { launches++; } };
            if (name === '../scripts/team-credentials') return { readEnvironmentValue: () => '' };
            if (name === 'node:fs') return { ...fs, existsSync: () => true, statSync: () => ({ isFile: () => true }),
                readFileSync: file => String(file).endsWith('.env') ? '' : JSON.stringify({ conformance: { preset: 'connectathon-easy' } }) };
            return requireFrom(name);
        }
    };
    vm.runInNewContext(source + '\nmodule.exports._main = main;', context);
    const original = process.env.PCM_UI_ADMIN_PASSWORD;
    delete process.env.PCM_UI_ADMIN_PASSWORD;
    try {
        for (const suite of ['help-runtime', 'browser-navigation']) {
            await assert.rejects(module.exports._main(['node', filename, '--team-config', '/owned/team-config.json', '--suite', suite]), /Missing required selected-team Admin authentication fixture/);
        }
        assert.equal(launches, 0);
    } finally {
        if (original === undefined) delete process.env.PCM_UI_ADMIN_PASSWORD;
        else process.env.PCM_UI_ADMIN_PASSWORD = original;
    }
});

test('supplemental Docker command binds the same Doctor form helper read-only and requires its source', async () => {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const filename = path.resolve(__dirname, '../ui/run-supplemental.js');
    const source = fs.readFileSync(filename, 'utf8'), requireFrom = createRequire(filename);
    const root = path.resolve(__dirname, '../..');
    const module = { exports: {} };
    let browserArgs, cleaned = false;
    const context = { module, process: { env: { PCM_UI_ADMIN_PASSWORD: 'synthetic-login-fixture' } }, console, __dirname: path.dirname(filename),
        require(name) {
            if (name === 'node:child_process') return { spawnSync(command, args) {
                if (command === 'docker' && args[0] === 'run') { browserArgs = args; throw new Error('observed supplemental browser invocation'); }
                return { status: 0, stdout: 'synthetic-image-id' };
            } };
            if (name === './supplemental-manifest.json') return { suites: [{ name: 'owned-discovery', files: ['doctor-diagnostics.spec.js', 'help-integration.spec.js'], fixtures: [] }] };
            if (name === '../scripts/browser-certificates') return { stageBrowserCertificates: () => ({ directory: '/owned/certs', cleanup() { cleaned = true; } }) };
            if (name === 'node:fs') return { ...fs, existsSync: () => true, statSync: () => ({ isFile: () => true }), mkdirSync() {}, chmodSync() {},
                readFileSync: file => String(file).endsWith('.env') ? '' : JSON.stringify({ conformance: { preset: 'strict' }, publicBaseUrls: {} }) };
            return requireFrom(name);
        } };
    vm.runInNewContext(source + '\nmodule.exports._main = main;', context);
    await assert.rejects(module.exports._main(['node', filename, '--team-config', '/owned/team-config.json']), /observed supplemental browser invocation/);
    assert.ok(browserArgs.includes(`${root}/pcm-connectathon/scripts/sanity-data-state.js:/scripts/sanity-data-state.js:ro`));
    for (const file of require('../ui/approval-modules.json')) assert.ok(browserArgs.includes(`${root}/src/shared/${file}:/src/shared/${file}:ro`));
    assert.equal(cleaned, true);
    assert.ok(module.exports.REQUIRED_FIXTURE_FILES.includes('pcm-connectathon/scripts/sanity-data-state.js'));
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-missing-doctor-helper-'));
    try { assert.throws(() => preflight(missing, '/missing-team'), /Missing required supplemental fixture: pcm-connectathon\/scripts\/sanity-data-state.js/); }
    finally { fs.rmSync(missing, { recursive: true, force: true }); }
});

test('browser QA helper needs no Admin module imports to preserve its exact owned selection', () => {
    const vm = require('node:vm');
    const module = { exports: {} }, requested = [];
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../scripts/sanity-data-state.js'), 'utf8'), {
        module, require(name) { requested.push(name); throw new Error(`Browser has no Admin dependency: ${name}`); }
    });
    const stamp = 'a'.repeat(64);
    const html = `<form action="/doctor/create-consent"><input name="identity" value="hospital-a"><select name="serviceId"><option value="owned-lab" data-service-stamp="${stamp}">Owned lab</option></select></form>`;
    const config = { serviceCatalog: { bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'owned-lab' }] } };
    const selection = module.exports.doctorServiceSelection(html, config, 'hospital-a');
    assert.equal(selection.serviceId, 'owned-lab'); assert.equal(selection.serviceStamp, stamp);
    assert.throws(() => module.exports.doctorServiceSelection(html, config, 'hospital-b'), /owned ordinary/);
    assert.deepEqual(requested, []);
});

test('authenticated walkthrough sends the selected secret only to PCM login and rejects failure', async () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.resolve(__dirname, '../ui/release-ui-walkthrough.js'), 'utf8').split('(async () => {')[0];
    const module = { exports: {} };
    const context = { module, process: { env: { PCM_UI_ADMIN_PASSWORD: 'test-only-password' } },
        require(name) {
            if (name === 'node:fs') return { readFileSync: () => JSON.stringify({ publicBaseUrls: { pcmUi: 'http://owned-pcm', healthOrganizations: { 'ho-a': 'https://owned-source' } } }) };
            if (name.includes('@playwright/test')) return {};
            if (name.includes('@axe-core/playwright')) return {};
            throw new Error(`Unexpected import ${name}`);
        }
    };
    vm.runInNewContext(source + '\nmodule.exports = { loginAdmin };', context);
    let calls = 0;
    await module.exports.loginAdmin({ request: { post: async (url, options) => {
        calls++; assert.equal(url, 'http://owned-pcm/admin/login');
        assert.equal(options.form.adminPassword, 'test-only-password'); return { ok: () => true };
    } } });
    assert.equal(calls, 1);
    await assert.rejects(module.exports.loginAdmin({ request: { post: async () => ({ ok: () => false }) } }), /Admin login rejected/);
    context.process.env.PCM_UI_ADMIN_PASSWORD = '';
    await assert.rejects(module.exports.loginAdmin({ request: { post: async () => { calls++; } } }), /login fixture is required/);
    assert.equal(calls, 1);
});

/** Real navigation recovery must be admitted explicitly, never silently skipped. */
test('navigation supplement requires its live runtime test before team or browser admission', t => {
    const selected = manifest.suites.find(suite => suite.name === 'browser-navigation');
    assert.ok(selected.fixtures.includes('team'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-missing-navigation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const actualRoot = path.resolve(__dirname, '../..');
    for (const file of [...REQUIRED_FIXTURE_FILES, 'pcm-connectathon/ui/tests/browser-navigation.spec.js']) {
        const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(actualRoot, file), target);
    }
    assert.throws(() => preflight(root, '/missing-team', [selected]),
        /Missing required supplemental fixture: pcm-connectathon\/ui\/tests\/navigation-runtime\.spec\.js/);
});
