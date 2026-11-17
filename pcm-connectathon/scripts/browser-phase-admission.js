'use strict';

/** Closed discovery/result admission for the browser phases already required by the full gate. */
const assert = require('node:assert/strict');
const coverage = require('./full-coverage');
const { reportTests } = require('./browser-report');
// This is the existing mandatory runtime closure, not every component fixture collected in testDir.
const runtimeTitles = ['batch38 current application owners', 'critical pages are responsive', 'completes consent approval', 'bounded Admin operator lifecycle', 'all three Admin upload forms',
    'simulation form applies preset defaults', 'cross-mode simulation requests', 'deployment navigation and both generated', 'Admin target counts preserve pending',
    'Doctor diagnostics preserves text', 'Doctor identity selection preserves labels', 'Explain this page covers', 'Explain this page works before Admin login',
    'Doctor negative identities reach the actual', 'Doctor live Consent and service transitions'];
const MAIN_RUNTIME_GREP = runtimeTitles.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const plans = Object.freeze([
    { name: 'demo', grep: coverage.DEMO_BROWSER_GREP },
    { name: 'main', grepInvert: coverage.DEMO_BROWSER_GREP },
    { name: 'workflow', workflow: true, candidate: true },
    { name: 'partial', workflow: true, partial: true, grep: 'PCM 0.4.0 failed source' },
    { name: 'candidate-partial', workflow: true, candidate: true, partial: true, grep: 'candidate 0.4.2 unavailable' },
    { name: 'test-workflow', workflow: true, candidate: true }
]);

/** Required discovery records carry no executed/pass claim; actual results must satisfy existing mappings. */
function admit(name, report, discovery = false, selectedKeys) {
    assert.ok(plans.some(plan => plan.name === name), 'unknown required browser phase');
    const allTests = reportTests(report);
    const tests = name === 'main' && discovery ? allTests.filter(row => new RegExp(MAIN_RUNTIME_GREP).test(row.key)) : allTests;
    const keys = tests.map(row => row.key).sort();
    if (name === 'main' && discovery) {
        report = structuredClone(report);
        const filter = suite => {
            suite.specs = (suite.specs || []).map(spec => ({ ...spec, tests: spec.tests.filter(test => new RegExp(MAIN_RUNTIME_GREP).test(`${spec.file}|${spec.title}|${test.projectName}`)) })).filter(spec => spec.tests.length);
            for (const child of suite.suites || []) filter(child);
        };
        for (const suite of report.suites || []) filter(suite);
    }
    assert.equal(new Set(keys).size, keys.length, 'duplicate browser identity'); assert.equal(report.errors?.length || 0, 0);
    if (selectedKeys) assert.deepEqual(keys, selectedKeys, 'actual browser selection changed after required discovery');
    if (discovery) assert.ok(tests.every(row => row.test.results.length === 0), 'discovery cannot claim test execution');
    else {
        assert.ok(tests.every(row => row.test.results.length > 0 && row.test.results.every(result => ['passed', 'skipped'].includes(result.status))), 'browser failure/retry is not acceptance');
        assert.equal(report.stats.unexpected, 0); assert.equal(report.stats.flaky, 0);
    }
    if (discovery) {
        // A statically skipped registration is inventoried but cannot supply required discovery.
        report = structuredClone(report);
        const removeSkipped = suite => {
            suite.specs = (suite.specs || []).map(spec => ({ ...spec, tests: spec.tests.filter(test => test.expectedStatus !== 'skipped') })).filter(spec => spec.tests.length);
            for (const child of suite.suites || []) removeSkipped(child);
        };
        for (const suite of report.suites || []) removeSkipped(suite);
    }
    const required = name === 'demo' ? coverage.demoBrowserScenarios(report, discovery)
        : name === 'main' ? coverage.browserScenarios(report, discovery)
            : name === 'partial' ? coverage.partialWorkflowBrowserScenarios(report, discovery)
                : name === 'candidate-partial' ? coverage.candidateBrowserScenarios(report, true, discovery)
                    : [...coverage.workflowBrowserScenarios(report, discovery), ...coverage.candidateBrowserScenarios(report, false, discovery)];
    assert.ok(required.every(row => discovery ? row.discovered : row.executed && row.status === 'pass'), `required ${name} browser coverage missing or skipped`);
    return { phase: name, discoveryOnly: discovery, selectedKeys: keys, required,
        deferredComponentKeys: name === 'main' && discovery ? allTests.filter(row => !keys.includes(row.key)).map(row => row.key).sort() : [],
        deferredComponentsAreNotPasses: true,
        // Nonrequired platform/fixture exclusions remain explicit; none supplies a required scenario pass.
        exclusions: tests.filter(row => discovery ? row.test.expectedStatus === 'skipped' : row.test.results.every(result => result.status === 'skipped'))
            .map(row => ({ key: row.key, annotations: row.test.annotations || [], expectedStatus: row.test.expectedStatus })) };
}

module.exports = { plans, admit, MAIN_RUNTIME_GREP };
