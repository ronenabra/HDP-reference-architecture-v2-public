'use strict';
/** Current consumer boundary: private diagnostics, public facts and no hidden authority fallback. */
const test = require('node:test'), assert = require('node:assert/strict');
const { consentRequestFixture } = require('../../../test-support/consent-request-fixture');
const { consentStatus } = require('../../shared/consent-status');
const { sourceSimulationAudit } = require('../src/fhir/sandbox-source-change');
const { assertPublic } = require('../src/public-fhir');

test('forged public lifecycle tags cannot supply private history; owner events retain actual provenance', () => {
    const f = consentRequestFixture();
    const current = f.store.get('Consent', f.consent.id);
    current.meta.tag = [{ system: 'urn:pcm:sandbox:consent-cancellation', code: 'status-change', display: JSON.stringify({ consentId: current.id,
        newState: 'active', version: current.meta.versionId, at: new Date().toISOString(), operator: 'forged', provider: 'forged' }) },
    { system: 'urn:pcm:sandbox:source-change', code: 'source-set-v1', display: '{"actor":"forged"}' }];
    assert.equal(consentStatus(current).event, null);
    assert.equal(sourceSimulationAudit(current), null);
    assert.equal(sourceSimulationAudit(current, f.store), null);
    const events = f.store.privateRecords.lifecycle.getEvents('Consent', current.id);
    assert.equal(events.at(-1).kind, 'approval');
    assert.throws(() => f.store.update(current), /Private PCM metadata/);
});

test('ordinary service projection succeeds without private repository access and cannot claim exact grants', () => {
    const f = consentRequestFixture();
    const resources = f.store.getAll('HealthcareService');
    resources.forEach(assertPublic);
    const result = require('../src/service-list-projection').projectServices({ resources, providerId: f.client.organizationId });
    assert.ok(result.owned.length);
    assert.equal(Object.hasOwn(result.owned[0], 'grant'), false);
    assert.ok(result.owned[0].access.summary);
    delete f.store.privateState.approvals[`Consent/${f.consent.id}`];
    assert.throws(() => require('../src/data-grant').resolveGrant(f.request), /approval.*missing|missing.*approval/i);
    const forged = f.store.get('Consent', f.consent.id); forged.provision.period.end = '2099-01-01T00:00:00Z';
    assert.throws(() => f.store.update(forged), /read-only/);
});

test('owned list fixture preserves private template policy and restores its complete checkpoint', () => {
    const config = require('../../../test-support/team-config').buildTeamConfig();
    const store = new (require('../src/fhir/store').FHIRStore)();
    for (const draft of require('../src/bootstrap').buildSeedDrafts(config)) require('../src/public-fhir').publishNewResource(store, draft);
    const checkpoint = require('../src/migration-checkpoint'), before = checkpoint.snapshot(store, { privateState: true });
    const installed = require('../../../test-support/services-list-fixture').installServicesListFixture({ store, config });
    assert.equal(installed.definitions.length, 5); assert.equal(installed.registrationsA.length, 5);
    for (const definition of installed.definitions) { assertPublic(definition); assert.equal(store.privateRecords.services.getDefinition(definition.id).status, 'ok'); }
    assert.equal(store.privateRecords.services.getDefinition(installed.definitions[4].id).confidentialityPolicy.allowRestricted, true);
    assert.ok(JSON.stringify(installed.definitions[0]).includes('long-example-'));
    installed.restore();
    assert.deepEqual(checkpoint.snapshot(store, { privateState: true }), before);
});

test('protected Admin inventory supplies separate versioned diagnostics while public Consent stays clean', async t => {
    const previous = process.env.TEAM_ADMIN_PASSWORD;
    process.env.TEAM_ADMIN_PASSWORD = 'owned-metadata-consumer-test';
    const f = await require('../../../test-support/consent-snapshot-fixture').startSnapshotFixture();
    t.after(async () => { await f.close(); if (previous === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previous; });
    const consent = require('../src/fhir/consent-lifecycle').approveConsent({ store: f.store, consent: f.create() });
    assert.equal((await fetch(`${f.base}/admin/consents`, { headers: { accept: 'application/json' } })).status, 401);
    const response = await fetch(`${f.base}/admin/consents`, { headers: { accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.diagnostics.schema, 'pcm-consumer-review/1'); assert.equal(result.diagnostics.visibility, 'diagnostic');
    const decision = result.diagnostics.approvals[consent.id];
    assert.deepEqual(decision, f.store.privateRecords.approvals.getDecision(consent.id));
    assertPublic(f.store.get('Consent', consent.id));
    const protocol = require('../../shared/log-policy').classifyRoute('/api/fhir-service/r4/Consent', 'pcm-core');
    const diagnostic = require('../../shared/log-policy').classifyRoute('/admin/consents', 'pcm-core');
    assert.equal(protocol.visibility, 'default'); assert.equal(diagnostic.visibility, 'diagnostic'); assert.equal(diagnostic.causesSystemFlow, false);
    delete process.env.TEAM_ADMIN_PASSWORD;
    const unavailable = await (await fetch(`${f.base}/admin/consents`)).json();
    assert.equal(unavailable.diagnostics.status, 'unavailable'); assert.equal(unavailable.diagnostics.approvals, undefined);
});
