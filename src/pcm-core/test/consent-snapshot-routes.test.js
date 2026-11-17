'use strict';
/** Real HTTP approval/source commands: reviewed exact scopes, forged writes and races. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSnapshotFixture, EXACT, V } = require('../../../test-support/consent-snapshot-fixture');
const { approvalScopeOptions } = require('../src/approval-scopes');

/** Read the actual rendered version and signed menu rather than inventing wire authority. */
async function review(fixture, consent) {
    const response = await fetch(`${fixture.base}/ui/approve/${consent.id}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const value = name => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1].replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return { html, expectedVersion: value('expectedVersion'), approvalReview: value('approvalReview') };
}
/** Submit the exact displayed review through the maintained HTTP handler. */
function submit(fixture, consent, display, choice, customScope) {
    return fetch(`${fixture.base}/ui/approve/${consent.id}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({
        action: 'approve', expectedVersion: display.expectedVersion, approvalReview: display.approvalReview,
        scopeChoice: choice, ...(customScope === undefined ? {} : { customScope })
    }) });
}

test('actual UI routes default to exact service, permit all explicit broader choices and retain advisory/manual origin', async () => {
    const f = await startSnapshotFixture();
    try {
        for (const choice of ['service-provided', 'auto-resources', 'auto-buckets', 'custom']) {
            const consent = f.create(), display = await review(f, consent);
            assert.match(display.html, /value="service-provided"[\s\S]*?checked/);
            assert.match(display.html, /All records of the service’s resource types/); assert.match(display.html, /Service categories with dates recalculated/);
            assert.match(display.html, /Deliberate broader sandbox override/);
            const exact = choice === 'custom' ? `patient/Patient.rs?${V} patient/Encounter.s?${V}` :
                approvalScopeOptions(f.store, f.store.get('HealthcareService', 'approval-lab-follow-up'), { now: Date.parse(JSON.parse(display.approvalReview).anchor) / 1000 }).find(item => item.id === choice).value;
            const response = await submit(f, consent, display, choice, exact);
            assert.equal(response.status, 302, await response.text());
            const saved = f.store.get('Consent', consent.id), snapshot = f.store.privateRecords.approvals.getDecision(saved.id).snapshot;
            assert.equal(snapshot.scope, exact); assert.equal(snapshot.choice, choice);
            if (choice === 'service-provided') assert.equal(exact, EXACT);
            const html = await (await fetch(`${f.base}/ui/approve/${consent.id}`)).text();
            assert.match(html, /Saved permissions are read-only/); assert.match(html, /data-approval-provenance/);
            assert.doesNotMatch(html, /name="scopeChoice"|name="customScope"/);
            assert.ok(html.includes(exact.replace(/&/g, '&amp;')));
            const repeat = await submit(f, consent, display, 'custom', 'forged replacement');
            assert.equal(repeat.status, 409); assert.deepEqual(f.store.get('Consent', consent.id), saved);
        }
        for (const text of ['', '  suspect scope  ', `patient/Patient.rs?${V} patient/DocumentReference.s?${V}`]) {
            const consent = f.create(), response = await submit(f, consent, await review(f, consent), 'custom', text);
            assert.equal(response.status, 302);
            const saved = f.store.get('Consent', consent.id);
            assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.scope, text); assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.usable, false);
            const html = await (await fetch(`${f.base}/ui/approve/${consent.id}`)).text();
            assert.match(html, /Unusable approval scope/);
            assert.ok(html.includes(`data-approved-scope>${text.replaceAll('&', '&amp;')}</code>`), 'unusable exact text remains available for private diagnosis');
        }
    } finally { await f.close(); }
});

