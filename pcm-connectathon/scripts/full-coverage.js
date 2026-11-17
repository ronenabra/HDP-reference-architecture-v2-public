'use strict';
/** Closed, dataset-backed acceptance contract for local full qualification. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PRESETS } = require('../../src/shared/conformance-policy');
const { inspectTransactionBundle } = require('../../clinical-data/transaction-bundle');
const HOS = ['ho-a', 'ho-b', 'ho-c'];
// Playwright grep evaluates project/file/suite prefixes together with the short test title.
const DEMO_BROWSER_GREP = '\\bDEMO (?:catalog|access|patients|sources) ';

function requiredScenarios(preset) {
    return [
        ...demoRequiredScenarios(preset),
        ...candidateRequiredScenarios(),
        '042-signing-key-selection', '042-metadata-aliases', '042-smart-get-post', '042-contract-membership-projection',
        ...HOS.flatMap(ho => [`gateway-clinical-page-${'enforced'}-${ho}`, `gateway-clinical-total-${'enforced'}-${ho}`, ...['type', 'instance'].map(form => `gateway-clinical-everything-${'enforced'}-${ho}-${form}`)]),
        'fresh-empty-bootstrap', 'browser-batch38-current-owners',
        'hapi-authorized-counts',
        ...HOS.map(id => `gateway-clinical-count-${id}`),
        ...HOS.map(id => `gateway-clinical-count-positive-${id}`),
        ...HOS.map(id => `inventory-${id}`),
        ...HOS.map(id => `gateway-${id}`),
        'doctor-consent-discovery-fetch', 'browser-admin-maintenance', 'browser-three-ho-uploads',
        'browser-simulation-controls', 'browser-mode-boundary', 'browser-deployment-docs', 'browser-private-count-states',
        'browser-doctor-diagnostics', 'browser-doctor-identities', 'browser-lifecycle-invalidation', 'browser-doctor-negative-identities',
        'browser-help-pages', 'browser-help-authentication',
        'browser-system-workflows-desktop', 'browser-system-workflows-mobile',
        'browser-partial-workflows-desktop', 'browser-partial-workflows-mobile',
        'system-client-clinical-privilege-denied', 'logs-consent-access', 'logs-presence-check', 'logs-patient-authentication', 'logs-dependent-discovery',
        ...(preset === 'connectathon-easy' ? [] : ['hapi-authentication-projection', ...HOS.map(id => `hapi-discovery-${id}`)]),
        ...(preset === 'connectathon-easy' ? [] : ['hapi-authorized-results', 'token-assertion-boundary']),
        ...(preset === 'strict' ? ['gateway-token-expiry', 'strict-production-endpoints-lifetimes', 'strict-test-endpoints-lifetimes', 'strict-test-workflows'] : []),
        'browser-chromium-desktop', 'browser-chromium-mobile', 'browser-firefox-smoke', 'browser-webkit-smoke',
        ...(preset === 'strict' ? [] : ['legacy-compatibility'])
    ];
}

/** Verify dataset hashes and actionable patients before any disposable runtime is created. */
function loadCiDataset(manifestPath = path.resolve(__dirname, '../../clinical-data/demo-qualification/manifest.json')) {
    const bytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(bytes);
    if (manifest.schemaVersion !== 'pcm-ci-dataset/1' || manifest.bundles?.length !== 3) throw new Error('required three-HO CI dataset manifest is invalid');
    const root = path.dirname(manifestPath);
    const bundles = HOS.map(serverId => {
        const item = manifest.bundles.find(bundle => bundle.serverId === serverId);
        if (!item || path.basename(item.file) !== item.file) throw new Error(`required CI bundle mapping is missing for ${serverId}`);
        const inspected = inspectTransactionBundle(fs.readFileSync(path.join(root, item.file)));
        if (inspected.sha256 !== item.sha256 || inspected.source !== item.source || !inspected.patients.length || !inspected.counts.Observation) throw new Error(`required CI dataset hash/source/actionable inventory failed for ${serverId}`);
        return { ...item, inspected };
    });
    return { root, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bundles };
}

/** Require observed passing scenarios for every preset, including successful scoped cleanup. */
function validateQualification(result) {
    for (const preset of PRESETS) {
        const run = result.presets?.find(item => item.preset === preset);
        if (!run) throw new Error(`required preset is missing: ${preset}`);
        if (run.cleanup?.status !== 'pass') throw new Error(`required cleanup failed for ${preset}`);
        for (const id of requiredScenarios(preset)) {
            const scenario = run.scenarios?.find(item => item.id === id);
            if (!scenario?.executed || scenario.status !== 'pass') throw new Error(`required scenario did not pass: ${preset}/${id}`);
        }
    }
    return true;
}

