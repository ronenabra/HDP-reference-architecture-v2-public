'use strict';

/** Exercise help on real local page families without bypassing listener authentication. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');
const { installOwnedSmartCancellation } = require('./helpers/owned-smart-cancellation');
const { doctorServiceSelection } = require('../../scripts/sanity-data-state');
const { assertBindings, firstPageHelpTarget } = require('./helpers/help-bindings');
const pcm = process.env.PCM_UI_PCM_URL;
const sp = process.env.PCM_UI_SP_URL;

async function login(page) {
    if (process.env.PCM_UI_ADMIN_PASSWORD) {
        const response = await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
        expect(response.ok()).toBeTruthy();
    }
}

/** Help-only interactions must leave form values and application mutation traffic unchanged. */
async function exercise(page) {
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await expect(toggle).toBeVisible();
    await assertBindings(page, expect);
    const values = () => page.locator('form input,form select,form textarea').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked]));
    const before = await values();
    const mutations = [];
    const observe = request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.method()); };
    page.on('request', observe);
    await toggle.check();
    const target = firstPageHelpTarget(page);
    await target.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
    await target.blur();
    await target.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    expect(await values()).toEqual(before);
    expect(mutations).toEqual([]);
    page.off('request', observe);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter(item => ['serious', 'critical'].includes(item.impact))).toEqual([]);
    await toggle.uncheck();
    await expect(page.locator('.explain-affordance')).toHaveCount(0);
}

// Each page has its own context and bounded audit. Sharing one deadline across
// seven independent Axe scans made the last page inherit the earlier costs.
for (const [name, url] of [
    ['Admin', `${pcm}/admin`], ['Admin logs', `${pcm}/admin/logs/view`],
    ['Doctor', `${sp}/`], ['Doctor patient library', `${sp}/patients`], ['Doctor management', `${sp}/manage`],
    ['Doctor logs', `${sp}/logs-view`], ['PCM consent', `${pcm}/ui`],
    ['PCM central logs', `${pcm}/logs-view`]
]) {
    test(`Explain this page covers ${name} without mutations @smoke`, async ({ page }, testInfo) => {
        // WebKit's complete Axe scan over3386 actual local rows took113.6s.
        // Preserve the full DOM/assertions, pause live replacement and give that tool a finite budget.
        test.setTimeout(name === 'Doctor logs' ? 240000 : 120000);
        await login(page);
        await page.goto(url);
        if (name === 'Doctor logs') {
            await expect(page.locator('#local-log-status')).not.toContainText('Loading');
            await page.getByRole('checkbox', { name: 'Pause updates', exact: true }).check();
            await testInfo.attach('local-log-accessibility-scope', { body: JSON.stringify({
                completeDom: true, recordedRows: await page.locator('.log-entry').count(), pausedUpdates: true, axeCaseBudgetMilliseconds: 240000
            }), contentType: 'application/json' });
        }
        await exercise(page);
    });
}

