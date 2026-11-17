'use strict';
/** Focused real Doctor route state tests, with ordinary transport mocked at its explicit boundary. */
const test = require('node:test'), assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const client = require('../src/client');
const { EXTENSIONS } = require('../../shared/pcm-contract');
let services, exact, remote, writes, finish, resets, holdService, finishService, limitedFetch, submittedPatients, diagnosticReads, createFailure, searchFailure;
client.searchServices = async () => { if (searchFailure) throw new Error(searchFailure); return ({ services: structuredClone(services), next: '', complete: true, warnings: [], pages: 1, used: { bytes: 100, requests: 1 } }); };
client.readOwnedService = async id => {
    if (holdService) await new Promise(resolve => { finishService = resolve; });
    if (exact instanceof Error) throw exact;
    if (!exact || id !== exact.id) throw new Error('Choose a provider registration owned by this application');
    return structuredClone(exact);
};
client.searchConsents = async () => structuredClone(remote);
client.createConsentRequest = async (_patientId, id) => {
    if (createFailure) throw new Error(createFailure);
    submittedPatients.push(_patientId); writes.push(id); return structuredClone(remote[0]);
};
client.checkConsentStatus = async (id, identity) => { diagnosticReads.push({ id, identity }); return structuredClone(remote[0]); };
client.fetchData = () => limitedFetch ? Promise.reject(Object.assign(new Error('Individual record reads need known IDs; this preview requires search.'), { classification: 'read_only_limitation' })) : new Promise(resolve => { finish = resolve; });
client.resetCache = identity => resets.push(identity);
const { app, _test } = require('../src/index');
/** Invoke the actual handler and preserve its rendered projections. */
async function invoke(path, body = {}, identity = 'hospital-a') {
    let output;
    const response = { redirect() {}, status(code) { this.code = code; return this; }, json(value) { output = { code: this.code, ...value }; }, send(value) { output = { code: this.code, error: value }; }, render(_view, locals) { output = locals; } };
    await app._router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle({ body: { identity, ...body }, query: { identity }, get: name => name === 'accept' ? 'application/json' : 'remote.example:3100' }, response);
    return output;
}
/** Reset only this disposable dashboard state. */
async function setup() {
    limitedFetch = false; createFailure = ''; searchFailure = ''; resets = []; writes = []; submittedPatients = []; diagnosticReads = []; await invoke('/reset');
    exact = { id: 'mine', signature: 'version1', available: true, readiness: 'Ready to request', name: 'Owned service' }; services = [exact];
    remote = [{ resourceType: 'Consent', id: 'consent', status: 'active', patient: { identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' } },
        extension: [{ url: EXTENSIONS.pcmService, valueReference: { reference: 'HealthcareService/mine' } }] }];
    await invoke('/');
}

test('Consent submission revalidates exact owned instance and rejects catalog, foreign, stale and pending choices', async () => {
    await setup();
    for (const body of [{ serviceId: 'catalog', serviceStamp: 'version1' }, { serviceId: 'foreign', serviceStamp: 'version1' }, { serviceId: 'mine', serviceStamp: 'old' }, { serviceId: 'mine' }]) {
        await invoke('/create-consent', { patientId: '000000018', ...body }); assert.equal(writes.length, 0);
    }
    exact.available = false; await invoke('/create-consent', { patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' }); assert.equal(writes.length, 0);
    exact.available = true; await invoke('/');
    await invoke('/create-consent', { patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' }); assert.deepEqual(writes, ['mine']);
});

test('rendered current service stamp submits unchanged and a stale form still fails actual revalidation', async () => {
    await setup(); exact.signature = 'a'.repeat(64); services = [exact]; await invoke('/services/refresh');
    const { doctorServiceSelection } = require('../../../pcm-connectathon/scripts/sanity-data-state');
    const view = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/views/index.ejs'), 'utf8');
    const config = { serviceCatalog: { bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'mine' }] } };
    const selection = doctorServiceSelection(require('ejs').render(view, await invoke('/')), config, 'hospital-a');
    exact.signature = 'b'.repeat(64);
    await invoke('/create-consent', { patientId: '000000018', ...selection }); assert.deepEqual(writes, []);
    services = [exact]; await invoke('/services/refresh');
    const current = doctorServiceSelection(require('ejs').render(view, await invoke('/')), config, 'hospital-a');
    await invoke('/create-consent', { patientId: '000000018', ...current }); assert.deepEqual(writes, ['mine']);
});

test('current successful creation feedback is distinct from an error quoting the same message', async () => {
    await setup();
    const { doctorConsentCreated } = require('../../../pcm-connectathon/scripts/sanity-data-state');
    const view = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/views/index.ejs'), 'utf8');
    await invoke('/create-consent', { patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' });
    const page = await invoke('/');
    assert.deepEqual(writes, ['mine']); assert.equal(page.consents[0].id, remote[0].id);
    const success = { statusCode: 200, body: require('ejs').render(view, page) };
    assert.equal(doctorConsentCreated(success), true);
    for (const response of [{ ...success, statusCode: 500 }, { ...success, error: 'redirect failed' },
        { ...success, body: success.body.replace('Consent request created.', 'Consent Request Created') },
        { ...success, body: success.body + success.body }, { statusCode: 200, body: 'Consent request created.' }]) {
        assert.equal(doctorConsentCreated(response), false);
    }
    try {
        createFailure = page.flash.message;
        await invoke('/create-consent', { patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' });
        const failed = await invoke('/');
        assert.equal(failed.flash.type, 'error');
        const body = require('ejs').render(view, failed);
        assert.match(body, /Consent request created\./);
        assert.equal(doctorConsentCreated({ statusCode: 200, body }), false);
        assert.deepEqual(writes, ['mine']);
    } finally { createFailure = ''; }
});

test('manual diagnostic refresh preserves negative identity and does not require or borrow an owned service', async () => {
    await setup(); remote = []; exact = new Error('Diagnostic identity has no provider registration');
    for (const identity of ['untrusted', 'untrusted-assertion']) {
        const id = require('node:crypto').randomUUID();
        await invoke('/discover', { consentId: id }, identity);
        assert.deepEqual(diagnosticReads.at(-1), { id, identity });
        const page = await invoke('/', {}, identity);
        assert.equal(page.flash.type, 'warning'); assert.match(page.flash.message, /Consent not found/);
        assert.equal(page.consents.length, 0); assert.deepEqual(writes, []);
    }
});

test('picker changes preserve stored Consent patient/service/status and off-page exact resolution', async () => {
    await setup(); services = []; await invoke('/services/refresh');
    await invoke('/selection', { patientId: '000000026', serviceId: 'other' });
    const page = await invoke('/');
    assert.equal(page.consents.length, 1); assert.equal(page.consents[0].service.id, 'mine');
    assert.equal(page.consents[0].consent.status, 'active'); assert.equal(page.consents[0].consent.patient.identifier.value, '000000018');
    assert.equal(page.services.length, 0); assert.equal(page.consents[0].service.available, true);
});

test('refresh/version loss and transient exact-read failure fence late fetches without deleting Consent history', async () => {
    await setup();
    for (const change of ['refresh', 'version', 'transient', 'missing']) {
        exact = { id: 'mine', signature: 'version1', available: true, readiness: 'Ready' }; await invoke('/');
        const pending = invoke('/fetch-data', { consentId: 'consent', requestedScope: 'patient/Observation.s', endpointUrl: 'https://source.example/fhir' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof finish, 'function');
        const release = finish; finish = null;
        if (change === 'refresh') await invoke('/services/refresh');
        else { exact = change === 'transient' ? new Error('503 temporary') : { ...exact, signature: 'version2', available: change !== 'missing' }; await invoke('/'); }
        release({ resourceType: 'Bundle', entry: [] });
        const result = await pending; assert.equal(result.status, 'fail', change); assert.equal(result.data, undefined);
        assert.equal((await invoke('/')).consents.length, 1);
    }
    assert.ok(resets.every(identity => identity === undefined || identity === 'hospital-a'));
});

test('unresolved manual fetch has no Observation fallback and management is provider/remote-host bound', async () => {
    await setup();
    const result = await invoke('/fetch-data', { consentId: 'consent', endpointUrl: 'https://source.example/fhir' });
    assert.equal(result.status, 'fail'); assert.match(result.error, /no fallback/);
    const req = { protocol: 'http', get: name => name === 'host' ? 'remote.example:3100' : '', app: { get: () => () => false } };
    assert.match(_test.manageServicesUrl('hospital-a', req), /remote.example.*\/admin\/services\?providerRole=serviceProvider$/);
    assert.match(_test.manageServicesUrl('hospital-b', req), /providerRole=hospitalBServiceProvider$/);
    assert.equal(_test.manageServicesUrl('untrusted', req), '');
});

test('supported intentional query edits survive service refresh independently of the picker; unsupported edits require review', async () => {
    await setup(); await invoke('/reset');
    const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
    const fixture = clinicalTokenFixture({ scope: `patient/Patient.rs?${V} patient/Observation.s?${V} patient/Condition.r?${V}` });
    remote = [fixture.consent]; exact = { id: fixture.service.id, signature: 'version1', available: true, readiness: 'Ready', permissions: require('../src/permission-plan').servicePermissions(require('../../../test-support/doctor-public-fixture').doctorPublicFixture().canonical) }; services = [exact];
    await invoke('/');
    await invoke('/selection', { sourceConsentId: fixture.consent.id, requestedScope: 'patient/Observation.s' });
    let page = await invoke('/');
    assert.equal(page.consents[0].approval.queryScope, 'patient/Observation.s');
    assert.equal(page.consents[0].approval.plan.searches[0].type, 'Observation');
    await invoke('/selection', { serviceId: 'other-service', patientId: '000000026' });
    exact.signature = 'version2'; await invoke('/services/refresh'); page = await invoke('/');
    assert.equal(page.consents[0].approval.queryScope, 'patient/Observation.s');
    assert.equal(page.consents[0].approval.grant, null); assert.equal(page.consents[0].approval.message, 'Intended retrieval selection. Granted permissions not yet obtained.'); assert.equal(page.consents[0].data, null);
    await invoke('/selection', { sourceConsentId: fixture.consent.id, requestedScope: 'patient/Observation.s?unqualified=manual' });
    page = await invoke('/');
    assert.equal(page.consents[0].approval.queryScope, 'patient/Observation.s?unqualified=manual');
    assert.equal(page.consents[0].approval.plan, undefined);
    assert.equal(page.consents[0].approval.grant, null); assert.equal(page.consents[0].approval.message, 'Intended retrieval selection. Granted permissions not yet obtained.');
});

test('read-only-only preview is a visible limitation, not a failed or empty successful search', async () => {
    await setup();
    limitedFetch = true;
    try {
        const result = await invoke('/fetch-data', { consentId: 'consent', endpointUrl: 'https://source.example/fhir', requestedScope: 'patient/Observation.r' });
        assert.equal(result.code, 422); assert.equal(result.status, 'limited'); assert.equal(result.classification, 'read_only_limitation');
        const page = await invoke('/'); assert.equal(page.consents[0].data, null); assert.equal(page.flash.type, 'warning');
        assert.match(page.flash.message, /no source request sent/); assert.match(page.consents[0].fetchOutcome, /Read-only limitation/);
    } finally { limitedFetch = false; }
});

test('selection/source edits while exact service revalidation is pending fence discovery and fetch', async () => {
    for (const action of ['/discover', '/fetch-data']) {
        await setup(); holdService = true;
        const pending = invoke(action, { consentId: 'consent', requestedScope: 'patient/Observation.s', endpointUrl: 'https://source.example/fhir' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof finishService, 'function');
        await invoke('/selection', { sourceConsentId: 'consent' });
        holdService = false; finishService(); await pending;
        const page = await invoke('/'); assert.equal(page.consents[0].data, null); assert.equal(page.consents[0].consent.discoveredEndpoint, undefined);
    }
});

test('actual manual-card render requires resolving the Consent before enabling retrieval', async () => {
    await setup();
    const locals = await invoke('/');
    const html = require('ejs').render(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/views/index.ejs'), 'utf8'), locals);
    const manual = html.slice(html.indexOf('<!-- MANUAL SANDBOX CARD -->'));
    assert.match(manual, /Refresh status and sources for an exact Consent ID/);
    assert.match(manual, /<button[^>]*disabled[^>]*>\s*Fetch data/);
    assert.doesNotMatch(manual, /patient\/Observation/);
});


test('chosen patient then manual type/value edits submit one validated exact identity and isolate providers', async () => {
    await setup();
    const national = 'http://fhir.health.gov.il/identifier/il-national-id', synthetic = 'http://fhir.health.gov.il/identifier/il-hdp-test-id';
    let selected = await invoke('/selection', { patientId: `${synthetic}|1`, serviceId: 'mine' });
    assert.equal(selected.patient.automaticTestApproval, true);
    selected = await invoke('/selection', { patientId: ' 000000018 ', patientSystem: national, serviceId: 'mine' });
    assert.equal(selected.patient.value, '000000018'); assert.equal(selected.patient.automaticTestApproval, false);
    assert.equal(writes.length, 0);
    await invoke('/create-consent', { patientId: ' 000000018 ', patientSystem: national, serviceId: 'mine', serviceStamp: 'version1' });
    assert.equal(submittedPatients.at(-1), `${national}|000000018`);
    await invoke('/create-consent', { patientId: '2', patientSystem: synthetic, serviceId: 'mine', serviceStamp: 'version1' });
    assert.equal(submittedPatients.at(-1), `${synthetic}|2`);
    const count = writes.length;
    for (const [patientId, patientSystem] of [['2', national], ['000000019', national], ['urn:unknown|1', synthetic]]) {
        const validation = await invoke('/selection', { patientId, patientSystem, serviceId: 'mine' });
        assert.match(validation.patientError, /Check the identifier value|System URI is unsupported/);
        await invoke('/create-consent', { patientId, patientSystem, serviceId: 'mine', serviceStamp: 'version1' });
    }
    assert.equal(writes.length, count);
    await invoke('/selection', { patientId: `${national}|000000026`, serviceId: 'provider-b-service' }, 'hospital-b');
    assert.equal((await invoke('/')).selectedServiceId, 'mine');
    assert.equal((await invoke('/')).consents[0].consent.patient.identifier.value, '000000018');
});


test('library Use patient preserves the selected service and never creates Consent', async () => {
    await setup(); await invoke('/selection', { patientId: '000000018', serviceId: 'mine' });
    const before = writes.length;
    await invoke('/patients/select', { patientId: 'http://fhir.health.gov.il/identifier/il-hdp-test-id|2' });
    const page = await invoke('/');
    assert.equal(page.selectedPatientId, 'http://fhir.health.gov.il/identifier/il-hdp-test-id|2');
    assert.equal(page.selectedServiceId, 'mine'); assert.equal(writes.length, before);
    assert.equal(page.consents[0].consent.patient.identifier.value, '000000018');
});


test('one refreshed exact service updates every historical card for that association before fetch', async () => {
    await setup();
    remote.push({ ...structuredClone(remote[0]), id: 'second-same-service' });
    let page = await invoke('/'); assert.ok(page.consents.every(card => card.serviceProjection.signature === 'version1'));
    exact.signature = 'version2'; page = await invoke('/');
    assert.equal(page.consents.length, 2); assert.ok(page.consents.every(card => card.serviceProjection.signature === 'version2'));
    const pending = invoke('/fetch-data', { consentId: 'second-same-service', requestedScope: 'patient/Observation.s', endpointUrl: 'https://source.example/fhir' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function');
    finish({ resourceType: 'Bundle', entry: [] }); const result = await pending;
    assert.equal(result.status, 'success'); page = await invoke('/');
    assert.equal(page.consents.find(card => card.id === 'second-same-service').data.resourceType, 'Bundle');
});


test('stale library sample generation cannot restore a former patient selection', async () => {
    await setup(); await invoke('/selection', { patientId: '000000018', serviceId: 'mine' });
    const stale = await invoke('/patients/select', { patientId: 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id|C0FFEE00-1234-5678-9ABC-ABCDEF012345', sampleGeneration: 'obsolete' });
    assert.equal(stale.code, 400); assert.match(stale.error, /sample changed/);
    const page = await invoke('/'); assert.match(page.selectedPatientId, /000000018$/); assert.equal(page.selectedServiceId, 'mine'); assert.equal(writes.length, 0);
});


test('failed refresh stays stale for creation despite later successful exact service revalidation', async () => {
    await setup();
    const list = await invoke('/');
    // This real list owner failure path is supplied by the route fixture loader.
    searchFailure = '503 service search failed';
    await invoke('/services/refresh'); searchFailure = '';
    const stale = await invoke('/');
    assert.equal(stale.serviceList.stale, true); assert.equal(stale.services[0].available, true);
    await invoke('/create-consent', { patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' });
    assert.equal(writes.length, 0); assert.match((await invoke('/')).flash.message, /refresh failed/);
    await invoke('/services/refresh');
    await invoke('/create-consent', { patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' });
    assert.deepEqual(writes, ['mine']); assert.equal(list.consents[0].id, 'consent');
});


test('create never borrows a provider for omitted, empty or diagnostic application identity', async () => {
    await setup();
    for (const identity of [undefined, '', 'untrusted', 'untrusted-assertion']) {
        await invoke('/create-consent', { identity, patientId: '000000018', serviceId: 'mine', serviceStamp: 'version1' });
        assert.equal(writes.length, 0);
    }
});
