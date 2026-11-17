'use strict';
/** Required full-gate scenarios must execute; empty smoke cannot satisfy qualification. */
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { browserScenarios, validateQualification, requiredScenarios, loadCiDataset } = require('../scripts/full-coverage');

test('ordinary PCM-token clinical gateway counts are required for every HO and preset', () => {
    for (const preset of PRESETS) {
        for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
            const required = `gateway-clinical-count-positive-${ho}`;
            assert.ok(requiredScenarios(preset).includes(`gateway-clinical-count-${ho}`));
            assert.ok(requiredScenarios(preset).includes(required));
            const result = { presets: PRESETS.map(name => ({ preset: name, cleanup: { status: 'pass' },
                scenarios: requiredScenarios(name).filter(id => name !== preset || id !== required)
                    .map(id => ({ id, executed: true, status: 'pass' })) })) };
            assert.throws(() => validateQualification(result), /required scenario did not pass/);
        }
    }
});

test('Easy requires enforced count evidence and cannot substitute an old bypass scenario', () => {
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        assert.ok(requiredScenarios('connectathon-easy').includes(`gateway-clinical-count-positive-${ho}`));
        assert.ok(!requiredScenarios('connectathon-easy').includes(`gateway-clinical-count-simulation-positive-${ho}`));
    }
});

test('authorized clinical count matrix is mandatory under every preset', () => {
    for (const preset of PRESETS) assert.ok(requiredScenarios(preset).includes('hapi-authorized-counts'));
});
const { PRESETS } = require('../../src/shared/conformance-policy');

test('qualification rejects missing, skipped, failed scenarios, absent HOs and failed cleanup', () => {
    const good = () => ({ presets: PRESETS.map(preset => ({ preset, cleanup: { status: 'pass' },
        scenarios: requiredScenarios(preset).map(id => ({ id, status: 'pass', executed: true })) })) });
    assert.doesNotThrow(() => validateQualification(good()));
    for (const mutation of [
        result => result.presets.pop(),
        result => result.presets[0].scenarios.pop(),
        result => { result.presets[0].scenarios[0].executed = false; },
        result => { result.presets[0].scenarios[0].status = 'skipped'; },
        result => { result.presets[0].scenarios[0].status = 'fail'; },
        result => { result.presets[0].cleanup.status = 'fail'; }
    ]) { const result = good(); mutation(result); assert.throws(() => validateQualification(result), /required|cleanup|preset/); }
});

test('CI manifest binds all three HOs to verified actionable transaction datasets', () => {
    const dataset = loadCiDataset();
    assert.equal(dataset.bundles.length, 3);
    assert.ok(dataset.bundles.every(item => item.inspected.patients.length && item.inspected.counts.Observation));
    assert.throws(() => loadCiDataset('/does/not/exist.json'), /ENOENT/);
});

test('full entry point rejects skip-ui and datasets without actionable Patients', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const crypto = require('node:crypto');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/run-full-verification.js'), '--skip-ui'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot produce full qualification/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-required-data-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dataset = loadCiDataset();
    const manifest = JSON.parse(fs.readFileSync(path.join(dataset.root, 'manifest.json')));
    for (const entry of manifest.bundles) {
        const bundle = JSON.parse(fs.readFileSync(path.join(dataset.root, entry.file)));
        for (const item of bundle.entry) if (item.resource.resourceType === 'Patient') delete item.resource.identifier;
        const bytes = JSON.stringify(bundle);
        fs.writeFileSync(path.join(dir, entry.file), bytes);
        entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => loadCiDataset(manifestPath), /actionable|identifier|Patient/);
    fs.unlinkSync(path.join(dir, manifest.bundles[0].file));
    assert.throws(() => loadCiDataset(manifestPath), /ENOENT/);
});


test('Doctor regression scenarios require observed desktop execution and cannot be satisfied by skips', () => {
    const report = status => ({ suites: [{ specs: [
        'Doctor diagnostics preserves text', 'Doctor identity selection preserves labels',
        'Doctor live Consent and service transitions', 'Doctor negative identities reach the actual'
    ].map(title => ({ title, tests: [{ projectName: 'chromium-desktop', results: [{ status }] }] })) }] });
    const ids = ['browser-doctor-diagnostics', 'browser-doctor-identities', 'browser-lifecycle-invalidation', 'browser-doctor-negative-identities'];
    for (const status of ['passed', 'skipped']) {
        const results = browserScenarios(report(status)).filter(item => ids.includes(item.id));
        assert.equal(results.length, 4);
        assert.ok(results.every(item => item.executed === (status === 'passed')));
    }
    assert.throws(() => browserScenarios(report('failed')), /browser qualification failed/);
    assert.ok(requiredScenarios('strict').includes('gateway-token-expiry'));
    assert.ok(requiredScenarios('connectathon-balanced').includes('token-assertion-boundary'));
    assert.ok(!requiredScenarios('connectathon-easy').includes('token-assertion-boundary'));
});

