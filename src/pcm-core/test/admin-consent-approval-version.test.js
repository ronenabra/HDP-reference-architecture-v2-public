'use strict';

/** Actual Admin approval handler: current versioned commands freeze the exact service grant. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../../test-support/team-config').installTestRuntime({ serviceCatalog: {
    file: 'config/demo-services.json', bindings: [{ application: 'serviceProvider', providerRole: 'serviceProvider',
        serviceKey: 'lab-follow-up', instanceId: 'approval-lab-follow-up', instanceIdentifier: 'APPROVAL-LAB' }]
} });
const store = require('../src/fhir/store');
const { buildSeedResources } = require('../src/bootstrap');
const { createConsent } = require('../src/fhir/consent-lifecycle');
const { versionDefinition, EXACT } = require('../../../test-support/consent-snapshot-fixture');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { readApprovalSnapshot } = require('../../shared/consent-scope-snapshot');
const router = require('../src/routes/ui');
const handle = router.stack.find(layer => layer.route?.path === '/admin/consents/:id/approve').route.stack.at(-1).handle;
test.after(() => store.clear());

/** Seed only disposable operational service/source resources and one real ordinary pending request. */
function pending() {
    store.clear();
    require('../src/bootstrap').buildSeedDrafts(config).forEach(resource => require('../src/public-fhir').publishNewResource(store, resource));
    require('../src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    versionDefinition(store);
    const request = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
    request.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
    request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = 'HealthcareService/approval-lab-follow-up';
    return createConsent({ store, callerOrganization: store.get('Organization', config.organizations.serviceProvider.id), request });
}

/** Invoke the unchanged actual Admin route with its JSON content negotiation and capture its result. */
function submit(id, body) {
    const result = { status: 200 };
    const response = { status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; },
        format(formats) { formats.json(); } };
    handle({ params: { id }, body }, response);
    return result;
}

for (const [name, body] of [
    ['obsolete empty command', {}],
    ['missing version', { scopeChoice: 'service-provided' }],
    ['stale version', { expectedVersion: 'stale', scopeChoice: 'service-provided' }]
]) {
    test(`Admin approval rejects ${name} without changing pending authority or adding a snapshot`, () => {
        const consent = pending(), before = JSON.stringify(store.get('Consent', consent.id));
        const response = submit(consent.id, body);
        assert.equal(response.status, 409); assert.match(response.body.error, /pending Consent version/);
        assert.equal(JSON.stringify(store.get('Consent', consent.id)), before);
        assert.equal(readApprovalSnapshot(store.get('Consent', consent.id)), null);
    });
}

for (const explicitSource of [false, true]) {
    test(`current Admin service-provided approval retains exact immutable snapshot and ${explicitSource ? 'one selected source' : 'configured sources'}`, () => {
        const consent = pending();
        const sourceIds = explicitSource ? [config.healthOrganizations[0].dataSourceOrganization.id] : undefined;
        const command = { expectedVersion: consent.meta.versionId, scopeChoice: 'service-provided', ...(explicitSource ? { sourceIds } : {}) };
        const response = submit(consent.id, command);
        assert.equal(response.status, 200); assert.equal(response.body.consent.status, 'active');
        const saved = store.get('Consent', consent.id), snapshot = store.privateRecords.approvals.getDecision(saved.id).snapshot;
        assert.equal(snapshot.scope, EXACT); assert.equal(snapshot.choice, 'service-provided');
        assert.equal(snapshot.service.grant.scope, EXACT); assert.equal(snapshot.anchor, '2026-01-05T12:00:00.000Z');
        const selected = saved.provision.actor.filter(actor => actor.role.coding.some(coding => coding.code === 'CST')).map(actor => actor.reference.reference).sort();
        const expected = explicitSource ? sourceIds : require('../src/data-sources').getConfiguredDataSources(config).map(source => source.id);
        assert.deepEqual(selected, expected.map(id => `Organization/${id}`).sort());
        const bytes = JSON.stringify(store.privateRecords.approvals.getDecision(saved.id).snapshot);
        for (const retry of [command, { scopeChoice: 'custom', customScope: 'replacement' },
            { expectedVersion: saved.meta.versionId, scopeChoice: 'custom', customScope: 'replacement' }]) {
            const denied = submit(consent.id, retry);
            assert.equal(denied.status, 409);
            assert.deepEqual(store.get('Consent', consent.id), saved);
            assert.equal(JSON.stringify(store.privateRecords.approvals.getDecision(consent.id).snapshot), bytes);
        }
    });
}
