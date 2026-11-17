'use strict';
/** A source removed by concurrent polling cannot reappear through an in-flight Doctor fetch. */
const test = require('node:test'), assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const client = require('../src/client');
let stored, finish, finishDiscovery, resets = 0;
client.searchServices = async () => ({ services: [{ id: 'lab', available: true, signature: 'one' }], next: '', warnings: [], complete: true, pages: 1, used: { requests: 1, bytes: 1 } });
client.readOwnedService = async id => ({ id, available: true, signature: 'one' });
client.createConsentRequest = async () => structuredClone(stored);
client.searchConsents = async () => [structuredClone(stored)];
client.checkConsentStatus = () => finishDiscovery ? new Promise(resolve => { finishDiscovery = resolve; }) : Promise.resolve({ ...structuredClone(stored), discoveredEndpoints: [] });
client.resetCache = () => resets++;
client.fetchData = () => new Promise(resolve => { finish = resolve; });
const { app } = require('../src/index');
/** Invoke a route with an actual shared application state and capture the output projection. */
async function invoke(path, body = {}) {
    let output;
    const response = { redirect() {}, status(code) { this.code = code; return this; }, json(value) { output = { code: this.code, ...value }; }, render(_view, locals) { output = locals; } };
    await app._router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle({ body, query: { identity: 'hospital-a' }, get() { return 'application/json'; } }, response);
    return output;
}
test('source membership change clears projections and rejects a previous fetch completion', async () => {
    stored = { id: 'race', status: 'active', meta: { versionId: '2' }, patient: { identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' } },
        extension: [{ url: require('../../shared/pcm-contract').EXTENSIONS.pcmService, valueReference: { reference: 'HealthcareService/lab' } }], provision: { actor: [{ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: 'Organization/A' } }] } };
    await invoke('/create-consent', { serviceId: 'lab', serviceStamp: 'one', patientId: `${stored.patient.identifier.system}|1` });
    const beforeResets = resets;
    const pending = invoke('/fetch-data', { consentId: stored.id, requestedScope: 'patient/Observation.s', endpointUrl: 'https://source.example/fhir' });
    await new Promise(resolve => setImmediate(resolve));
    stored.provision.actor = []; stored.meta.versionId = '3'; await invoke('/');
    finish({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'old-source' } }] });
    const response = await pending; assert.equal(response.status, 'fail'); assert.match(response.error, /sources changed during retrieval/); assert.equal(response.data, undefined);
    assert.equal(resets, beforeResets + 1); const page = await invoke('/'); assert.equal(page.consents[0].data, null); assert.deepEqual(page.consents[0].consent.discoveredEndpoints, []);
});

for (const [name, selection] of [['patient', { patientId: '000000018', serviceId: 'lab' }], ['service', { patientId: '000000018', serviceId: 'other' }], ['source', { sourceConsentId: 'race' }], ['identity switch', { identityExit: true }]]) {
    test(`${name} selection fences an older fetch without restoring its data`, async () => {
        await invoke('/reset');
        stored.meta.versionId = '4';
        await invoke('/create-consent', { serviceId: 'lab', serviceStamp: 'one', patientId: `${stored.patient.identifier.system}|1` });
        const pending = invoke('/fetch-data', { consentId: stored.id, requestedScope: 'patient/Observation.s', endpointUrl: 'https://source.example/fhir' });
    await new Promise(resolve => setImmediate(resolve));
        await invoke('/selection', selection);
        finish({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'stale' } }] });
        const result = await pending;
        assert.equal(result.status, 'fail'); assert.equal(result.data, undefined);
        const page = await invoke('/'); assert.ok(page.consents.every(record => !record.data));
    });
}
test('a late failed fetch cannot erase the newer successful source result', async () => {
    await invoke('/reset');
    await invoke('/create-consent', { serviceId: 'lab', serviceStamp: 'one', patientId: `${stored.patient.identifier.system}|1` });
    const first = invoke('/fetch-data', { consentId: stored.id, requestedScope: 'patient/Observation.s', endpointUrl: 'https://old.example/fhir' });
    await new Promise(resolve => setImmediate(resolve));
    const oldFinish = finish;
    const second = invoke('/fetch-data', { consentId: stored.id, requestedScope: 'patient/Observation.s', endpointUrl: 'https://new.example/fhir' });
    await new Promise(resolve => setImmediate(resolve));
    finish({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'new' } }] });
    assert.equal((await second).status, 'success');
    oldFinish({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'old' } }] });
    assert.equal((await first).status, 'fail');
    assert.equal((await invoke('/')).consents[0].data.entry[0].resource.id, 'new');
});

test('late discovery cannot restore endpoints after a selection change', async () => {
    await invoke('/reset');
    await invoke('/create-consent', { serviceId: 'lab', serviceStamp: 'one', patientId: `${stored.patient.identifier.system}|1` });
    finishDiscovery = true;
    const pending = invoke('/discover', { consentId: stored.id });
    await new Promise(resolve => setImmediate(resolve));
    await invoke('/selection', { patientId: '000000018', serviceId: 'lab' });
    finishDiscovery({ ...structuredClone(stored), discoveredEndpoint: 'https://stale.example/fhir' });
    await pending; finishDiscovery = null;
    assert.equal((await invoke('/')).consents.length, 1);
    assert.equal((await invoke('/')).consents[0].consent.discoveredEndpoint, undefined);
});

test('refresh and another tab render the authoritative edited patient and service together', async () => {
    await invoke('/reset');
    await invoke('/selection', { patientId: '000000018', serviceId: 'lab' });
    let page = await invoke('/');
    assert.equal(page.selectedPatientId, 'http://fhir.health.gov.il/identifier/il-national-id|000000018');
    assert.equal(page.selectedServiceId, 'lab');
    await invoke('/selection', { patientId: '000000026', serviceId: 'other' });
    page = await invoke('/');
    assert.equal(page.selectedPatientId, 'http://fhir.health.gov.il/identifier/il-national-id|000000026');
    assert.equal(page.selectedServiceId, 'other');
});
