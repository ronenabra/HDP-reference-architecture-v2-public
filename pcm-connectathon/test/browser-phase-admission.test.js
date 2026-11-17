'use strict';

/** Closed browser phase admission tests use unit-only reports, never runtime evidence. */
const test = require('node:test'), assert = require('node:assert/strict');
const { admit, plans, MAIN_RUNTIME_GREP } = require('../scripts/browser-phase-admission');
const { reportTests } = require('../scripts/browser-report');
const devices = ['chromium-desktop', 'chromium-mobile'];

/** Build the finite required identities for each mode without running or crediting browser journeys. */
function report(name, discovery = false) {
    const rows = [];
    const add = (title, projects = devices) => rows.push({ file: 'unit-only.spec.js', title, tests: projects.map(projectName => ({ projectName, results: discovery ? [] : [{ status: 'passed' }], annotations: [], expectedStatus: 'passed' })) });
    if (name === 'demo') for (const card of ['catalog', 'access', 'patients', 'sources']) add(`DEMO ${card} unit contract`);
    else if (name === 'main') {
        add('critical pages are responsive', [...devices, 'firefox-smoke', 'webkit-smoke']); add('completes consent approval');
        for (const title of ['bounded Admin operator lifecycle', 'all three Admin upload forms', 'simulation form applies preset defaults', 'cross-mode simulation requests',
            'deployment navigation and both generated', 'Admin target counts preserve pending', 'Doctor diagnostics preserves text', 'Doctor identity selection preserves labels',
            'Explain this page works before Admin login', 'Doctor negative identities reach the actual', 'Doctor live Consent and service transitions',
            ...['Admin', 'Admin logs', 'Doctor', 'Doctor patient library', 'Doctor management', 'Doctor logs', 'PCM consent', 'PCM central logs'].map(page => `Explain this page covers ${page} without mutations`)]) add(title, ['chromium-desktop']);
    } else if (name === 'partial') add('PCM 0.4.0 failed source preserves known presence');
    else if (name === 'candidate-partial') add('candidate 0.4.2 unavailable source');
    else for (const title of ['PCM 0.4.0 home-HMO OTP and dependent discovery', 'candidate 0.4.2 SSO is independent', 'candidate 0.4.2 Palestinian', 'candidate 0.4.2 normative login rejects', 'candidate 0.4.2 Israeli OTP']) add(title);
    return { errors: [], stats: { unexpected: 0, flaky: 0 }, suites: [{ specs: rows }] };
}

for (const { name } of plans) test(`${name}: discovery has no execution credit and immediate results reject missing/skipped/changed required selection`, () => {
    const metadata = report(name, true), discovered = admit(name, metadata, true);
    assert.ok(discovered.required.every(row => row.discovered && !('executed' in row) && !('status' in row)));
    const actual = report(name); assert.ok(admit(name, actual, false, discovered.selectedKeys).required.every(row => row.executed && row.status === 'pass'));
    const missing = report(name); missing.suites[0].specs.shift(); assert.throws(() => admit(name, missing, false, discovered.selectedKeys));
    const skipped = report(name); reportTests(skipped)[0].test.results = [{ status: 'skipped' }]; assert.throws(() => admit(name, skipped, false, discovered.selectedKeys));
    const failed = report(name); reportTests(failed)[0].test.results = [{ status: 'failed' }]; assert.throws(() => admit(name, failed, false, discovered.selectedKeys));
    const changed = report(name); reportTests(changed)[0].test.projectName = 'unselected-project'; assert.throws(() => admit(name, changed, false, discovered.selectedKeys));
    assert.throws(() => admit(name, actual, true), /discovery cannot claim/);
    const staticSkip = report(name, true); reportTests(staticSkip)[0].test.expectedStatus = 'skipped'; assert.throws(() => admit(name, staticSkip, true));
});

test('main runtime closure records component identities outside the mandatory runtime closure without pass credit', () => {
    const metadata = report('main', true); metadata.suites[0].specs.push({ file: 'services-scopes.spec.js', title: 'component scope case', tests: [{ projectName: 'chromium-desktop', results: [] }] });
    const value = admit('main', metadata, true);
    assert.equal(value.deferredComponentKeys.length, 1); assert.equal(value.deferredComponentsAreNotPasses, true);
    assert.ok(!new RegExp(MAIN_RUNTIME_GREP).test('component scope case'));
});

test('nonrequired workflow exclusion is explicit and cannot replace a required case', () => {
    const actual = report('workflow'); actual.suites[0].specs.push({ file: 'extra.spec.js', title: 'unavailable-source separate phase', tests: [{ projectName: 'chromium-desktop', expectedStatus: 'skipped', annotations: [{ type: 'skip', description: 'separate partial phase' }], results: [{ status: 'skipped' }] }] });
    assert.equal(admit('workflow', actual).exclusions.length, 1);
    actual.suites[0].specs.shift(); assert.throws(() => admit('workflow', actual), /coverage missing or skipped/);
});

test('current batch integration cannot pass by a skipped device and remains an aggregate requirement', () => {
    const value = report('main');
    value.suites[0].specs.push({ file: 'batch-integration.spec.js', title: 'batch38 current application owners preserve context and remain passive', tests: devices.map(projectName => ({ projectName, expectedStatus: 'passed', results: [{ status: 'passed' }] })) });
    assert.equal(admit('main', value).required.find(row => row.id === 'browser-batch38-current-owners').executed, true);
    value.suites[0].specs.at(-1).tests[1].results = [{ status: 'skipped' }];
    assert.throws(() => admit('main', value), /coverage missing or skipped/);
    for (const preset of require('../../src/shared/conformance-policy').PRESETS) {
        assert.ok(require('../scripts/full-coverage').requiredScenarios(preset).includes('browser-batch38-current-owners'));
    }
});
