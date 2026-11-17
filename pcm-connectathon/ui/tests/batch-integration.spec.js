'use strict';

/** Final-candidate seams absent from the older live-team gate; predecessor state matrices stay source-bound. */
const { test, expect } = require('@playwright/test');
const pcm = process.env.PCM_UI_PCM_URL, sp = process.env.PCM_UI_SP_URL;

test('batch38 current application owners preserve context and remain passive', async ({ page }, info) => {
    test.skip(!info.project.name.startsWith('chromium-'), 'Full engine responsiveness is the separate maintained smoke');
    test.setTimeout(120000);
    const login = await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
    expect(login.ok()).toBeTruthy();
    const before = await (await page.request.get(`${pcm}/admin/status`)).json();
    const consents = await (await page.request.get(`${pcm}/admin/consents`)).json();
    expect(Array.isArray(consents.consents)).toBe(true);
    const ownerInventory = async () => {
        const responses = await Promise.all(['inventory', 'providers'].map(name => page.request.get(`${pcm}/admin/services/${name}`)));
        for (const response of responses) expect(response.ok()).toBeTruthy();
        const snapshots = await Promise.all(responses.map(response => response.json()));
        for (const snapshot of snapshots) expect(snapshot.complete).toBe(true);
        return snapshots;
    };
    const originalOwners = await ownerInventory();
    const writes = [], errors = [];
    page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), url: request.url() }); });
    page.on('pageerror', error => errors.push(error.message));
    for (const section of ['overview', 'sources', 'security', 'apps', 'certificates', 'logs', 'maintenance']) {
        const response = await page.goto(`${pcm}/admin?section=${section}`); expect(response.status()).toBe(200);
        await expect(page.locator('.sandbox-header')).toBeVisible();
        await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeVisible();
        if (section === 'security') {
            const capability = page.locator('#own-token-introspection');
            if (before.config.conformance.preset === 'strict') await expect(capability).toBeDisabled();
            else await expect(capability).toBeEnabled();
        }
    }
    await page.goto(`${pcm}/admin/services?view=catalog&providerRole=hospitalBServiceProvider`);
    const builtin = page.locator('[data-catalog-id="demo-catalog-sandbox-full-access"]');
    await expect(builtin).toHaveCount(1);
    await builtin.locator('[data-service-expansion] > summary').click();
    await builtin.getByText('Exact saved service scope', { exact: true }).click();
    await expect(builtin.locator('[data-saved-scope]')).toHaveText('patient/*.rs');
    await builtin.locator('[data-catalog-overflow] > summary').click();
    await expect(builtin.getByRole('button', { name: 'Delete definition' })).toBeDisabled();
    await page.getByRole('link', { name: 'Provider assignments', exact: true }).click();
    await expect(page.locator('[data-service-group="demo-catalog-sandbox-full-access"]')).toHaveCount(1);
    const doctor = page.locator('[data-services-fragment="doctor-return"]');
    expect(new URL(await doctor.getAttribute('href'), pcm).searchParams.get('identity')).toBe('hospital-b');
    await doctor.click(); await expect(page.locator('#doctor-identity')).toHaveValue('hospital-b');
    await page.getByRole('link', { name: 'Patient library', exact: true }).click();
    await expect(page.locator('#patient-load [name="identity"]')).toHaveValue('hospital-b');
    await expect(page.locator('[data-library-group]')).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#library-find').focus(); await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/artifacts/batch38-${info.project.name}.png`, fullPage: true });
    // The existing authenticated draft calculator uses POST without any resource,
    // token or Patient lookup. Prove passivity through protected owner state too.
    const record = { id: 'batch38-manual-copy', timestamp: '2026-11-14T00:00:00Z', level: 'INFO', message: 'Complete local copy fixture', details: { marker: 'whole value' } };
    await page.route(`${sp}/api/logs`, route => route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'X-Log-State': 'available' }, body: JSON.stringify([record]) }));
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Owned clipboard refusal'); } } });
        document.execCommand = () => false;
    });
    await page.goto(`${sp}/logs-view`);
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await page.locator(`[data-log-id="${record.id}"]`).click();
    await page.locator('#pauseSwitch').check();
    await page.locator('#local-tools-button').click(); await page.locator('#copy-local').click();
    const manual = page.getByRole('textbox', { name: 'Manual copy text', exact: true });
    await expect(manual).toBeVisible(); await expect(manual).toHaveValue(JSON.stringify(record, null, 2));
    await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await manual.focus();
    await expect(page.getByRole('tooltip')).toContainText('complete selected local record');
    await page.screenshot({ path: `/artifacts/batch38-copy-help-${info.project.name}.png`, fullPage: true });
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(page.locator('#local-tools')).toBeVisible(); await expect(manual).toHaveValue(JSON.stringify(record, null, 2));
    expect(writes.filter(request => request.method !== 'POST' || request.url !== `${pcm}/admin/services/preview`)).toEqual([]);
    expect(await ownerInventory()).toEqual(originalOwners);
    expect(errors).toEqual([]);
    expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config).toEqual(before.config);
    expect((await (await page.request.get(`${pcm}/admin/consents`)).json()).consents).toEqual(consents.consents);
});