test('help acceptance requires actual page and authenticated journey passes', () => {
    const ids = ['browser-help-pages', 'browser-help-authentication'];
    const pages = ['Admin', 'Admin logs', 'Doctor', 'Doctor patient library', 'Doctor management', 'Doctor logs', 'PCM consent', 'PCM central logs'];
    const reportFor = (names, status = 'passed') => ({ suites: [{ specs: [
        ...names.map(name => `Explain this page covers ${name} without mutations @smoke`),
        'Explain this page works before Admin login and on authenticated SMART authorization'
    ].map(title => ({ title, tests: [{ projectName: 'chromium-desktop', results: [{ status }] }] })) }] });
    for (const status of ['passed', 'skipped']) {
        const results = browserScenarios(reportFor(pages, status)).filter(item => ids.includes(item.id));
        assert.equal(results.length, 2);
        assert.ok(results.every(item => item.executed === (status === 'passed')));
    }
    // Every page is required: a missing log audit cannot be covered by another
    // page whose name shares the same prefix, such as Admin or Doctor.
    for (const missing of pages) {
        const results = browserScenarios(reportFor(pages.filter(name => name !== missing)));
        assert.equal(results.find(item => item.id === 'browser-help-pages').executed, false, missing);
        assert.equal(results.find(item => item.id === 'browser-help-authentication').executed, true);
    }
    for (const preset of PRESETS) assert.ok(ids.every(id => requiredScenarios(preset).includes(id)));
});

test('private count UI acceptance requires an observed desktop state journey', () => {
    const id = 'browser-private-count-states';
    for (const status of ['passed', 'skipped']) {
        const report = { suites: [{ specs: [{ title: 'Admin target counts preserve pending cancellation errors and exact results',
            tests: [{ projectName: 'chromium-desktop', results: [{ status }] }] }] }] };
        assert.equal(browserScenarios(report).find(item => item.id === id).executed, status === 'passed');
    }
    for (const preset of PRESETS) assert.ok(requiredScenarios(preset).includes(id));
});

test('workflow qualification requires both actual browser projects and every protected native HO', () => {
    const { workflowBrowserScenarios } = require('../scripts/full-coverage');
    const report = status => ({ suites: [{ specs: [{ title: 'PCM 0.4.0 home-HMO OTP and dependent discovery complete through real gateways', tests: ['desktop', 'mobile'].map(device => ({ projectName: `chromium-${device}`, results: [{ status }] })) }] }] });
    assert.ok(workflowBrowserScenarios(report('passed')).every(item => item.executed));
    assert.ok(workflowBrowserScenarios(report('skipped')).every(item => !item.executed));
    assert.throws(() => workflowBrowserScenarios(report('failed')), /required workflow/);
    for (const preset of PRESETS) {
        assert.ok(requiredScenarios(preset).includes('browser-system-workflows-mobile'));
        assert.equal(requiredScenarios(preset).includes('hapi-discovery-ho-c'), preset !== 'connectathon-easy');
    }
});

test('CI Observation fixtures carry the active canonical information-bucket system', () => {
    const { CODE_SYSTEMS } = require('../../src/shared/pcm-contract');
    const dataset = loadCiDataset();
    for (const bundle of dataset.bundles) {
        const data = JSON.parse(fs.readFileSync(path.join(dataset.root, bundle.file)));
        const observations = data.entry.map(entry => entry.resource).filter(resource => resource.resourceType === 'Observation');
        assert.ok(observations.length > 0);
        for (const observation of observations) {
            assert.ok(observation.meta.security.some(coding => coding.system === CODE_SYSTEMS.informationBucket));
        }
    }
});

test('GUID qualification data keeps baseline practitioner reverse-includes isolated', () => {
    const dataset = loadCiDataset();
    const bundle = JSON.parse(fs.readFileSync(path.join(dataset.root, dataset.bundles[0].file)));
    const observations = bundle.entry.map(entry => entry.resource).filter(resource => resource.resourceType === 'Observation');
    assert.ok(observations.some(resource => resource.id === 'sample-observation-1' && resource.subject.reference.startsWith('urn:uuid:')));
    const linked = observations.filter(resource => resource.performer?.some(item => item.reference === 'Practitioner/practitioner-ho-a-0001'));
    assert.deepEqual(linked.map(resource => resource.id), ['observation-ho-a-0001']);
});

test('partial workflow qualification requires both actual devices and rejects failures or skips', () => {
    const { partialWorkflowBrowserScenarios } = require('../scripts/full-coverage');
    const report = { suites: [{ specs: [{ title: 'PCM 0.4.0 failed source preserves known presence and partial discovery', tests:
        ['desktop', 'mobile'].map(device => ({ projectName: `chromium-${device}`, results: [{ status: 'passed' }] })) }] }] };
    assert.equal(partialWorkflowBrowserScenarios(report).length, 2);
    for (const status of ['skipped', 'failed', 'timedOut']) {
        const changed = structuredClone(report);
        changed.suites[0].specs[0].tests[1].results[0].status = status;
        assert.throws(() => partialWorkflowBrowserScenarios(changed));
    }
});


