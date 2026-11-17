'use strict';
/** Native form submission must survive both settled and in-flight selection saves. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const assets = process.env.PCM_UI_ASSET_ROOT || '/ui-assets';
for (const settled of [true, false]) test(`Doctor native submit after ${settled ? 'settled' : 'pending'} selection save @smoke`, async ({ page }) => {
    let release, selected = false, submitted = false;
    const waiting = new Promise(resolve => { release = resolve; });
    await page.route('https://selection.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/assets/doctor-selection.js') return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(assets, 'doctor-selection.js')) });
        if (url.pathname === '/selection') { selected = true; await waiting; return route.fulfill({ json: { status: 'cleared' } }); }
        if (url.pathname === '/create-consent') { submitted = true; return route.fulfill({ contentType: 'text/html', body: '<h1>Request received</h1>' }); }
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><form action="/create-consent" method="POST"><input name="identity" value="hospital-a"><select name="serviceId"><option value="lab" selected>Lab</option></select><select id="configured-patient"><option value="">Choose</option></select><select name="patientSystem"><option value="urn:test">Test</option></select><p id="patient-name"></p><p id="patient-feedback"></p><div data-patient-choices></div><div data-patient-manual></div><input name="patientId" value="1"><button>Create consent request</button></form><section aria-label="Fetched FHIR data">old preview</section><script src="/assets/doctor-selection.js" defer></script>' });
    });
    await page.goto('https://selection.test/');
    await page.locator('[name="patientId"]').fill('000000018');
    await expect(page.locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    await expect.poll(() => selected).toBe(true);
    if (settled) { const saved = page.waitForResponse(response => response.url().endsWith('/selection')); release(); await saved; }
    await page.getByRole('button', { name: 'Create consent request' }).click();
    if (!settled) { expect(submitted).toBe(false); release(); }
    await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
    expect(submitted).toBe(true);
});