/** Read actual Playwright results; the required Consent journey must execute on desktop and mobile. */
function browserScenarios(report, discovery = false) {
    const specs = [];
    const walk = suite => { specs.push(...(suite.specs || [])); for (const child of suite.suites || []) walk(child); };
    for (const suite of report.suites || []) walk(suite);
    if (report.errors?.length || specs.some(spec => spec.tests.some(test => test.results.some(result => ['failed', 'timedOut', 'interrupted'].includes(result.status))))) throw new Error('required browser qualification failed');
    const passed = (title, projectName) => specs.some(spec => spec.title.includes(title) && spec.tests.some(test => test.projectName === projectName && (discovery || test.results.some(result => result.status === 'passed'))));
    return [
        ...(specs.some(spec => spec.title.startsWith('batch38 current application owners')) ? [{ id: 'browser-batch38-current-owners', executed: ['chromium-desktop', 'chromium-mobile'].every(project => passed('batch38 current application owners', project)) }] : []),
        { id: 'doctor-consent-discovery-fetch', executed: ['chromium-desktop', 'chromium-mobile'].every(project => passed('completes consent approval', project)) },
        { id: 'browser-admin-maintenance', executed: passed('bounded Admin operator lifecycle', 'chromium-desktop') },
        { id: 'browser-three-ho-uploads', executed: passed('all three Admin upload forms', 'chromium-desktop') },
        { id: 'browser-simulation-controls', executed: passed('simulation form applies preset defaults', 'chromium-desktop') },
        { id: 'browser-mode-boundary', executed: passed('cross-mode simulation requests', 'chromium-desktop') },
        { id: 'browser-deployment-docs', executed: passed('deployment navigation and both generated', 'chromium-desktop') },
        { id: 'browser-private-count-states', executed: passed('Admin target counts preserve pending', 'chromium-desktop') },
        { id: 'browser-doctor-diagnostics', executed: passed('Doctor diagnostics preserves text', 'chromium-desktop') },
        { id: 'browser-doctor-identities', executed: passed('Doctor identity selection preserves labels', 'chromium-desktop') },
        { id: 'browser-help-pages', executed: ['Admin', 'Admin logs', 'Doctor', 'Doctor patient library', 'Doctor management', 'Doctor logs', 'PCM consent', 'PCM central logs']
            .every(name => passed(`Explain this page covers ${name} without mutations`, 'chromium-desktop')) },
        { id: 'browser-help-authentication', executed: passed('Explain this page works before Admin login', 'chromium-desktop') },
        { id: 'browser-doctor-negative-identities', executed: passed('Doctor negative identities reach the actual', 'chromium-desktop') },
        { id: 'browser-lifecycle-invalidation', executed: passed('Doctor live Consent and service transitions', 'chromium-desktop') },
        ...['chromium-desktop', 'chromium-mobile', 'firefox-smoke', 'webkit-smoke'].map(project => ({ id: `browser-${project}`, executed: passed('critical pages are responsive', project) }))
    ].map(item => discovery ? ({ id: item.id, discovered: item.executed }) : ({ ...item, status: item.executed ? 'pass' : 'missing' }));
}
module.exports = { DEMO_BROWSER_GREP, browserScenarios, loadCiDataset, requiredScenarios, validateQualification };


/** Require actual desktop and mobile results from the separate workflow fixture phase. */
function workflowBrowserScenarios(report, discovery = false) {
    const specs = [];
    const walk = suite => { specs.push(...(suite.specs || [])); for (const child of suite.suites || []) walk(child); };
    for (const suite of report.suites || []) walk(suite);
    if (report.errors?.length || specs.some(spec => spec.tests.some(test => test.results.some(result => ['failed', 'timedOut', 'interrupted'].includes(result.status))))) throw new Error('required workflow browser qualification failed');
    return ['desktop', 'mobile'].map(device => {
        const executed = specs.some(spec => spec.title.startsWith('PCM 0.4.0 home-HMO OTP and dependent discovery')
            && spec.tests.some(test => test.projectName === `chromium-${device}` && (discovery || test.results.some(result => result.status === 'passed'))));
        return discovery ? { id: `browser-system-workflows-${device}`, discovered: executed } : { id: `browser-system-workflows-${device}`, executed, status: executed ? 'pass' : 'missing' };
    });
}
module.exports.workflowBrowserScenarios = workflowBrowserScenarios;


