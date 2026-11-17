'use strict';
/** Real route lifecycle: optional failures retain grants; inactive/expiry/stale contexts never revive authority. */
const test = require('node:test'), assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const { doctorPublicFixture } = require('../../../test-support/doctor-public-fixture');
const f = doctorPublicFixture(), client = require('../src/client');
let status = { state: 'active', checkedAt: '2026-11-13T00:00:00.000Z', message: 'Active when checked' }, wait, expired = false;
client.searchConsents = async () => [structuredClone(f.consent)];
client.checkConsentStatus = async () => ({ ...structuredClone(f.consent), discoveredEndpoint: 'https://source.example/fhir' });
client.searchServices = async () => ({ services: [], complete: true, warnings: [] });
client.readOwnedService = async () => ({ id: f.instance.id, instance: f.instance, definition: f.canonical, signature: 'stable', available: true, readiness: 'Ready' });
client.fetchData = async () => ({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation' } }], preview: { effectiveGrant: {
    scope: f.scope, generation: 'generation1', acquiredAt: Date.now(), expiresAt: Date.now() + (expired ? -1 : 30000), audience: 'https://source.example/fhir', clientId: 'registered' } } });
client.checkTokenStatus = async () => { if (wait) await wait; return structuredClone(status); };
client.resetCache = () => {};
const { app } = require('../src/index');
/** Invoke the actual handler with a captured render and no network side effects. */
async function invoke(route, values = {}) {
    let result;
    await app._router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle({ body: { identity: 'hospital-a', ...values }, query: { identity: 'hospital-a' }, get: () => 'text/html' }, {
        redirect() {}, render(_view, locals) { result = locals; }, json(value) { result = value; }
    }); return result;
}
async function setup() {
    await invoke('/reset'); expired = false; wait = null; await invoke('/');
    await invoke('/fetch-data', { consentId: f.consent.id, endpointUrl: 'https://source.example/fhir', requestedScope: 'patient/Observation.s' });
}
const check = () => invoke('/token-status', { statusConsentId: f.consent.id, generation: 'generation1' });
test('refused status retains validated token/results and marks earlier active observation historical', async () => {
    await setup(); status = { state: 'active', checkedAt: '2026-11-13T00:00:00.000Z', message: 'Active when checked' }; await check();
    status = { state: 'refused', message: 'Not independently checked: refused' }; await check();
    const row = (await invoke('/')).consents[0]; assert.ok(row.data); assert.ok(row.tokenGrant);
    assert.equal(row.tokenStatus.previousCheckedAt, '2026-11-13T00:00:00.000Z');
});
test('inactive or contradictory status clears authority/results and blocks fetch despite old success', async () => {
    for (const message of ['Token inactive', 'Contradictory active response']) {
        await setup(); status = { state: 'invalid', authoritative: true, message }; await check();
        let row = (await invoke('/')).consents[0]; assert.equal(row.data, null); assert.equal(row.tokenGrant, null); assert.equal(row.authorityBlocked, true);
        await invoke('/fetch-data', { consentId: f.consent.id, endpointUrl: 'https://source.example/fhir', requestedScope: 'patient/Observation.s' });
        row = (await invoke('/')).consents[0]; assert.equal(row.data, null); assert.equal(row.consent.status, 'active');
    }
});
test('source/client/Consent generation changes and reset discard delayed status observations', async () => {
    for (const action of [{ sourceConsentId: f.consent.id, endpointUrl: 'https://other.example/fhir' }, { sourceConsentId: f.consent.id, requestedScope: 'patient/Patient.s' }, { identityExit: true }]) {
        await setup(); status = { state: 'active', message: 'Old response' }; let release;
        wait = new Promise(resolve => { release = resolve; }); const pending = check();
        await new Promise(resolve => setImmediate(resolve)); await invoke('/selection', action); release(); await pending;
        const row = (await invoke('/')).consents[0]; assert.equal(row.tokenGrant, null); assert.equal(row.tokenStatus, null); assert.equal(row.data, null);
    }
    await setup(); let release; wait = new Promise(resolve => { release = resolve; }); const pending = check();
    await new Promise(resolve => setImmediate(resolve)); await invoke('/reset'); release(); await pending;
    const row = (await invoke('/')).consents[0]; assert.equal(row.tokenGrant, undefined); assert.equal(row.data, null);
});
test('local expiry clears displayed results and token details without reissuing or checking a token', async () => {
    await setup(); expired = true;
    await invoke('/fetch-data', { consentId: f.consent.id, endpointUrl: 'https://source.example/fhir', requestedScope: 'patient/Observation.s' });
    const row = (await invoke('/')).consents[0]; assert.equal(row.tokenGrant, null); assert.equal(row.data, null); assert.equal(row.tokenStatus.state, 'expired');
});

test('a late authoritative denial clears a newer retrieval that reused the exact same token generation', async () => {
    await setup(); status = { state: 'invalid', authoritative: true, message: 'Exact token inactive' };
    let release; wait = new Promise(resolve => { release = resolve; }); const pending = check();
    await new Promise(resolve => setImmediate(resolve));
    await invoke('/fetch-data', { consentId: f.consent.id, endpointUrl: 'https://source.example/fhir', requestedScope: 'patient/Observation.s' });
    const revision = (await invoke('/')).consents[0].sourceRevision;
    release(); await pending;
    const row = (await invoke('/')).consents[0]; assert.equal(row.tokenGrant, null); assert.equal(row.data, null); assert.equal(row.authorityBlocked, true); assert.ok(row.sourceRevision > revision);
});