test('accepted DEMO cards require actual runtime and both browser devices in every preset', () => {
    const { demoRequiredScenarios, demoBrowserScenarios } = require('../scripts/full-coverage');
    for (const preset of PRESETS) {
        const required = demoRequiredScenarios(preset);
        assert.ok(required.every(id => requiredScenarios(preset).includes(id)));
        assert.equal(required.filter(id => id.startsWith('browser-demo-')).length, 8);
        assert.ok(required.includes('demo-access-explicit-broad-approval-and-native-isolation'));
        assert.ok(required.includes('demo-access-retired-flags-rejected'));
        assert.ok(!required.some(id => /strict-exceptions-denied|full-grant-introspection/.test(id)));
        assert.ok(!requiredScenarios(preset).some(id => /gateway-clinical-.*simulation/.test(id)));
        assert.ok(requiredScenarios(preset).includes('gateway-clinical-page-enforced-ho-a'));
        for (const missing of required) {
            const result = { presets: PRESETS.map(name => ({ preset: name, cleanup: { status: 'pass' }, scenarios: requiredScenarios(name).filter(id => name !== preset || id !== missing).map(id => ({ id, executed: true, status: 'pass' })) })) };
            assert.throws(() => validateQualification(result), /required scenario/);
        }
    }
    const report = status => ({ suites: [{ specs: ['catalog', 'access', 'patients', 'sources'].map(card => ({ title: `DEMO ${card} actual journey`, tests: ['desktop', 'mobile'].map(device => ({ projectName: `chromium-${device}`, results: [{ status }] })) })) }] });
    assert.equal(demoBrowserScenarios(report('passed')).filter(item => item.executed).length, 8);
    assert.throws(() => demoBrowserScenarios(report('skipped')), /DEMO browser required case/);
    assert.throws(() => demoBrowserScenarios(report('failed')), /DEMO browser/);
    const data = loadCiDataset();
    assert.equal(data.bundles[0].inspected.counts.Patient, 103);
    assert.equal(data.bundles[1].inspected.counts.Patient, 3);
    assert.ok(data.bundles.every(item => item.inspected.counts.Condition && item.inspected.counts.DiagnosticReport));
});

test('DEMO browser selection matches Playwright full titles while leaving ordinary workflows selected', () => {
    const { DEMO_BROWSER_GREP } = require('../scripts/full-coverage');
    const filter = new RegExp(DEMO_BROWSER_GREP);
    for (const card of ['catalog', 'access', 'patients', 'sources']) {
        assert.equal(filter.test(`chromium-desktop demo-${card}.spec.js DEMO ${card} actual journey`), true);
    }
    assert.equal(filter.test('chromium-desktop event-flow.spec.js Chromium completes consent approval'), false);
    assert.equal(filter.test('chromium-desktop source-change-form.spec.js source command component @smoke'), false);
});

test('actual DEMO sources select all four cards on desktop/mobile and reject missing coverage immediately', () => {
    const { DEMO_BROWSER_GREP, demoBrowserScenarios } = require('../scripts/full-coverage');
    const vm = require('node:vm');
    const specs = [];
    for (const card of ['catalog', 'access', 'patients', 'sources']) {
        const registered = [];
        vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, `../ui/tests/demo-${card}.spec.js`), 'utf8'), {
            process: { env: {} }, require(name) { return name === '@playwright/test' ? { test: title => registered.push(title) } : {}; }
        });
        assert.equal(registered.length, 1);
        assert.match(`chromium-desktop demo-${card}.spec.js ${registered[0]}`, new RegExp(DEMO_BROWSER_GREP));
        specs.push({ title: registered[0], tests: ['desktop', 'mobile'].map(device => ({ projectName: `chromium-${device}`, results: [{ status: 'passed' }] })) });
    }
    const report = { suites: [{ specs }] };
    assert.equal(demoBrowserScenarios(report).length, 8);
    for (const mutate of [value => value.suites[0].specs.pop(), value => { value.suites[0].specs[1].tests[0].results = []; },
        value => value.suites[0].specs[1].tests.push(value.suites[0].specs[1].tests[0])]) {
        const changed = structuredClone(report); mutate(changed); assert.throws(() => demoBrowserScenarios(changed), /DEMO browser required case/);
    }
    const { patientChoice } = require('../../src/sp-client/src/patient-choice');
    const synthetic = 'http://fhir.health.gov.il/identifier/il-hdp-test-id';
    const national = 'http://fhir.health.gov.il/identifier/il-national-id';
    assert.equal(patientChoice(`${national}|000000018`, synthetic, {}).system, national);
    assert.throws(() => patientChoice('000000018', synthetic, {}));
});

test('clinical Consent qualification requires independent desktop and mobile execution after private setup', () => {
    for (const mobile of ['passed', 'skipped']) {
        const report = { suites: [{ specs: [{ title: 'Chromium completes consent approval, discovery, and token-backed fetch', tests: [
            { projectName: 'chromium-desktop', results: [{ status: 'passed' }] },
            { projectName: 'chromium-mobile', results: [{ status: mobile }] }
        ] }] }] };
        const outcome = browserScenarios(report).find(item => item.id === 'doctor-consent-discovery-fetch');
        assert.equal(outcome.executed, mobile === 'passed');
    }
});
