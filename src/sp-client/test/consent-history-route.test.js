'use strict';
/** Exact Consent history survives unavailable services without reviving endpoints or older actions. */
const test = require('node:test'), assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const client = require('../src/client');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
const fixture = clinicalTokenFixture({ scope: `patient/Patient.rs?${V} patient/Observation.s?${V}` });
const approved = fixture.approve({ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' });
const id = approved.id, serviceId = approved.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference.split('/')[1];
let search, exactConsent, service, holdConsent, holdService, finishConsent, finishService, resets;
/** Capture each reply when its request begins, so deliberately late responses remain old. */
client.checkConsentStatus = async () => {
    const reply = structuredClone(exactConsent);
    if (holdConsent) await new Promise(resolve => { finishConsent = resolve; });
    return reply;
};
client.readOwnedService = async () => {
    const reply = service instanceof Error ? service : structuredClone(service);
    if (holdService) await new Promise(resolve => { finishService = resolve; });
    if (reply instanceof Error) throw reply;
    return reply;
};
client.searchConsents = async () => structuredClone(search);
client.searchServices = async () => ({ services: [], next: '', complete: true, warnings: [], pages: 1, used: { requests: 1, bytes: 1 } });
client.resetCache = owner => resets.push(owner);
const { app } = require('../src/index');
/** Invoke real handlers and capture the actual render locals without network/private service access. */
async function invoke(path, body = {}) {
    let output;
    const response = { redirect() {}, status(code) { this.code = code; return this; }, json(value) { output = { code: this.code, ...value }; }, render(_view, locals) { output = locals; } };
    await app._router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle({ body: { identity: 'hospital-a', ...body }, query: { identity: 'hospital-a' }, get: () => 'application/json' }, response);
    return output;
}
/** Model an ordinary later lifecycle read while retaining the exact approved bytes. */
function currentConsent(status = 'inactive', version = '2') {
    const value = structuredClone(approved);
    value.status = status; value.meta.versionId = version;
    value.extension = value.extension.filter(item => item.url !== EXTENSIONS.consentBusinessStatus);
    value.extension.push(require('../../pcm-core/src/fhir/consent-lifecycle').businessStatusExtension(status === 'active' ? 'active' : 'permanently-inactive'));
    value.discoveredEndpoint = 'https://old.example/fhir';
    value.discoveredEndpoints = [{ name: 'Stale source', url: 'https://old.example/fhir' }];
    return value;
}
/** Establish a stored approval, then omit it from plain search to require the exact history path. */
async function setup({ manual = false } = {}) {
    resets = []; holdConsent = false; holdService = false; finishConsent = null; finishService = null;
    await invoke('/reset');
    exactConsent = currentConsent('active', '1');
    service = { id: serviceId, available: true, signature: 'version1', readiness: 'Ready', name: 'Owned service' };
    search = manual ? [] : [structuredClone(exactConsent)];
    await invoke('/'); search = [];
}
/** Assert the saved approval is unchanged and the actual rendered unavailable card cannot retrieve. */
function assertUnavailable(page, status = 'inactive', version = '2', serviceAvailable = false) {
    assert.equal(page.consents.length, 1);
    const row = page.consents[0];
    assert.equal(row.consent.status, status); assert.equal(row.consent.meta.versionId, version);
    assert.deepEqual(row.consent.identifier, approved.identifier);
    assert.equal(row.consent.patient.identifier.value, '000000018');
    assert.equal(row.consent.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference, 'HealthcareService/' + serviceId);
    assert.equal(row.consent.discoveredEndpoint, undefined); assert.equal(row.consent.discoveredEndpoints, undefined);
    assert.equal(row.data, null); assert.equal(row.selectedEndpoint, null); assert.equal(row.service.available, serviceAvailable);
    const html = require('ejs').render(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/views/index.ejs'), 'utf8'), page);
    const card = html.slice(html.indexOf('data-consent-card='), html.indexOf('<!-- MANUAL SANDBOX CARD -->'));
    assert.match(card, /data-help-key="doctor.fetch"[^>]*disabled/);
    assert.doesNotMatch(card, /https:\/\/old.example/);
}

for (const readiness of ['cancelled', 'missing', 'transient', 'changed generation']) test('off-page authoritative terminal history is saved despite service ' + readiness, async () => {
    await setup(); exactConsent = currentConsent();
    service = readiness === 'transient' ? new Error('503 temporary') : { id: serviceId, available: false, signature: readiness === 'changed generation' ? 'version2' : readiness, readiness: 'Registration ' + readiness };
    await invoke('/discover', { consentId: id });
    const page = await invoke('/'); assertUnavailable(page);
    assert.ok(resets.filter(owner => owner !== undefined).every(owner => owner === 'hospital-a'));
    console.log(JSON.stringify({ exactStatus: exactConsent.status, renderedStatus: page.consents[0].consent.status, plainSearchCount: search.length, service: readiness, snapshotUnchanged: true }));
});

for (const readiness of ['unavailable', 'transient']) test('manual discovery stores active Consent history while service is ' + readiness, async () => {
    await setup({ manual: true }); exactConsent = currentConsent('active', '2');
    service = readiness === 'transient' ? new Error('503 temporary') : { id: serviceId, available: false, readiness: 'Definition unavailable', signature: 'hidden' };
    await invoke('/discover', { consentId: id });
    assertUnavailable(await invoke('/'), 'active');
});

test('a late exact Consent read cannot replace newer authoritative history', async () => {
    await setup(); holdConsent = true; exactConsent = currentConsent('active', '2');
    const pending = invoke('/discover', { consentId: id });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finishConsent, 'function');
    holdConsent = false; search = [currentConsent('inactive', '3')]; await invoke('/'); search = [];
    finishConsent(); await pending;
    service = { id: serviceId, available: false, readiness: 'Cancelled', signature: 'terminal' };
    assertUnavailable(await invoke('/'), 'inactive', '3');
});

test('a newer discovery wins over an old service response without restoring endpoints or history', async () => {
    await setup(); exactConsent = currentConsent('active', '2'); holdService = true;
    const pending = invoke('/discover', { consentId: id });
    await new Promise(resolve => setImmediate(resolve)); const release = finishService; assert.equal(typeof release, 'function');
    holdService = false; exactConsent = currentConsent('inactive', '3');
    service = { id: serviceId, available: false, readiness: 'Cancelled', signature: 'terminal' };
    await invoke('/discover', { consentId: id }); release(); await pending;
    assertUnavailable(await invoke('/'), 'inactive', '3');
});

test('a newer version with unchanged lifecycle/source still fences a late service response', async () => {
    await setup(); exactConsent = currentConsent('active', '2'); holdService = true;
    const pending = invoke('/discover', { consentId: id });
    await new Promise(resolve => setImmediate(resolve)); const release = finishService;
    holdService = false; search = [currentConsent('active', '3')]; await invoke('/'); search = [];
    release(); await pending;
    service = { id: serviceId, available: false, readiness: 'Unavailable', signature: 'blocked' };
    assertUnavailable(await invoke('/'), 'active', '3');
});

for (const action of ['source', 'reset']) test(action + ' change during service revalidation fences endpoint installation', async () => {
    await setup(); exactConsent = currentConsent('active', '2'); holdService = true;
    const pending = invoke('/discover', { consentId: id });
    await new Promise(resolve => setImmediate(resolve)); const release = finishService;
    if (action === 'source') await invoke('/selection', { sourceConsentId: id }); else await invoke('/reset');
    holdService = false; release(); await pending;
    service = { id: serviceId, available: false, readiness: 'Unavailable', signature: 'blocked' };
    const page = await invoke('/');
    if (action === 'reset') assert.equal(page.consents.length, 0); else assertUnavailable(page, 'active');
});

test('late manual discovery cannot replace a newer inserted Consent record', async () => {
    await setup({ manual: true }); holdConsent = true; exactConsent = currentConsent('active', '2');
    const pending = invoke('/discover', { consentId: id });
    await new Promise(resolve => setImmediate(resolve)); const release = finishConsent;
    holdConsent = false; exactConsent = currentConsent('inactive', '3');
    service = { id: serviceId, available: false, readiness: 'Cancelled', signature: 'terminal' };
    await invoke('/discover', { consentId: id }); release(); await pending;
    assertUnavailable(await invoke('/'), 'inactive', '3');
});

test('an available service changing its generation cannot discard terminal Consent history or enable query actions', async () => {
    await setup(); exactConsent = currentConsent(); service.signature = 'version2';
    await invoke('/discover', { consentId: id });
    assertUnavailable(await invoke('/'), 'inactive', '2', true);
});

test('current active discovery retains valid endpoints after its own service-generation invalidation', async () => {
    await setup(); exactConsent = currentConsent('active', '2'); service.signature = 'version2';
    await invoke('/discover', { consentId: id });
    const page = await invoke('/'), row = page.consents[0];
    assert.equal(row.consent.status, 'active'); assert.equal(row.consent.meta.versionId, '2');
    assert.equal(row.consent.discoveredEndpoint, exactConsent.discoveredEndpoint);
    assert.deepEqual(row.consent.discoveredEndpoints, exactConsent.discoveredEndpoints);
    assert.equal(row.service.available, true); assert.equal(row.data, null);
    assert.equal(row.service.signature, 'version2');
    assert.deepEqual(row.consent.identifier, approved.identifier);
});
