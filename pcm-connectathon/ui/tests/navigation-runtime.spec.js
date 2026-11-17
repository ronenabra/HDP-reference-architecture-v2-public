'use strict';
/** Real rendered navigation/own-page calls at root or an explicitly configured proxy mount. */
const { test, expect } = require('@playwright/test');
const sp = process.env.PCM_UI_SP_URL, pcm = process.env.PCM_UI_PCM_URL;
const path = base => new URL(base).pathname.replace(/\/$/, '');

test('Doctor and PCM navigation retain configured mounts and recovery paths @smoke', async ({ browser, page }, info) => {
    test.setTimeout(90000);
    const context = info.project.name === 'chromium-mobile' ? await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true }) : null;
    if (context) page = await context.newPage();
    page.setDefaultTimeout(12000);
    const missing = []; page.on('response', response => { if (response.status() === 404) missing.push(response.url()); });
    try {
        await page.goto(sp);
        await expect(page.locator('form[action$="/create-consent"]')).toHaveAttribute('action', `${path(sp)}/create-consent`);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const team = page.locator('h1 [data-help-key="common.team"]').first();
        if (context) await team.tap(); else await team.focus();
        await expect(page.getByRole('tooltip')).toContainText('Team badge'); await page.keyboard.press('Escape');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.getByRole('link', { name: 'Open Patient library', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Patient library', exact: true })).toBeVisible();
        await expect(page.locator('form[action$="/patients/select"]').first()).toHaveAttribute('action', `${path(sp)}/patients/select`);
        await page.getByRole('link', { name: 'Return to Doctor', exact: true }).click();
        expect(new URL(page.url()).pathname).toBe(`${path(sp)}/`);
        await page.goto(`${sp}/manage?identity=hospital-a`);
        await expect(page.locator('h1')).toContainText('Manage Organization');
        await page.getByRole('link', { name: 'Back to Doctor', exact: false }).click();
        expect(new URL(page.url()).pathname).toBe(`${path(sp)}/`);
        // Unknown callback state is a local error recovery, not an invented OAuth success.
        await page.goto(`${sp}/callback?state=unregistered-navigation-fixture`);
        expect(new URL(page.url()).pathname).toBe(`${path(sp)}/`);
        await expect(page.getByText('SMART request expired or unavailable.', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Start a fresh SMART test', exact: true })).toHaveAttribute('href', `${path(sp)}/smart/start?identity=hospital-a`);
        await expect(page.getByText('SMART code exchange completed', { exact: false })).toHaveCount(0);
        await page.goto(`${sp}/smart/start?identity=hospital-a&scope=invalid`);
        expect(new URL(page.url()).pathname).toBe(`${path(sp)}/`);
        await expect(page.getByText('SMART test could not start.', { exact: true })).toBeVisible();
        const launch = await page.request.get(`${sp}/smart/start?identity=hospital-a&scope=patient%2F*.rs`, { maxRedirects: 0 });
        expect(launch.status()).toBe(302);
        const authorization = new URL(launch.headers().location);
        expect(authorization.hostname).toBe(new URL(pcm).hostname);
        expect(authorization.pathname).toBe('/api/fhir-service/r4/authorize');
        expect(authorization.searchParams.get('redirect_uri')).toBe(`${sp.replace(/\/$/, '')}/callback`);
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        const interaction = await page.goto(authorization.toString()); expect(interaction.status()).toBe(200);
        await expect(page.locator('form')).toHaveAttribute('action', '/api/fhir-service/r4/authorize/decision');
        // Full callback decisions are qualified separately by the maintained SMART suite.
        const logs = page.waitForResponse(response => new URL(response.url()).pathname === `${path(sp)}/api/logs`);
        await page.goto(`${sp}/logs-view`); expect((await logs).status()).toBe(200);
        const central = page.waitForResponse(response => new URL(response.url()).pathname === `${path(pcm)}/api/unified-logs`);
        await page.goto(`${pcm}/logs-view?role=doctor&diagnostics=true`); expect((await central).status()).toBe(200);
        expect(new URL(page.url()).searchParams.get('role')).toBe('doctor');
        await page.goto(`${pcm}/ui`); await expect(page.locator('h1')).toContainText('Consents');
        await page.goto(`${pcm}/admin`);
        await expect(page.getByLabel('Admin password', { exact: true })).toBeVisible();
        await page.getByLabel('Admin password', { exact: true }).fill(process.env.PCM_UI_ADMIN_PASSWORD);
        await page.getByRole('button', { name: 'Open Admin', exact: true }).click();
        expect(new URL(page.url()).pathname).toBe(`${path(pcm)}/admin`);
        await expect(page.locator('h1')).toContainText('PCM Connectathon Admin');
        const explain = page.getByRole('checkbox', { name: 'Explain this page' });
        await page.getByText('Advanced: deployment URLs and ports', { exact: true }).click();
        await explain.check();
        const urlHeading = page.locator('th[data-help-key="admin.deployment-url"]');
        if (context) await urlHeading.tap(); else await urlHeading.focus();
        await expect(page.getByRole('tooltip')).toContainText('Loopback application links');
        await page.keyboard.press('Escape'); await explain.uncheck();
        const cookies = await page.context().cookies(`${pcm}/admin`);
        expect(cookies.find(cookie => cookie.name === 'teamAdminSession')?.path).toBe(`${path(pcm)}/admin`);
        await page.reload(); await expect(page.getByLabel('Admin password', { exact: true })).toHaveCount(0);
        const popupPromise = page.waitForEvent('popup'); await page.getByRole('link', { name: 'Doctor', exact: true }).click();
        const popup = await popupPromise; await expect(popup.locator('h1')).toContainText('Doctor');
        expect(new URL(popup.url()).pathname.replace(/\/$/, '')).toBe(path(sp)); await popup.close();
        expect(missing, 'in-scope rendered pages and assets must avoid wrong-listener/prefix 404s').toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await context?.close(); }
});
