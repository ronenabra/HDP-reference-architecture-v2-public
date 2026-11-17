'use strict';
/** Actual Consent rendering retains stored authority across service edits and terminal states. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startSnapshotFixture, V } = require('../../../test-support/consent-snapshot-fixture');
const lifecycle = require('../src/fhir/consent-lifecycle');
const { assertPublic } = require('../src/public-fhir');

/** Read the existing review route, preserving its ordinary local render boundary. */
async function page(f, consent) {
    const response = await fetch(`${f.base}/ui/approve/${consent.id}`);
    assert.equal(response.status, 200); return response.text();
}

test('pending facts and all exact choices remain reachable without private metadata dumps', async () => {
    const f = await startSnapshotFixture();
    try {
        const consent = f.create(), html = await page(f, consent);
        for (const choice of ['service-provided', 'auto-resources', 'auto-buckets', 'custom']) assert.ok(html.includes(`name="scopeChoice" value="${choice}"`));
        assert.match(html, /data-alternative-permissions/); assert.match(html, /Permissions to be saved/);
        assert.match(html, /<dt>Patient<\/dt>/); assert.match(html, /<dt>Requested by<\/dt>/); assert.match(html, /Repeated access/);
        assert.match(html, /name="expectedVersion"/); assert.match(html, /name="approvalReview"/);
        assert.doesNotMatch(html, /Technical decision|compiler provenance|Service generator|Generator history|data-approval-snapshot|Automatic approval for two special/);
        assert.match(html, /Limited summary/); assert.match(html, /status=final/);
        assertPublic(f.store.get('Consent', consent.id));
    } finally { await f.close(); }
});

test('saved fixed dates and scope are independent of current service settings; no public snapshot appears', async () => {
    const f = await startSnapshotFixture();
    try {
        const instance = f.store.get('HealthcareService', 'approval-lab-follow-up');
        const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(instance));
        const input = { ...f.store.privateRecords.services.getDefinition(canonical.id).grant.authoring,
            approvalScope: `patient/Patient.rs?${V} patient/Observation.s?date=ge2024-01-05T12:00:00.000Z&${V}` };
        require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, input);
        const consent = lifecycle.approveConsent({ store: f.store, consent: f.create() });
        const bytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(consent.id).snapshot);
        require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, { ...input, approvalScope: input.approvalScope.replace('2024-01-05', '2025-09-09') });
        const html = await page(f, consent);
        assert.match(html, /From 5 Jan 2024, 12:00:00 UTC/); assert.doesNotMatch(html, /From 9 Sept 2025|Past 2 years/);
        assert.match(html, /Approved data access/); assert.match(html, /no verified patient decision/);
        assert.doesNotMatch(html, /name="scopeChoice"|name="customScope"|pcm-consent-scope\/1|data-approval-snapshot/);
        assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(consent.id).snapshot), bytes);
        const publicConsent = f.store.get('Consent', consent.id); assertPublic(publicConsent);
        assert.doesNotMatch(JSON.stringify(publicConsent), /pcm-consent-scope|approvalScope|2024-01-05/);
        delete f.store.privateState.approvals[`Consent/${consent.id}`];
        assert.match(await page(f, consent), /Unusable approval scope/);
    } finally { await f.close(); }
});

test('rejected, expired and cancelled pages keep lifecycle reasons and cannot submit approval controls', async () => {
    const f = await startSnapshotFixture();
    try {
        const rejected = lifecycle.rejectConsent({ store: f.store, consent: f.create() });
        const approved = lifecycle.approveConsent({ store: f.store, consent: f.create() });
        const expired = lifecycle.expireConsent({ store: f.store, consent: approved, now: new Date(Date.parse(approved.provision.period.end) + 1) });
        const cancellable = lifecycle.approveConsent({ store: f.store, consent: f.create() });
        const cancelled = require('../src/consent-cancellation').applyCancellation({ store: f.store, consentId: cancellable.id, expectedVersion: cancellable.meta.versionId, provider: { organizationId: f.config.organizations.serviceProvider.id }, operator: 'owned-test', audit() {} });
        for (const consent of [rejected, expired, cancelled]) {
            const html = await page(f, consent);
            assert.match(html, /data-consent-status/); assert.doesNotMatch(html, /name="scopeChoice"|name="customScope"|data-scope-approval/);
            const before = f.store.get('Consent', consent.id);
            const response = await fetch(`${f.base}/ui/approve/${consent.id}`, { method: 'POST', body: new URLSearchParams({ action: 'decline', expectedVersion: before.meta.versionId }) });
            assert.equal(response.status, 409); assert.deepEqual(f.store.get('Consent', consent.id), before);
        }
    } finally { await f.close(); }
});


test('stale review renders the unsaved manual and source draft with fresh proofs and no automatic retry', async () => {
    const f = await startSnapshotFixture();
    try {
        const consent = f.create(), original = await page(f, consent);
        const decode = value => value.replaceAll('&#34;', '"').replaceAll('&amp;', '&');
        const proof = decode(original.match(/name="approvalReview" value="([^"]*)"/)[1]);
        const service = f.store.get('HealthcareService', 'approval-lab-follow-up'); service.name = 'Edited after review'; f.store.update(service);
        const text = '  patient/Unknown.rs?_filter=<unsafe>  ';
        const sourceId = f.config.healthOrganizations[0].dataSourceOrganization.id;
        const response = await fetch(`${f.base}/ui/approve/${consent.id}`, { method: 'POST', body: new URLSearchParams({ action: 'approve',
            expectedVersion: consent.meta.versionId, approvalReview: proof, scopeChoice: 'custom', customScope: text, sources: sourceId }) });
        assert.equal(response.status, 409); const html = await response.text();
        assert.match(html, /data-approval-error/); assert.match(html, /Consent or service changed/);
        assert.match(html, /  patient\/Unknown.rs\?_filter=&lt;unsafe&gt;  <\/textarea>/);
        assert.match(html, /id="scope-custom"[^>]*checked/);
        const fresh = decode(html.match(/name="approvalReview" value="([^"]*)"/)[1]);
        assert.notEqual(fresh, proof); assert.deepEqual(f.store.get('Consent', consent.id), consent);
        const accepted = await fetch(`${f.base}/ui/approve/${consent.id}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ action: 'approve',
            expectedVersion: consent.meta.versionId, approvalReview: fresh, scopeChoice: 'custom', customScope: text, sources: sourceId }) });
        assert.equal(accepted.status, 302); assert.equal(f.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope, text);
    } finally { await f.close(); }
});