test('Explain this page works before Admin login and on authenticated SMART authorization', async ({ page, browser }, testInfo) => {
    test.setTimeout(90000);
    expect(process.env.PCM_UI_ADMIN_PASSWORD, 'required nonempty selected-team Admin authentication fixture').toBeTruthy();
    {
        await page.goto(`${pcm}/admin?section=security`);
        await expect(page.locator('#adminPassword')).toBeVisible();
        await exercise(page);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('#adminPassword').fill(process.env.PCM_UI_ADMIN_PASSWORD);
        await page.getByRole('button', { name: 'Open Admin', exact: true }).click();
        await expect(page.locator('[data-simulation-form]')).toBeVisible();
        await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeChecked();
        await testInfo.attach('admin-login-executed', { body: JSON.stringify({ nonemptyFixture: true, loginFormExercised: true, authenticatedAdminVisible: true }), contentType: 'application/json' });
    }
    const response = await page.request.get(`${pcm}/admin/status`);
    expect(response.ok()).toBeTruthy();
    const config = (await response.json()).config;
    expect(config.teamId).toBe(process.env.PCM_UI_TEAM_ID);
    expect(new URL(sp).origin).toBe(new URL(config.publicBaseUrls.spClient).origin);
    expect(new URL(pcm).origin).toBe(new URL(config.publicBaseUrls.pcmUi).origin);
    const certs = process.env.PCM_UI_CERTS_DIR || '/certs';
    const role = config.certificateRoles.serviceProvider.mtls;
    const mobile = testInfo.project.name === 'chromium-mobile';
    const contextSettings = { viewport: page.viewportSize(),
        hasTouch: testInfo.project.use.hasTouch ?? mobile,
        isMobile: testInfo.project.use.isMobile ?? mobile };
    await testInfo.attach('smart-help-context', { body: JSON.stringify({ project: testInfo.project.name, ...contextSettings }), contentType: 'application/json' });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, ...contextSettings, clientCertificates: [{
        origin: new URL(config.publicBaseUrls.pcmApi).origin,
        cert: fs.readFileSync(path.join(certs, role.cert)), key: fs.readFileSync(path.join(certs, role.key))
    }] });
    try {
        const boundary = await installOwnedSmartCancellation(context, {
            allowedOrigins: [sp, pcm, config.publicBaseUrls.pcmApi],
            decisionUrl: new URL('authorize/decision', `${config.publicBaseUrls.pcmApi}/`).href
        });
        const smart = await context.newPage();
        try {
            await smart.goto(`${sp}/smart/start?identity=hospital-a&scope=patient%2F*.rs`);
        } catch (error) { boundary.assertSafe(); throw error; }
        boundary.assertSafe();
        await expect(smart).toHaveURL(/\/authorize\?/);
        const authorization = new URL(smart.url());
        const callback = new URL(authorization.searchParams.get('redirect_uri'));
        const state = authorization.searchParams.get('state');
        await expect(smart.locator('body')).toHaveAttribute('data-help-team', config.teamId);
        await exercise(smart);
        await smart.getByRole('checkbox', { name: 'Explain this page' }).check();
        const [proof] = await Promise.all([
            boundary.expectCancellation(callback.href, state),
            smart.getByRole('button', { name: 'Cancel and return to Doctor', exact: true })[contextSettings.hasTouch ? 'tap' : 'click']()
        ]);
        expect(proof.upstreamStatus).toBe(302);
        expect(proof.nativeCancelSubmitted).toBe(true);
        expect(boundary.blocked).toEqual([]);
        await expect(smart).toHaveURL(new URL('authorize/decision', `${config.publicBaseUrls.pcmApi}/`).href);
        await testInfo.attach('owned-smart-cancellation', {
            body: JSON.stringify({ ...proof, ownedNavigationHops: boundary.ownedNavigationHops, foreignRequests: boundary.blocked.length }), contentType: 'application/json'
        });
    } finally { await context.close(); }
});

test('pending catalog Consent exposes the selected-service scope explanation @smoke', async ({ page }) => {
    await login(page);
    const config = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    const before = new Set((await (await page.request.get(`${pcm}/admin/consents`)).json()).consents.map(item => item.id));
    const composer = await page.request.get(`${sp}/?identity=hospital-a`);
    expect(composer.ok()).toBeTruthy();
    const selection = doctorServiceSelection(await composer.text(), config, 'hospital-a');
    await page.request.post(`${sp}/create-consent`, { form: { identity: 'hospital-a', ...selection,
        patientId: 'http://fhir.health.gov.il/identifier/il-national-id|000000018' } });
    const consent = (await (await page.request.get(`${pcm}/admin/consents`)).json()).consents.find(item => !before.has(item.id));
    expect(consent?.status).toBe('proposed');
    try {
        await page.goto(`${pcm}/ui/approve/${consent.id}`);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('#scope-auto-resources').focus();
        await expect(page.getByRole('tooltip')).toContainText('Generated data types');
    } finally {
        const declined = await page.request.post(`${pcm}/admin/consents/${consent.id}/decline`, { headers: { Accept: 'application/json' }, data: {} });
        expect(declined.ok()).toBeTruthy();
    }
});
