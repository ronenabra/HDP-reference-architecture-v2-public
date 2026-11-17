'use strict';
/** Actual TLS public-only list/create/poll/discover/token/fetch/cancel and external PCM rejection. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startDoctorPublicServer } = require('../../../test-support/doctor-public-server');
test('ordinary Doctor completes clinical workflow using only documented public operations', async () => {
    const fixture = await startDoctorPublicServer();
    const client = require('../src/client');
    try {
        const rows = await client.searchConsents('hospital-a'); assert.equal(rows.length, 2);
        const first = rows[0];
        const services = await client.searchServices('hospital-a'); assert.equal(services.services[0].available, true);
        assert.equal(services.services[0].permissions.mapping, 'doctor-clinical-intent/1');
        const created = await client.createConsentRequest('http://fhir.health.gov.il/identifier/il-national-id|000000018', fixture.instance.id, 'hospital-a');
        assert.equal(created.status, 'proposed');
        const pending = await client.checkConsentStatus(created.id, 'hospital-a'); assert.equal(pending.status, 'proposed');
        await assert.rejects(client.fetchData(created.id, fixture.base + '/source-1', 'hospital-a', 'patient/Observation.rs'), /active Consent/);
        const discovered = await client.checkConsentStatus(first.id, 'hospital-a'); assert.equal(discovered.discoveredEndpoints.length, 1);
        const scope = 'patient/Observation.rs patient/Condition.r patient/Patient.rs';
        const data = await client.fetchData(first.id, fixture.base + '/source-1', 'hospital-a', scope);
        assert.deepEqual(data.preview.actions.map(value => value.type), ['Observation']);
        assert.equal(data.preview.skipped[0].outcome, 'skipped-read-only');
        assert.equal(data.preview.skipped[1].outcome, 'not-granted');
        assert.equal(data.preview.effectiveGrant.scope, fixture.scope);
        const again = await client.fetchData(first.id, fixture.base + '/source-1', 'hospital-a', scope);
        assert.equal(again.preview.effectiveGrant.acquiredAt, data.preview.effectiveGrant.acquiredAt);
        assert.equal(again.preview.effectiveGrant.expiresAt, data.preview.effectiveGrant.expiresAt);
        const clinical = fixture.requests.filter(value => value.requestedScope === scope); assert.equal(clinical.length, 1);
        assert.equal((await client.checkTokenStatus(first.id, fixture.base + '/source-1', 'hospital-a', data.preview.effectiveGrant.generation)).state, 'active');
        fixture.state.rejectClinical = true; client.resetCache();
        const before = fixture.requests.filter(value => value.path.startsWith('/source')).length;
        await assert.rejects(client.fetchData(first.id, fixture.base + '/source-1', 'hospital-a', scope), /External PCM rejects requested scope/);
        assert.equal(fixture.requests.filter(value => value.path.startsWith('/source')).length, before);
        fixture.state.rejectClinical = false;
        const cancelled = await client.deactivateConsent(first.id, 'hospital-a'); assert.equal(cancelled.status, 'inactive');
        assert.equal((await client.checkConsentStatus(first.id, 'hospital-a')).status, 'inactive');
        assert.deepEqual(fixture.violations, []);
        assert.ok(fixture.requests.every(value => /^\/api\/fhir-service\/r4\/(?:\.well-known\/smart-configuration|token|introspect|Consent(?:\/[^/]+)?|HealthcareService(?:\/[^/]+)?|Organization\/[^/]+)$/.test(value.path) || value.path === '/source-1/Observation'));
    } finally { await fixture.close(); }
});

test('ordinary runtime module graph rejects PCM private record/accessor/compiler imports', async () => {
    const Module = require('node:module'), load = Module._load;
    const forbidden = /(?:^|\/)(?:consent-scope-snapshot|service-grant|grant-compiler|private-records|service-scope-authoring|approval-scopes)(?:\.js)?$/;
    Module._load = function guarded(name, ...args) { assert.doesNotMatch(name, forbidden, 'Doctor cannot import PCM permission models'); return load.call(this, name, ...args); };
    let fixture;
    try {
        fixture = await startDoctorPublicServer();
        const client = require('../src/client'); client.resetCache();
        const consent = [...fixture.consents.values()][0];
        await client.searchServices('hospital-a'); await client.searchConsents('hospital-a');
        await client.fetchData(consent.id, fixture.base + '/source-1', 'hospital-a', 'patient/Observation.s');
        assert.deepEqual(fixture.violations, []);
    } finally { if (fixture) await fixture.close(); Module._load = load; }
});