test('parallel and stale service submissions cannot replace decisions or regenerate a reviewed scope', async () => {
    const f = await startSnapshotFixture();
    try {
        const consent = f.create(), display = await review(f, consent);
        const results = await Promise.all([submit(f, consent, display, 'service-provided'), submit(f, consent, display, 'auto-resources')]);
        assert.deepEqual(results.map(item => item.status).sort(), [302, 409]);
        assert.equal(f.store.get('Consent', consent.id).meta.versionId, '2');
        const pending = f.create(), stale = await review(f, pending);
        const service = f.store.get('HealthcareService', 'approval-lab-follow-up'); service.name = 'changed after review'; f.store.update(service);
        const response = await submit(f, pending, stale, 'auto-buckets');
        assert.equal(response.status, 409); assert.deepEqual(f.store.get('Consent', pending.id), pending);
        for (const invalidReview of ['null', '[]', '{}', '"ignored"']) {
            const invalid = await fetch(`${f.base}/ui/approve/${pending.id}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ action: 'approve', expectedVersion: pending.meta.versionId, scopeChoice: 'auto-buckets', approvalReview: invalidReview }) });
            assert.ok([400, 409].includes(invalid.status)); assert.deepEqual(f.store.get('Consent', pending.id), pending);
        }
        const forged = await fetch(`${f.base}/ui/approve/${pending.id}`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ action: 'approve', expectedVersion: pending.meta.versionId, approvedScope: 'patient/Observation.rs' }) });
        assert.equal(forged.status, 400); assert.deepEqual(f.store.get('Consent', pending.id), pending);
    } finally { await f.close(); }
});

test('source add/remove/empty/unavailable/stale and forged commands preserve exact approval and external usage state', async () => {
    const f = await startSnapshotFixture();
    try {
        const consent = f.create(); assert.equal((await submit(f, consent, await review(f, consent), 'service-provided')).status, 302);
        const first = f.store.get('Consent', consent.id), bytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(first.id).snapshot);
        const windows = new Map([[`${consent.id}\u0000client\u0000source`, { startedAt: 1794139200, expiresAt: 1794142800 }]]);
        const windowBytes = JSON.stringify([...windows]);
        const ids = f.config.healthOrganizations.map(source => source.dataSourceOrganization.id);
        const command = async (sourceIds, extra = {}, staleVersion) => {
            const html = await (await fetch(`${f.base}/ui/approve/${consent.id}`)).text();
            const csrf = html.match(/<form data-source-change[\s\S]*?name="csrf" value="([^"]+)"/)[1];
            return fetch(`${f.base}/admin/consents/${consent.id}/sandbox-sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', expectedVersion: staleVersion || f.store.get('Consent', consent.id).meta.versionId, csrf, sourceIds, ...extra }) });
        };
        for (const field of ['scope', 'approvedScope', 'origin', 'serviceId', 'period', 'accessMode']) {
            const before = f.store.get('Consent', consent.id), response = await command([ids[0]], { [field]: 'forged' });
            assert.equal(response.status, 400); assert.deepEqual(f.store.get('Consent', consent.id), before);
        }
        for (const selection of [[ids[0]], ids.slice(0, 2), [ids[1]], []]) {
            const response = await command(selection); assert.equal(response.status, 200, await response.text());
            const saved = f.store.get('Consent', consent.id);
            assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(saved.id).snapshot), bytes);
            assert.deepEqual(saved.provision.period, first.provision.period); assert.deepEqual(saved.category, first.category);
            assert.equal(JSON.stringify([...windows]), windowBytes);
        }
        const unavailable = f.store.get('Organization', ids[1]); unavailable.active = false; f.store.update(unavailable);
        const before = f.store.get('Consent', consent.id);
        assert.equal((await command([ids[1]])).status, 400); assert.deepEqual(f.store.get('Consent', consent.id), before);
        // Valid version-bound CSRF with stale version must fail at the helper version guard.
        const csrf = require('../src/sandbox-source-command').csrf(consent.id, first.meta.versionId);
        const stale = await fetch(`${f.base}/admin/consents/${consent.id}/sandbox-sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', expectedVersion: first.meta.versionId, csrf, sourceIds: [] }) });
        assert.equal(stale.status, 409); assert.deepEqual(f.store.get('Consent', consent.id), before);
        for (const field of ['scope', 'origin', 'serviceId', 'period', 'accessMode']) assert.throws(() => require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config, consentId: consent.id, expectedVersion: before.meta.versionId, sourceOrganizationIds: [], actor: 'operator', sessionId: 'session', audit() {}, [field]: 'forged' }), /source changes only/);
    } finally { await f.close(); }
});
