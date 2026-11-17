'use strict';
/** Disposable real browser round trips through explicit exact callback configurations; no response mocking. */
const { test, expect } = require('@playwright/test');
const pcm = process.env.PCM_UI_PCM_URL, originalDoctor = process.env.PCM_UI_SP_URL;
const headers = { Accept: 'application/json', 'x-admin-password': process.env.PCM_UI_ADMIN_PASSWORD };

test('exact Doctor callbacks complete on configured localhost IP and external hostname @smoke', async ({ browser, page }, info) => {
    test.setTimeout(150000);
    const touch = info.project.name === 'chromium-mobile';
    const context = touch ? await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true }) : null;
    if (context) page = await context.newPage(); page.setDefaultTimeout(12000);
    const configure = async doctorBase => {
        const preview = await page.request.post(`${pcm}/admin/config/doctor-browser/preview`, { headers, data: { doctorBase } }); expect(preview.status(), await preview.text()).toBe(200);
        const plan = await preview.json();
        const applied = await page.request.post(`${pcm}/admin/config/doctor-browser/apply`, { headers, data: { doctorBase, reviewDigest: plan.reviewDigest } }); expect(applied.status(), await applied.text()).toBe(200);
    };
    const consentCount = async () => { const r = await page.request.get(`${pcm}/admin/consents`, { headers }); expect(r.status()).toBe(200); return (await r.json()).consents.length; };
    const begin = async base => {
        await page.goto(base);
        await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.locator('[data-help-key="doctor.smart-start"]').click();
        expect(new URL(page.url()).protocol).toBe('https:');
        await expect(page.locator('form[action$="/authorize/decision"]')).toBeVisible();
        const url = new URL(page.url()); expect(url.searchParams.get('redirect_uri')).toBe(`${base}/callback`); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.has('code_verifier')).toBe(false);
        return url.searchParams.get('state');
    };
    let original;
    try {
        const snapshot = await page.request.get(`${pcm}/admin/backup`, { headers }); expect(snapshot.status()).toBe(200); original = (await snapshot.json()).teamConfig.publicBaseUrls.spClient;
        const count = await consentCount(), seen = new Set();
        const hosts = ['localhost', '127.0.0.1', process.env.PCM_UI_SMART_IP, 'explicit-doctor-browser.test'].filter(Boolean);
        for (const host of hosts) {
            const target = new URL(originalDoctor); target.hostname = host; const base = target.toString().replace(/\/$/, '');
            await configure(base);
            const state = await begin(base); expect(seen.has(state)).toBe(false); seen.add(state);
            await page.getByText('Protocol testing and technical details', { exact: true }).click(); await page.locator('input[name="patient"][value="configured-patient-1"]').check();
            await page.locator('button[name="decision"][value="approve"]').click();
            await expect(page.getByText('SMART code exchange completed', { exact: false })).toBeVisible();
            expect(new URL(page.url()).origin).toBe(new URL(base).origin);
            expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe(new URL(base).pathname.replace(/\/$/, ''));
            expect(await page.content()).not.toMatch(/PRIVATE KEY|access_token|code_verifier/);
            for (const decision of ['deny', 'cancel']) {
                await begin(base); if (decision === 'deny') await page.getByText('Protocol testing and technical details', { exact: true }).click(); await page.locator(`button[name="decision"][value="${decision}"]`).click();
                await expect(page.getByText(`SMART test ${decision === 'deny' ? 'denied' : 'cancelled'}.`, { exact: true })).toBeVisible();
                expect(new URL(page.url()).origin).toBe(new URL(base).origin);
            }
        }
        // A different active Host does not acquire a registration; offer only the configured exact canonical start.
        const canonical = new URL(originalDoctor); canonical.hostname = 'explicit-doctor-browser.test'; const canonicalBase = canonical.toString().replace(/\/$/, '');
        await configure(canonicalBase); await page.goto(originalDoctor); await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.locator('[data-help-key="doctor.smart-start"]').click();
        await expect(page.getByText('This Doctor address has no matching registered SMART callback.', { exact: false })).toBeVisible();
        const canonicalStart = page.getByRole('link', { name: 'Open configured Doctor address', exact: true });
        expect(new URL(await canonicalStart.getAttribute('href')).origin).toBe(canonical.origin);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        if (touch) await page.getByRole('button', { name: 'Explain Open configured Doctor address', exact: true }).tap(); else await canonicalStart.focus(); await expect(page.getByRole('tooltip')).toContainText('fresh request'); await page.keyboard.press('Escape');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck(); await canonicalStart.click();
        await expect(page.locator('form[action$="/authorize/decision"]')).toBeVisible();
        await page.locator('button[name="decision"][value="cancel"]').click();
        await expect(page.getByText('SMART test cancelled.', { exact: false })).toBeVisible();
        expect(await consentCount()).toBe(count);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await info.attach('address-roundtrips', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ executed: true, cases: hosts.length, approved: hosts.length, denied: hosts.length, cancelled: hosts.length + 1, consentDelta: 0, exactCallbacks: true, nonDefaultPorts: true, browserHttps: true })) });
    } finally {
        if (original) {
            // Independent cleanup remains available if a Playwright deadline has ended the page request context.
            const send = async (action, body) => { const r = await fetch(`${pcm}/admin/config/doctor-browser/${action}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); expect(r.ok).toBeTruthy(); return r.json(); };
            const plan = await send('preview', { doctorBase: original }); await send('apply', { doctorBase: original, reviewDigest: plan.reviewDigest });
        }
        await context?.close();
    }
});
