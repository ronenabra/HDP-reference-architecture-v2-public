'use strict';
/** Doctor presentation regression: even a mocked successful transport cannot manufacture PCM approval. */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const client = require('../src/client');
let stored;
client.createConsentRequest = async () => ({ ...stored });
client.fetchData = async () => ({ resourceType: 'Bundle', entry: [] });
client.readOwnedService = async () => ({ id: 'display-service', name: 'Display service', signature: 'v1', available: true, readiness: 'Ready' });
client.searchServices = async () => ({ services: [], complete: true, warnings: [] });
client.searchConsents = async () => [structuredClone(stored)];
const { app } = require('../src/index');

/** Invoke the existing application handler while capturing the rendered projection. */
async function invoke(path, body = {}) {
    const route = app._router.stack.find(layer => layer.route?.path === path).route;
    let result;
    await route.stack.at(-1).handle({ body, get() { return 'text/html'; }, query: { identity: 'hospital-a' } }, {
        redirect() {}, json(value) { result = value; }, render(_view, locals) { result = locals; }
    });
    return result;
}

test('successful data access preserves pending/rejected/active PCM status in Doctor cards', async () => {
    for (const status of ['proposed', 'rejected', 'active']) {
        stored = { id: `ordinary-${status}`, status, extension: [{ url: require('../../shared/pcm-contract').EXTENSIONS.pcmService, valueReference: { reference: 'HealthcareService/display-service' } }], patient: { identifier: {
            system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' } } };
        await invoke('/');
        await invoke('/fetch-data', { identity: 'hospital-a', consentId: stored.id, endpointUrl: 'https://source.test/fhir', requestedScope: 'patient/Observation.s' });
        const page = await invoke('/');
        const card = page.consents.find(record => record.id === stored.id);
        assert.equal(card.consent.status, status);
        assert.equal(card.testAutoApproved, false);
        assert.ok(card.data);
        assert.deepEqual(page.relaxedSources, []);
    }
});

test('offline picker retains fixed IDs and a labelled manual-review demonstration', async () => {
    const path = require('node:path');
    const ejs = require('ejs');
    const page = await invoke('/');
    const html = await ejs.renderFile(path.join(__dirname, '../src/views/index.ejs'), page);
    assert.match(html, /Name unknown \(ordinary demo patient\).*000000018/);
    assert.match(html, /Ordinary identifiers require review in PCM/);
    assert.match(html, /name="patientSystem"/);
    assert.match(html, /Israel Israelov/);
    assert.match(html, /id="patient-name"[^>]*[^<]*>Name unknown until a named choice is selected\./);
    assert.match(html, /Exact approved permissions and Patient\/source context apply in every preset/);
    assert.equal(page.patients.length, 3);
    assert.equal(require('../src/team-config').loadManagedPatients, undefined);
});