/** Require both devices to observe a real failed source without losing retained knowledge. */
function partialWorkflowBrowserScenarios(report, discovery = false) {
    const specs = [];
    const walk = suite => { specs.push(...(suite.specs || [])); for (const child of suite.suites || []) walk(child); };
    for (const suite of report.suites || []) walk(suite);
    if (report.errors?.length || specs.some(spec => spec.tests.some(test => test.results.some(result => ['failed', 'timedOut', 'interrupted'].includes(result.status))))) throw new Error('required partial workflow browser qualification failed');
    return ['desktop', 'mobile'].map(device => {
        const executed = specs.some(spec => spec.title.startsWith('PCM 0.4.0 failed source preserves known presence')
            && spec.tests.some(test => test.projectName === `chromium-${device}` && (discovery || test.results.some(result => result.status === 'passed'))));
        if (!executed) throw new Error(`required partial workflow browser did not execute: ${device}`);
        return discovery ? { id: `browser-partial-workflows-${device}`, discovered: executed } : { id: `browser-partial-workflows-${device}`, executed, status: 'pass' };
    });
}
module.exports.partialWorkflowBrowserScenarios = partialWorkflowBrowserScenarios;

/** Accepted DEMO cards require real matrix and desktop/mobile application execution in every preset. */
function demoRequiredScenarios(preset) {
    const strict = preset === 'strict';
    return [
        ...['lab-follow-up', 'medication-reconciliation', 'longitudinal-summary', 'procedure-follow-up'].map(id => `demo-catalog-${id}`),
        'demo-access-ordinary-restricted', 'demo-access-explicit-broad-approval-and-native-isolation', 'demo-access-retired-flags-rejected',
        ...(strict ? ['demo-patients-sampler-denied', 'demo-patients-forged-guid-consent-denied', 'demo-sources-strict-command-denied'] : [
            ...['bounded-sample', 'manual-guid-consent', 'exact-rar-introspection', 'native-guid-observation', 'other-patient-source-denied'].map(id => `demo-patients-${id}`),
            'demo-sources-ordinary-a-add-b-remove-a-empty', 'demo-sources-explicit-broad-a-add-b-remove-a-empty'
        ]),
        ...['catalog', 'access', 'patients', 'sources'].flatMap(card => ['desktop', 'mobile'].map(device => `browser-demo-${card}-${device}`))
    ];
}
/** Require actual passing DEMO browser cases; omitted, skipped or failed required cases are never acceptance. */
function demoBrowserScenarios(report, discovery = false) {
    const specs = [];
    const walk = suite => { specs.push(...(suite.specs || [])); for (const child of suite.suites || []) walk(child); };
    for (const suite of report.suites || []) walk(suite);
    if (report.errors?.length || specs.some(spec => spec.tests.some(test => test.results.some(result => ['failed', 'timedOut', 'interrupted'].includes(result.status))))) throw new Error('DEMO browser qualification failed');
    const required = ['catalog', 'access', 'patients', 'sources'].flatMap(card => ['desktop', 'mobile'].map(device => {
        const matches = specs.flatMap(spec => spec.title.startsWith(`DEMO ${card} `)
            ? spec.tests.filter(test => test.projectName === `chromium-${device}`) : []);
        if (matches.length !== 1 || (!discovery && (matches[0].results.length !== 1 || matches[0].results[0].status !== 'passed'))) {
            throw new Error(`DEMO browser required case missing, skipped or ambiguous: ${card}/${device}`);
        }
        return discovery ? { id: `browser-demo-${card}-${device}`, discovered: true } : { id: `browser-demo-${card}-${device}`, executed: true, status: 'pass' };
    }));
    return required;
}
module.exports.demoRequiredScenarios = demoRequiredScenarios;
module.exports.demoBrowserScenarios = demoBrowserScenarios;

/** Exact candidate browser cases must execute in both viewports, including stopped-source proof. */
function candidateRequiredScenarios() {
    return ['sso', 'eligibility', 'htest', 'presence-sampling', 'partial'].flatMap(name => ['desktop', 'mobile'].map(device => `browser-042-${name}-${device}`));
}
function candidateBrowserScenarios(report, partial = false, discovery = false) {
    const specs = [];
    const walk = suite => { specs.push(...(suite.specs || [])); for (const child of suite.suites || []) walk(child); };
    for (const suite of report.suites || []) walk(suite);
    const titles = partial ? { partial: 'candidate 0.4.2 unavailable source' } : {
        sso: 'candidate 0.4.2 SSO is independent', eligibility: 'candidate 0.4.2 Palestinian',
        htest: 'candidate 0.4.2 normative login rejects', 'presence-sampling': 'candidate 0.4.2 Israeli OTP' };
    return Object.entries(titles).flatMap(([name, title]) => ['desktop', 'mobile'].map(device => {
        const executed = specs.some(spec => spec.title.startsWith(title) && spec.tests.some(test => test.projectName === `chromium-${device}` && (discovery || test.results.some(result => result.status === 'passed')) && (discovery || test.results.every(result => result.status === 'passed'))));
        return discovery ? { id: `browser-042-${name}-${device}`, discovered: executed } : { id: `browser-042-${name}-${device}`, executed, status: executed ? 'pass' : 'missing' };
    }));
}
module.exports.candidateRequiredScenarios = candidateRequiredScenarios;
module.exports.candidateBrowserScenarios = candidateBrowserScenarios;
