'use strict';
/** Concrete value help and escaped deployment row semantics. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseCatalog } = require('../../../scripts/generate-ui-help');
const values = require('../../shared/ui/help-values');
const { deploymentHelpKey, deploymentContext } = require('../src/deployment-help');
const { relaxedConsentSources } = require('../../shared/consent-presentation');
const catalog = parseCatalog(fs.readFileSync(require('node:path').resolve(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));

test('known log roles, severities and classes have specific authored help with safe unknown fallbacks', () => {
    for (const role of ['pcm', 'doctor', 'gateway', 'adapter', 'hapi-import', 'fhir']) assert.ok(catalog[values.component(role)]);
    for (const level of ['INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE', 'FATAL', 'UNKNOWN']) assert.ok(catalog[values.level(level)]);
    for (const category of ['system', 'security', 'harness', 'lifecycle', 'admin', 'noise', 'uncategorized']) assert.ok(catalog[values.category(category)]);
    assert.equal(values.component('__proto__'), 'logs.component');
    assert.equal(values.level('<script>bad</script>'), 'logs.level-unknown');
    assert.equal(values.category('constructor'), 'logs.class');
    assert.match(catalog[values.category('uncategorized')].body, /not itself an error/);
    assert.match(catalog[values.component('doctor')].body, /requesting Service Provider/);
});

test('deployment help explains service purpose and each concrete row field', () => {
    for (const [key, expected] of [['spClient', 'doctor'], ['pcmApi', 'pcm-api'], ['pcmMetadata', 'metadata'],
        ['ho-aGatewayPublic', 'gateway'], ['ho-aHapiInternal', 'hapi'], ['ho-aAdapterInternal', 'adapter']]) {
        const endpoint = { key, label: 'Synthetic service', audience: 'internal', url: 'https://ho-a:8443/fhir',
            scheme: 'https', host: 'ho-a', port: '8443', source: 'team-config' };
        assert.equal(deploymentHelpKey(endpoint), `admin.endpoint-${expected}`);
        for (const field of ['service', 'scope', 'url', 'scheme', 'host', 'port', 'source']) assert.ok(deploymentContext(endpoint, field));
        assert.match(deploymentContext(endpoint, 'host'), /private container network/);
        assert.match(deploymentContext(endpoint, 'scheme'), /client certificate/);
    }
});

test('retired Consent exceptions cannot produce a bypass disclosure', () => {
    assert.deepEqual(relaxedConsentSources({ simulation: { controls: { consentState: true }, perSource: {
        'ho-a': { consentState: false }, 'ho-b': { consentState: true } } } }), []);
    assert.deepEqual(relaxedConsentSources({ simulation: { controls: { consentState: false } } }), []);
});

test('import popup help explains fast accepted-import counts and deeper lost-response recovery', () => {
    assert.match(catalog['admin.data-import'].body, /every entry was accepted/);
    assert.match(catalog['admin.operation-verification'].body, /exact stored counts/);
    assert.match(catalog['admin.operation-verification'].body, /without downloading all resources/);
    const recovery = catalog['admin.recovery-verify'].body;
    assert.match(recovery, /confirmed success on an empty target/);
    assert.match(recovery, /source, dataset and target count checks/);
    assert.match(recovery, /response was lost or unsuccessful/);
    assert.match(recovery, /contents, references and history/);
    assert.match(recovery, /Failed checks keep the target blocked/);
});

/** Workbench additions must remain discoverable through authored explanations. */
test('all central Logs actions and exact filters bind to authored help', () => {
    const template = fs.readFileSync(require('node:path').join(__dirname, '../src/views/logs.ejs'), 'utf8');
    const html = require('ejs').render(template, { teamId: 'help-fixture', browserBase: '/pcm' });
    const controls = html.match(/<(?:button|a|input|select|textarea)\b[^>]*>/g);
    for (const control of controls) {
        if (control === '<input type="checkbox">') continue; // Explain toggle has a bound parent label.
        const key = control.match(/data-help-key="([^"]+)"/)?.[1];
        assert.ok(key, `Missing explanation for ${control}`);
        assert.ok(catalog[key], `Missing authored explanation ${key}`);
    }
});


test('visible service lifecycle help separates normative Contracts from the labelled sampling pair without retired controls', () => {
    const key = 'services.effect';
    const template = fs.readFileSync(require('node:path').join(__dirname, '../src/views/services.ejs'), 'utf8');
    const html = require('ejs').render(template, {
        teamId: 'help-fixture', browserBase: '/pcm', role: 'serviceProvider',
        providers: [{ role: 'serviceProvider', id: 'provider', name: 'Provider' }],
        templates: [], list: { owned: [], available: [], others: [] }, context: null, targets: [],
        error: '', warnings: [], nextPage: '', privateActionsUnavailable: false, formCsrf: 'fixture', ownerCsrf: () => 'fixture',
        units: {}, categoryLabels: {}, bucketResources: {}, sensitivityLabels: []
    });
    assert.match(html, /data-service-peer="catalog"/);
    assert.match(html, /<p data-help-key="services.effect">Clinical permissions and Patient\/source context are enforced in every security preset/);
    const generated = { window: {} };
    require('node:vm').runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../../shared/ui/help-copy.js'), 'utf8'), generated);
    const technical = catalog[key].technical;
    assert.equal(generated.window.PCM_HELP_COPY[key].technical, technical);
    assert.match(technical, /Normative system Contracts have no HealthcareService dependency/);
    assert.match(technical, /lifecycle, source membership and client entitlement remain required/);
    assert.match(technical, /labelled sandbox sampler keeps its separate Contract\/service pair/);
    assert.match(technical, /own lifecycle, source and client restrictions/);
    assert.equal(catalog['simulation.serviceState'], undefined);
    assert.equal(generated.window.PCM_HELP_COPY['simulation.serviceState'], undefined);
    assert.equal(require('../../shared/conformance-policy').SIMULATION_CONTROLS.includes('serviceState'), false);
});
