'use strict';

/** Focused real Doctor handler/form checks with the participant boundary stubbed. */
const test = require('node:test'), assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const { doctorPublicFixture } = require('../../../test-support/doctor-public-fixture');
const fixture = doctorPublicFixture(), client = require('../src/client');
let sent = [];
client.checkConsentStatus = async () => structuredClone(fixture.consent);
client.readOwnedService = async () => ({ id: fixture.instance.id, instance: fixture.instance, definition: fixture.canonical,
    signature: 'stable', available: true, readiness: 'Ready' });
client.resetCache = () => {};
client.fetchData = async (...args) => {
    sent.push(args);
    return { resourceType: 'Bundle', total: 42, preview: { requestOverride: args[4] } };
};
const { app } = require('../src/index');

/** Invoke one real route and collect its JSON response without a listening server. */
async function invoke(route, body) {
    const result = {};
    await app._router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle({
        body: { identity: 'hospital-a', ...body }, get: () => 'application/json'
    }, { status(code) { result.status = code; return this; }, json(value) { result.body = value; }, redirect() {} });
    return result;
}

test('fetch route forwards the exact optional GET override and rejects malformed input', async () => {
    const body = { consentId: fixture.consent.id, endpointUrl: 'https://source.example/fhir', requestedScope: 'patient/Observation.s' };
    for (const path of ['/Observation?_summary=count', '/Patient?name=a%20b&name=c+d', '']) {
        const result = await invoke('/fetch-data', { ...body, fhirGetRequest: path });
        assert.equal(result.status, 200);
        assert.deepEqual(sent.at(-1), [body.consentId, body.endpointUrl, 'hospital-a', body.requestedScope, path]);
    }
    sent = [];
    for (const fhirGetRequest of ['Patient', [' /Patient']]) {
        const result = await invoke('/fetch-data', { ...body, fhirGetRequest });
        assert.equal(result.status, 400); assert.match(result.body.error, /must start with/);
    }
    assert.equal(sent.length, 0);
});

test('stored Consent renders an optional example placeholder, custom response and matching Explain copy', () => {
    const { render } = require('../../../test-support/doctor-ux-render');
    const { approvalPresentation } = require('../src/approval-presentation');
    const { parseCatalog } = require('../../../scripts/generate-ui-help');
    const fs = require('node:fs'), path = require('node:path');
    const initial = render();
    assert.match(initial, /name="fhirGetRequest"[^>]*value=""[^>]*placeholder="\/Patient or \/Observation\?_summary=count"[^>]*pattern="\/\.\*"/);
    assert.doesNotMatch(initial.match(/<input[^>]*name="fhirGetRequest"[^>]*>/)[0], /required/);
    const html = render(undefined, 'active', { consents: [{ id: fixture.consent.id, consent: fixture.consent,
        service: { available: true }, approval: approvalPresentation(fixture.consent), fhirGetRequest: '/Observation?_summary=count',
        data: { resourceType: 'Bundle', total: 42, preview: { requestOverride: '/Observation?_summary=count', actions: [{ path: '/Observation?_summary=count' }] } } }] });
    assert.match(html, /GET \/Observation\?_summary=count/);
    assert.match(html, /reported total: 42/);
    assert.doesNotMatch(html, /First-page preview ·|0 records shown|Up to 10\/type/);
    const catalog = parseCatalog(fs.readFileSync(path.resolve(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));
    assert.match(catalog['doctor.fhir-get'].body, /Start with \/.*Exact target address/);
    assert.match(html, /data-help-key="doctor.fhir-get"/);
    assert.match(html, /data-help-key="doctor.request-overrides"/);
});
