'use strict';
/** Current five-page rendering, private authority preservation and advisory OTP state. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

/** Follow real local routes with an isolated browser cookie jar. */
function browser() {
    const cookies = new Map();
    return async (url, body) => {
        const response = await fetch(url, { redirect: 'manual', method: body ? 'POST' : 'GET',
            headers: { Accept: 'text/html', Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
            body: body ? new URLSearchParams(body) : undefined });
        for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
        return { response, html: await response.text() };
    };
}

/** Assert the common landmark/Explain binding without interpreting it as an authority check. */
function shell(html) {
    assert.match(html, /class="sandbox-header/); assert.match(html, /class="sandbox-heading/);
    assert.match(html, /class="sandbox-navigation/); assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.equal((html.match(/type="checkbox" data-help-key="common.explain"|<input type="checkbox">/g) || []).length, 1);
}

test('five actual portal templates cover pending/saved, field error, expired OTP and safe SMART failure without passive writes', async () => {
    const f = await require('../../../test-support/portal-ui-fixture').startPortalFixture();
    const get = browser();
    try {
        const consent = f.approval.create(), before = JSON.stringify(f.approval.store.get('Consent', consent.id));
        const registry = (await get(f.approval.base + '/ui')).html; shell(registry);
        assert.match(registry, /aria-current="page"[^>]*data-help-key="common.nav-consents"/);
        const review = (await get(f.approval.base + '/ui/approve/' + consent.id)).html; shell(review);
        assert.match(review, /name="expectedVersion"/); assert.match(review, /name="approvalReview"/);
        assert.match(review, /name="action" value="approve"/); assert.match(review, /name="action" value="decline"/);
        assert.equal(JSON.stringify(f.approval.store.get('Consent', consent.id)), before);
        const saved = require('../src/fhir/consent-lifecycle').approveConsent({ store: f.approval.store, consent, sourceOrganizationIds: [] });
        const details = (await get(f.approval.base + '/ui/approve/' + saved.id)).html; shell(details);
        assert.match(details, /data-source-apply disabled/); assert.match(details, /aria-label="Consent facts"/); assert.match(details, /Approved data access/);
        assert.match(details, /data-consent-cancellation/); assert.doesNotMatch(details, /name="scopeChoice"/);
        require('../src/fhir/consent-lifecycle').expireConsent({ store: f.approval.store, consent: saved, now: new Date('2030-01-01T00:00:00Z') });
        const expiredDetails = (await get(f.approval.base + '/ui/approve/' + saved.id)).html;
        assert.match(expiredDetails, /Permanently inactive/); assert.match(expiredDetails, /Approval period expired/);
        assert.doesNotMatch(expiredDetails, /data-source-change|name="scopeChoice"/);

        const auth = f.base + '/sandbox/authentication';
        let page = (await get(auth)).html; shell(page);
        assert.doesNotMatch(page, /Open Admin|Review related logs|Technical details|href="[^"]*logs/);
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
        const kinds = f.config.healthOrganizations.map(source => source.institutionType);
        f.config.healthOrganizations.forEach(source => { source.institutionType = 'hospital'; });
        const noHmo = (await get(auth)).html; shell(noHmo);
        assert.match(noHmo, /No HMO is ready/); assert.match(noHmo, /id="home-hmo"[^>]*disabled/);
        assert.doesNotMatch(noHmo, /Open Admin|Review related logs/);
        f.config.healthOrganizations.forEach((source, index) => { source.institutionType = kinds[index]; });

        await get(auth + '/start', { csrf, homeHmoId: f.config.healthOrganizations[0].dataSourceOrganization.id, system: f.strongPatient.system, identifier: f.strongPatient.value, birthDate: '1980-02-30' });
        page = (await get(auth)).html; assert.match(page, /id="birthDate"[^>]*aria-invalid="true" aria-describedby="workflow-feedback"/);
        await get(auth + '/start', { csrf, homeHmoId: f.config.healthOrganizations[0].dataSourceOrganization.id, system: f.strongPatient.system, identifier: f.strongPatient.value, birthDate: '1980-01-02' });
        page = (await get(auth)).html; assert.match(page, /data-code-status[^>]*workflow.otp-status/); assert.doesNotMatch(page, /Portal Test Patient/);
        f.advance(f.config.systemAuthorization.otp.lifetimeSeconds || 600);
        page = (await get(auth)).html; assert.match(page, /expired|unavailable/);
        const smart = (await get(f.smartUrl())).html; shell(smart); assert.match(smart, /data-smart-approve[^>]*disabled/);
        const transaction = /name="transaction_id" value="([^"]+)"/.exec(smart)[1];
        f.advance(601);
        const error = await get(f.base + '/api/fhir-service/r4/authorize/resume?transaction_id=' + transaction);
        shell(error.html); assert.match(error.html, /Start a fresh request/); assert.ok(error.html.includes(`href="${f.base}/doctor"`));
        assert.doesNotMatch(error.html, /Technical error|<code>|Open Admin/);
        assert.equal(f.requests.filter(row => row.method === 'POST').length, 2);
        assert.equal(f.approval.store.get('Consent', consent.id).status, 'inactive');
    } finally { await f.close(); }
});

test('OTP timer changes its visible recovery and Explain binding at expiry without resending or extending authority', () => {
    let current = 1000, tick;
    const verify = { dataset: { expiresAt: '1001', attemptsRemaining: '2' } }, resend = { dataset: { resendAt: '1002', permanentlyDisabled: 'false' } }, status = { dataset: {} };
    const nodes = { '[data-code-verify]': verify, '[data-code-resend]': resend, '[data-code-status]': status };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../shared/ui/system-authentication.js'), 'utf8'), {
        document: { addEventListener: (_, callback) => callback(), querySelector: selector => nodes[selector], querySelectorAll: () => [] },
        addEventListener() {}, Date: { now: () => current * 1000 }, setInterval(callback) { tick = callback; }, clearInterval() {}
    });
    assert.equal(verify.disabled, false); assert.equal(resend.disabled, true); assert.equal(status.dataset.helpKey, 'workflow.otp-status');
    current = 1001; tick(); assert.equal(verify.disabled, true); assert.match(status.textContent, /code expired/); assert.equal(status.dataset.helpKey, 'workflow.code-expired');
    current = 1002; tick(); assert.equal(resend.disabled, false); assert.equal(verify.dataset.expiresAt, '1001');
    verify.dataset.attemptsRemaining = '0'; tick(); assert.match(status.textContent, /No attempts remain/); assert.equal(status.dataset.helpKey, 'workflow.attempts');
});

test('authentication pending feedback preserves native submission and blocks a repeated submit', () => {
    let submit, focused = false, prevented = false;
    const attrs = {}, form = { getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value; }, addEventListener: (_, callback) => { submit = callback; } };
    const busy = { hidden: true, focus() { focused = true; } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../shared/ui/system-authentication.js'), 'utf8'), {
        document: { addEventListener: (_, callback) => callback(), querySelector: selector => selector === '[data-workflow-busy]' ? busy : null, querySelectorAll: () => [form] }, addEventListener() {}
    });
    submit({ preventDefault() { prevented = true; } });
    assert.equal(attrs['aria-busy'], 'true'); assert.equal(busy.hidden, false); assert.equal(focused, true); assert.equal(prevented, false);
    submit({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    assert.equal(form.disabled, undefined, 'the submitted form/submitter is not disabled before native serialization');
});
