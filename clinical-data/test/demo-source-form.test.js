'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourceChangeFields } = require('./demo-source-form');
test('source commands use their own version and CSRF even when cancellation appears first', () => {
    const html = '<form data-cancel><input name="expectedVersion" value="old"><input name="csrf" value="cancel-token"></form>'
        + '<form data-source-change action="/sources"><input name="expectedVersion" value="7"><input name="csrf" value="source-token"></form>';
    assert.deepEqual(sourceChangeFields(html), { expectedVersion: '7', csrf: 'source-token' });
});
test('source form extraction rejects absent or incomplete source credentials', () => {
    assert.throws(() => sourceChangeFields('<form><input name="csrf" value="cancel"></form>'), /no source-change form/);
    assert.throws(() => sourceChangeFields('<form data-source-change><input name="csrf" value="token"></form>'), /no expectedVersion/);
    assert.throws(() => sourceChangeFields('<form data-source-change><input name="expectedVersion" value="7"></form>'), /no csrf/);
});


test('current real approved Consent exposes source settings with its own version and token', async () => {
    const { startApprovalFixture } = require('../../test-support/approval-scope-fixture');
    const fixture = await startApprovalFixture();
    try {
        const consent = fixture.create();
        const pending = await (await fetch(`${fixture.base}/ui/approve/${consent.id}`)).text();
        const decode = value => value.replace(/&amp;|&lt;|&gt;|&#34;|&#39;/g, key => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#34;': '"', '&#39;': "'" })[key]);
        const field = name => decode(pending.match(new RegExp(`name="${name}" value="([^"<>]*)"`))[1]);
        const body = new URLSearchParams({ action: 'approve', expectedVersion: field('expectedVersion'),
            approvalReview: field('approvalReview'), scopeChoice: 'service-provided', sources: fixture.config.healthOrganizations[0].dataSourceOrganization.id });
        const approved = await fetch(`${fixture.base}/ui/approve/${consent.id}`, { method: 'POST', redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        assert.equal(approved.status, 302, await approved.text());
        const html = await (await fetch(`${fixture.base}/ui/approve/${consent.id}`)).text();
        assert.ok(html.includes('Test a source-list change'));
        assert.ok(html.includes('Saving changes does not record a new patient approval'));
        const fields = sourceChangeFields(html);
        assert.equal(fields.expectedVersion, fixture.store.get('Consent', consent.id).meta.versionId);
        assert.ok(fields.csrf.length > 20);
        assert.match(html, /data-cancellation-settings/);
    } finally { await fixture.close(); }
});
