'use strict';
/** Real Admin institution selector saves/reloads and contextual help; only owned sources are changed. */
const { test, expect } = require('@playwright/test');
const pcm = process.env.PCM_UI_PCM_URL;

test('Admin classifies built-in and custom sources through accessible forms @smoke', async ({ browser, page }, info) => {
    expect(pcm, 'owned disposable PCM URL is required').toBeTruthy();
    const mobile = info.project.name === 'chromium-mobile';
    const context = mobile ? await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }) : null;
    if (context) page = await context.newPage();
    let id, original, builtinId;
    const login = async () => {
        const response = await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
        expect(response.ok()).toBeTruthy();
    };
    try {
        await login(); await page.goto(`${pcm}/admin?section=sources`);await page.locator('[data-source-hosting=managed]').first().click();
        const first = page.locator('[data-source-institution-form]').first();
        original = await first.locator('select').inputValue();
        builtinId = await first.locator('..').getAttribute('data-source-id');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        if (mobile) await first.locator('select').tap(); else await first.locator('select').focus();
        await expect(page.getByRole('tooltip')).toContainText('independent of its hosting');
        await page.keyboard.press('Escape');
        await first.locator('select').selectOption('hospital');
        if (mobile) await first.getByRole('button', { name: 'Save institution type' }).tap(); else await first.getByRole('button', { name: 'Save institution type' }).click();
        await expect(page.getByText('Institution type saved.', { exact: true })).toContainText('Institution type saved.');
        await expect(page.locator('[data-source-institution-form]').first().locator('select')).toHaveValue('hospital');
        const state=await (await page.request.get(`${pcm}/admin`,{headers:{Accept:'application/json'}})).json();
        const add = await page.request.post(`${pcm}/admin/config/data-sources/add`, { data: { expectedRevision:(state.config||state).runtime.revision||0, name: `Owned institution ${info.project.name}`, endpoint: 'https://owned-browser-hmo.example.test/fhir', institutionType: 'hmo', generateCertificate: true } });
        expect(add.status()).toBe(201); id = (await add.json()).dataSource.id;
        await page.goto(`${pcm}/admin?section=sources&source=${encodeURIComponent(id)}`);await page.getByRole('checkbox',{name:'Explain this page'}).check();
        const dynamic = page.locator('[data-source-command]');
        await expect(dynamic.locator('select[name=institutionType]')).toHaveValue('hmo');
        await dynamic.locator('select[name=institutionType]').focus();
        await expect(page.getByRole('tooltip')).toContainText('classification alone does not prove a patient exists');
        await page.keyboard.press('Escape');
        await dynamic.locator('select[name=institutionType]').selectOption('other');
        await dynamic.getByRole('button',{name:'Review changes',exact:true}).click();await dynamic.getByRole('button',{name:'Publish changes',exact:true}).click();
        await expect(page.locator('[data-source-workspace] select[name=institutionType]')).toHaveValue('other');
        const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    } finally {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'x-admin-password': process.env.PCM_UI_ADMIN_PASSWORD };
        if (builtinId) {
            const response = await fetch(`${pcm}/admin`, { headers });
            expect(response.ok, 'read owned cleanup revision').toBeTruthy();
            const state = await response.json(); const config = state.config || state;
            const restored = await fetch(`${pcm}/admin/config/data-sources/${builtinId}/institution`, { method: 'POST', headers,
                body: JSON.stringify({ institutionType: original, expectedRevision: config.runtime.revision }) });
            expect(restored.ok, 'restore owned built-in classification').toBeTruthy();
        }
        if (id) {
            for(const action of ['disable','remove']) {
                const state=await (await fetch(`${pcm}/admin`,{headers})).json();
                const removed=await fetch(`${pcm}/admin/config/data-sources/remove`,{method:'POST',headers,body:JSON.stringify({id,action,expectedRevision:(state.config||state).runtime.revision||0})});
                expect(removed.ok,'remove owned custom source').toBeTruthy();
            }
        }
        await context?.close();
    }
});
