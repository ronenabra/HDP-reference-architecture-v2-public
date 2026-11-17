'use strict';

/** Real EJS/approval commands save the authored default and independent manual decision. */
const test = require('node:test'), assert = require('node:assert/strict');
const { DEFAULT_SCOPE, MANUAL_SCOPE } = require('../ui/tests/helpers/demo-access-approval');
const { startApprovalFixture } = require('../../test-support/approval-scope-fixture');

test('the runtime fixture distinguishes advisory read/search requests from invalid write ceilings', () => {
    const { parseScopeCeiling } = require('../../src/pcm-core/src/rar-request');
    assert.equal(parseScopeCeiling('patient/Condition.rs')[0].resource, 'Condition');
    assert.throws(() => parseScopeCeiling('patient/Condition.c'), error => error.error === 'invalid_scope' || error.code === 'invalid_scope');
});

/** Decode only the two hidden EJS form fields for this fixed approval controller regression. */
function command(html, manual) {
    const decode = value => value.replace(/&amp;|&lt;|&gt;|&#34;|&#39;/g, key => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#34;': '"', '&#39;': "'" })[key]);
    const value = name => decode(html.match(new RegExp(`name="${name}" value="([^"<>]*)"`))[1]);
    const form = new URLSearchParams({ action: 'approve', expectedVersion: value('expectedVersion'), approvalReview: value('approvalReview'), scopeChoice: manual ? 'custom' : 'service-provided', customScope: manual ? MANUAL_SCOPE : '' });
    for (const match of html.matchAll(/<input[^>]*name="sources"[^>]*value="([^"]+)"[\s\S]*?id="ds-[^"]+">/g)) if (/\schecked(?:\s|>)/.test(match[0])) form.append('sources', decode(match[1]));
    return form;
}

test('built-in default is the literal patient wildcard; a separate restrictive manual decision remains immutable', async () => {
    const configured = require('../../config/demo-services.json').clinicalServices.find(row => row.key === 'sandbox-full-access');
    assert.equal(configured.serviceGrant.scope, DEFAULT_SCOPE); assert.equal(DEFAULT_SCOPE, 'patient/*.rs');
    assert.match(MANUAL_SCOPE, /patient\/Condition.rs\?/); assert.equal(MANUAL_SCOPE.split(' ').length, 4);
    const f = await startApprovalFixture();
    try {
        const first = f.create('sandbox-full-access'), second = f.create('sandbox-full-access'); assert.notEqual(first.id, second.id);
        const saved = [];
        for (const [consent, manual] of [[first, false], [second, true]]) {
            const html = await (await fetch(`${f.base}/ui/approve/${consent.id}`)).text();
            assert.ok(html.includes(DEFAULT_SCOPE)); assert.ok(!html.includes('patient/Condition.rs?'), 'the distinct manual text is absent until explicitly authored');
            const response = await fetch(`${f.base}/ui/approve/${consent.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: command(html, manual) });
            assert.equal(response.status, 302, await response.text());
            const actual = f.store.get('Consent', consent.id), snapshot = f.store.privateRecords.approvals.getDecision(actual.id).snapshot;
            assert.equal(actual.status, 'active'); assert.equal(snapshot.scope, manual ? MANUAL_SCOPE : DEFAULT_SCOPE);
            assert.equal(snapshot.choice, manual ? 'custom' : 'service-provided'); assert.equal(snapshot.usable, true); saved.push(structuredClone(actual));
        }
        assert.deepEqual(f.store.get('Consent', first.id), saved[0], 'manual approval cannot mutate the prior default decision');
        assert.equal(f.store.privateRecords.approvals.getDecision(saved[1].id).snapshot.scope, MANUAL_SCOPE);
    } finally { await f.close(); }
});
