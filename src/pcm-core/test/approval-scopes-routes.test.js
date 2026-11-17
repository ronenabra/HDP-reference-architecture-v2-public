'use strict';
/** Closed private approval commands preserve Admin/strict boundaries and finite masters. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startSnapshotFixture, EXACT } = require('../../../test-support/consent-snapshot-fixture');

test('Admin approval requires the current version and explicit choice; forged fields reject atomically', async () => {
    const f = await startSnapshotFixture();
    try {
        const consent = f.create(), url = `${f.base}/admin/consents/${consent.id}/approve`;
        const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
        for (const extra of [{ approvedScope: 'patient/Observation.rs' }, { serviceId: 'other' }, { period: { end: '2030-01-01' } }, { origin: 'forged' }, { accessMode: 'one-time' }]) {
            assert.equal((await post({ expectedVersion: consent.meta.versionId, scopeChoice: 'service-provided', ...extra })).status, 409);
            assert.deepEqual(f.store.get('Consent', consent.id), consent);
        }
        assert.equal((await post({ scopeChoice: 'service-provided' })).status, 409);
        const approved = await post({ expectedVersion: consent.meta.versionId, scopeChoice: 'service-provided', sourceIds: [] });
        assert.equal(approved.status, 200, await approved.clone().text());
        const saved = (await approved.json()).consent;
        assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.scope, EXACT);
        assert.equal((await post({ expectedVersion: saved.meta.versionId, scopeChoice: 'custom', customScope: 'replace approved decision' })).status, 409);
        assert.deepEqual(f.store.get('Consent', consent.id), saved);
        assert.equal((await post({ expectedVersion: consent.meta.versionId, scopeChoice: 'auto-resources' })).status, 409);
    } finally { await f.close(); }
});

test('private source simulation remains denied under strict even for an exact approved snapshot', async () => {
    const f = await startSnapshotFixture();
    try {
        const consent = f.create();
        const saved = require('../src/fhir/consent-lifecycle').approveConsent({ store: f.store, consent, sourceOrganizationIds: [] });
        const strict = require('../../../test-support/team-config').buildTeamConfig({}, 'strict');
        for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) f.config[key] = strict[key];
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(f.config));
        const csrf = require('../src/sandbox-source-command').csrf(saved.id, saved.meta.versionId);
        const response = await fetch(`${f.base}/admin/consents/${saved.id}/sandbox-sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', expectedVersion: saved.meta.versionId, csrf, sourceIds: [] }) });
        assert.equal(response.status, 403); assert.deepEqual(f.store.get('Consent', saved.id), saved);
    } finally { await f.close(); }
});

test('generated master alternatives remain finite direct reads with complete confidentiality predicates', async () => {
    const f = await startSnapshotFixture();
    try {
        const service = f.store.get('HealthcareService', 'approval-lab-follow-up');
        const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(service));
        const original = f.store.privateRecords.services.getDefinition(canonical.id).grant;
        require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, { ...original.authoring, includeMasterData: true }, { now: Date.parse(original.anchor) / 1000 });
        for (const choice of ['auto-resources', 'auto-buckets']) {
            const consent = f.create();
            const saved = require('../src/fhir/consent-lifecycle').approveConsent({ store: f.store, consent, scopeChoice: choice });
            const snapshot = f.store.privateRecords.approvals.getDecision(saved.id).snapshot;
            assert.equal(snapshot.usable, true);
            const masters = require('../../shared/service-grant').inspectScope(snapshot.scope).clauses.filter(item => ['Organization', 'Practitioner'].includes(item.type));
            assert.equal(masters.length, 2);
            for (const clause of masters) { assert.equal(clause.actions, 'r'); assert.ok(clause.filters.some(value => value.endsWith('|V'))); }
        }
    } finally { await f.close(); }
});
