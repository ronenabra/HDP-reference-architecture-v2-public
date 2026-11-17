'use strict';
/** Actual Admin source controls and authored Explain behavior; the caller owns a disposable runtime. */
const { test, expect } = require('@playwright/test');
const pcm = process.env.PCM_UI_PCM_URL;

test('Source credential generation explains validated EC roles on desktop and touch @smoke', async ({ browser, page }, info) => {
    expect(pcm, 'disposable PCM UI URL is required').toBeTruthy();
    const mobile = info.project.name === 'chromium-mobile';
    const context = mobile ? await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true }) : null;
    if (context) page = await context.newPage();
    let id;
    try {
        if (process.env.PCM_UI_ADMIN_PASSWORD) {
            const login = await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
            expect(login.ok()).toBeTruthy();
        }
        await page.goto(`${pcm}/admin?section=sources&view=onboarding`);
        const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
        await toggle.check();
        const profile = page.locator('[name=credentialProfile]');
        if (mobile) await profile.tap(); else await profile.focus();
        await expect(page.getByRole('tooltip')).toContainText('P-256');
        await expect(page.getByRole('tooltip')).toContainText('P-384');
        await page.keyboard.press('Escape');
        await page.locator('[name=credentialMode]').selectOption('upload');
        await page.locator('[name=pcmClientAuthKeyFile]').focus();
        await expect(page.getByRole('tooltip')).toContainText('matches the client certificate');
        await page.keyboard.press('Escape');
        const state = await (await page.request.get(`${pcm}/admin`, { headers: { Accept: 'application/json' } })).json();
        const created = await page.request.post(`${pcm}/admin/config/data-sources/add`, { data: {
            expectedRevision: (state.config || state).runtime.revision || 0, name: `Browser credential fixture ${info.project.name}`, endpoint: 'https://owned-browser-source.example.test/fhir', generateCertificate: true
        } });
        expect(created.status()).toBe(201); id = (await created.json()).dataSource.id;
        await page.goto(`${pcm}/admin?section=sources&source=${encodeURIComponent(id)}&view=credentials`);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const dynamic = page.locator(`form[action$="/admin/config/data-sources/${id}/cert/generate"] button`);
        await dynamic.focus(); // Ordinary action taps submit; keyboard focus reads its explanation without regenerating.
        await expect(page.getByRole('tooltip')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.goto(`${pcm}/admin?section=security`);await page.getByRole('checkbox',{name:'Explain this page'}).check();
        const disabled = page.locator('#simulation-publicClientMtls');
        if (await disabled.isDisabled()) {
            const explanation = page.locator('[data-help-for="simulation.publicClientMtls"]').first();
            await explanation.focus();
            await expect(page.getByRole('tooltip')).toContainText(/strict/i);
            if (mobile) {
                await explanation.tap();
                await expect(page.getByRole('tooltip')).toBeHidden();
                await explanation.tap();
                await expect(page.getByRole('tooltip')).toContainText(/strict/i);
            }
        }
        await page.keyboard.press('Escape');
        await page.goto(`${pcm}/admin?section=certificates`);await page.getByRole('checkbox',{name:'Explain this page'}).check();
        const renewal = page.locator('button[data-help-key="admin.cert-regenerate"]');
        await renewal.focus();
        await expect(page.getByRole('tooltip')).toContainText('This button changes no credentials');
        await page.keyboard.press('Escape');
        page.once('dialog', dialog => dialog.accept());
        if (mobile) await renewal.tap(); else await renewal.click();
        await expect(page.locator('body')).toContainText('Certificate renewal requires controlled listener recreation. No credentials were changed.');
        const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    } finally {
        if (id) {
            const headers = { Accept:'application/json','Content-Type':'application/json',...(process.env.PCM_UI_ADMIN_PASSWORD ? {'x-admin-password':process.env.PCM_UI_ADMIN_PASSWORD}:{}) };
            for (const action of ['disable','remove']) {
                const state=await (await fetch(`${pcm}/admin`,{headers})).json();
                const removed=await fetch(`${pcm}/admin/config/data-sources/remove`,{method:'POST',headers,body:JSON.stringify({id,action,expectedRevision:(state.config||state).runtime.revision||0}),signal:AbortSignal.timeout(10000)});
                expect(removed.ok,'owned browser fixture cleanup').toBeTruthy();
            }
        }
        await context?.close();
    }
});
