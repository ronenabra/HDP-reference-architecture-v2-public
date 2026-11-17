'use strict';
/** Real local portal forms and shared Explain, with deterministic synthetic source responses. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO;
if (!root || !fs.existsSync(path.join(root, 'test-support/portal-ui-fixture.js'))) throw new Error('Required read-only current repository fixture is missing');

/** Record exact wire form/JSON submissions and fail on unexpected browser errors. */
function capture(page) {
    const posts = [], errors = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push({ url: request.url(), body: request.postData() }); });
    page.on('pageerror', error => errors.push(error.message));
    return { posts, errors };
}

/** Check all required widths, ordinary keyboard dismissal and native touch on a blocked action. */
async function inspect(page, info, name, helpTarget, text, disabled = false) {
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) {
        await toggle.uncheck(); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => { document.body.style.zoom = String(value); }, zoom);
        const before = await helpTarget.boundingBox(); await toggle.check();
        const after = await helpTarget.boundingBox(); expect(after).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(await page.locator('.explain-affordance').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).position === 'absolute' && parseFloat(getComputedStyle(node).width) <= 1))).toBe(true);
        if (width === 390 || width === 1440) await page.screenshot({ path: info.outputPath(`${name}-${width}-${zoom}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.body.style.zoom = '1'; }); await page.setViewportSize({ width: 390, height: 1000 });
    if (disabled) {
        await helpTarget.scrollIntoViewIfNeeded(); const box = await helpTarget.boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else await helpTarget.focus();
    await expect(page.getByRole('tooltip')).toContainText(text);
    await page.getByRole('button', { name: 'Dismiss explanation' }).tap();
    await expect(page.getByRole('tooltip')).toBeHidden();
    if (disabled) await expect(toggle).toBeFocused(); else await expect(helpTarget).toBeFocused();
    await toggle.focus();
    // Keyboard proxy describes the exact disabled action, without submitting it.
    if (disabled) await page.locator(`[data-help-for="${await helpTarget.getAttribute('data-help-key')}"]`).first().focus(); else await helpTarget.focus();
    await expect(page.getByRole('tooltip')).toContainText(text); await page.keyboard.press('Escape');
    await toggle.uncheck();
}

test('PORTAL actual approval, source discard/save and cancellation retain exact command owners and immutable scope', async ({ page }, info) => {
    const f = await require(path.join(root, 'test-support/portal-ui-fixture')).startPortalFixture();
    const { posts, errors } = capture(page);
    try {
        const consent = f.approval.create(undefined, true);
        await page.goto(f.approval.base + '/ui');
        await inspect(page, info, 'registry', page.getByRole('link', { name: 'Review', exact: true }), 'Review');
        expect(posts).toEqual([]); expect(f.approval.store.get('Consent', consent.id).status).toBe('proposed');
        await page.getByRole('link', { name: 'Review', exact: true }).tap();
        await expect(page).toHaveURL(f.approval.base + '/ui/approve/' + consent.id);
        await inspect(page, info, 'approval', page.getByRole('button', { name: 'Approve request', exact: true }), 'Approve');
        expect(posts).toEqual([]);
        const form = page.locator('[data-scope-approval]');
        const expectedVersion = await form.locator('[name="expectedVersion"]').inputValue();
        const review = await form.locator('[name="approvalReview"]').inputValue();
        for (const box of await form.locator('[name="sources"]').all()) await box.uncheck();
        await page.locator('#scope-service-provided').check();
        await page.getByRole('button', { name: 'Approve request', exact: true }).tap();
        await expect(page).toHaveURL(f.approval.base + '/ui');
        const wire = new URLSearchParams(posts[0].body);
        expect(wire.get('action')).toBe('approve'); expect(wire.get('expectedVersion')).toBe(expectedVersion); expect(wire.get('approvalReview')).toBe(review);
        expect(wire.get('scopeChoice')).toBe('service-provided'); expect(wire.getAll('sources')).toEqual([]);
        expect(f.approval.store.get('Consent', consent.id).status).toBe('active');
        const decision = JSON.stringify(f.approval.store.privateRecords.approvals.getDecision(consent.id));
        await page.getByRole('link', { name: 'View Consent', exact: true }).tap();
        await inspect(page, info, 'details', page.locator('[data-source-apply]'), 'Change at least one source selection', true);
        expect(posts).toHaveLength(1);
        const before = posts.length;
        const box = page.locator('[data-source-change] input[name="sourceIds"]').first(); await box.check();
        await expect(page.locator('[data-source-apply]')).toBeEnabled();
        await page.locator('[data-source-cancel]').tap(); await expect(box).not.toBeChecked(); expect(posts).toHaveLength(before);
        await box.check(); const source = await box.getAttribute('value');
        const sourceVersion = await page.locator('[data-source-change] [name="expectedVersion"]').inputValue();
        const sourceCsrf = await page.locator('[data-source-change] [name="csrf"]').inputValue();
        await page.locator('[data-source-apply]').tap(); await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('[data-source-apply]')).toBeDisabled(); await expect(box).toBeChecked();
        expect(JSON.parse(posts.at(-1).body)).toMatchObject({ action: 'apply', sourceIds: [source], expectedVersion: sourceVersion, csrf: sourceCsrf });
        expect(JSON.stringify(f.approval.store.privateRecords.approvals.getDecision(consent.id))).toBe(decision);

        const cancelForm = page.locator('[data-consent-cancellation]');
        const cancellation = Object.fromEntries(await cancelForm.locator('input[type="hidden"]').evaluateAll(nodes => nodes.map(node => [node.name, node.value])));
        const count = posts.length;
        page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).tap(); expect(posts).toHaveLength(count);
        page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).tap();
        await expect(page.locator('[data-consent-status]')).toContainText('Service Provider cancelled');
        expect(f.approval.store.get('Consent', consent.id).status).toBe('inactive');
        expect(JSON.parse(posts.at(-1).body)).toEqual(cancellation);
        await page.screenshot({ path: info.outputPath('cancelled-390.png'), fullPage: true });
        expect(JSON.stringify(f.approval.store.privateRecords.approvals.getDecision(consent.id))).toBe(decision);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('approval-source-cancellation-wire.json'), JSON.stringify({ posts, errors, consent: f.approval.store.get('Consent', consent.id), decision }, null, 2));
    } finally { await f.close(); }
});

test('PORTAL rejection, OTP field/expiry/retry and SMART return keep original state and safe destinations', async ({ page }, info) => {
    const f = await require(path.join(root, 'test-support/portal-ui-fixture')).startPortalFixture();
    const { posts, errors } = capture(page);
    try {
        const consent = f.approval.create(); await page.goto(f.approval.base + '/ui/approve/' + consent.id);
        await page.getByRole('button', { name: 'Decline request', exact: true }).tap(); await expect(page).toHaveURL(f.approval.base + '/ui');
        expect(new URLSearchParams(posts.at(-1).body).get('action')).toBe('decline'); expect(f.approval.store.get('Consent', consent.id).status).toBe('rejected');
        await page.goto(f.smartUrl());
        await inspect(page, info, 'authorize', page.locator('[data-smart-approve]'), 'Verify your own', true);
        expect(f.sourceCalls()).toBe(0);
        const transaction = await page.locator('[name="transaction_id"]').inputValue();
        await page.getByRole('link', { name: 'Test sign-in through an HMO', exact: true }).tap();
        await expect(page).toHaveURL(f.base + '/sandbox/authentication?smart=' + transaction);
        const auth = page.url();
        await inspect(page, info, 'authentication', page.locator('#identifier'), 'identifier');
        await expect(page.getByRole('link', { name: /Admin|Logs/ })).toHaveCount(0);
        expect(f.sourceCalls()).toBe(0); expect(posts).toHaveLength(1);
        await page.locator('#home-hmo').selectOption(f.config.healthOrganizations[0].dataSourceOrganization.id);
        await page.locator('#identifier').fill(f.strongPatient.value); await page.locator('#birthDate').fill('1980-01-02');

        let pendingState;
        await page.exposeFunction('recordPortalPending', state => { pendingState = state; });
        await page.evaluate(() => document.addEventListener('submit', () => window.recordPortalPending({
            hidden: document.querySelector('[data-workflow-busy]').hidden,
            busy: document.querySelector('[data-workflow-start]').getAttribute('aria-busy')
        }), { once: true }));
        await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).tap();
        await expect.poll(() => pendingState).toEqual({ hidden: false, busy: 'true' });
        await expect(page.locator('[data-code-verify]')).toBeEnabled(); await expect(page.locator('[data-code-status]')).toContainText('Enter the current code');
        await page.locator('#code').fill('000000'); await page.locator('[data-code-verify]').tap();
        await expect(page.locator('#workflow-feedback')).toBeVisible();
        await expect(page.locator('#code')).toHaveAttribute('aria-invalid', 'true');
        await expect(page.locator('#code')).toHaveAttribute('aria-describedby', 'workflow-feedback');
        expect(page.url()).toBe(auth); expect(f.sourceCalls()).toBe(1);
        await page.getByRole('link', { name: 'Return without signing in', exact: true }).tap();
        await expect(page.locator('[name="transaction_id"]')).toHaveValue(transaction);
        await page.getByRole('button', { name: 'Cancel and return to Doctor', exact: true }).tap();
        await expect(page).toHaveURL(f.base + '/doctor?error=access_denied&error_description=The+test+launch+was+cancelled.&state=portal-exact-state');
        await page.goto(f.base + '/sandbox/authentication');
        // Advance only the owned server/browser clocks together; neither deadline is extended.
        f.advance(f.config.systemAuthorization.otp.expirySeconds + 1);
        await page.clock.setFixedTime(new Date(f.now() * 1000)); await page.reload();
        await expect(page.locator('[data-code-verify]')).toBeDisabled();
        await expect(page.locator('[data-code-status]')).toContainText('expired');
        await inspect(page, info, 'otp-expired', page.locator('[data-code-verify]'), 'expired', true);
        await page.locator('[data-code-resend]').tap(); await expect(page.locator('[data-code-verify]')).toBeEnabled();
        await page.locator('#code').fill('123456'); await page.locator('[data-code-verify]').tap();
        await expect(page.getByRole('heading', { name: 'Verified test patient', exact: true })).toBeVisible();
        await inspect(page, info, 'verified', page.getByRole('button', { name: 'Find or refresh dependents', exact: true }), 'eligible');
        await page.goto(f.smartUrl());
        const expired = await page.locator('[name="transaction_id"]').inputValue();
        f.advance(601); await page.clock.setFixedTime(new Date(f.now() * 1000));
        await page.goto(f.base + '/api/fhir-service/r4/authorize/resume?transaction_id=' + expired);
        await expect(page.getByRole('heading', { name: /SMART test could not continue/ })).toBeVisible();
        await inspect(page, info, 'authorize-error', page.getByRole('link', { name: 'Return to Doctor for a fresh test', exact: true }), 'fresh');
        await expect(page.getByRole('link', { name: 'Return to Doctor for a fresh test', exact: true })).toHaveAttribute('href', f.base + '/doctor');
        expect(f.approval.store.get('Consent', consent.id).status).toBe('rejected'); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('rejection-expiry-return-wire.json'), JSON.stringify({ posts, errors, transaction, sourceCalls: f.sourceCalls(), browser: await page.evaluate(() => navigator.userAgent) }, null, 2));
    } finally { await f.close(); }
});
