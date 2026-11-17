'use strict';
/** Desktop/mobile library selection and application-owned GUID sampling acceptance. */
const { test, expect } = require('@playwright/test');
const sp = process.env.PCM_UI_SP_URL;
test('DEMO patients offers offline fixed choices and a bounded GUID library with strict rejection', async ({ page }, info) => {
    test.setTimeout(90000); test.skip(!info.project.name.startsWith('chromium-'), 'Desktop/mobile Chromium');
    // Desktop and mobile share this owned Doctor runtime; begin with its documented reset.
    await page.request.post(`${sp}/reset`);
    await page.goto(`${sp}/patients`);
    const fixed = value => page.locator('[data-library-group="demo"] [data-patient-row]').filter({ has: page.locator(`input[name="patientId"][value="http://fhir.health.gov.il/identifier/il-hdp-test-id|${value}"]`) });
    await expect(fixed('1')).toContainText('Israel Israelov');
    await expect(fixed('2')).toContainText('Israela Israelov');
    await expect(page.getByText(/without a patient decision/)).toBeVisible();
    await fixed('1').getByRole('button', { name: 'Use patient', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#patient-id')).toHaveValue('1');
    await expect(page.locator('#configured-patient option')).toHaveCount(4);
    // A picker choice takes the same invalidation path as editing the identifier.
    await page.evaluate(() => {
        const stale = document.createElement('section');
        stale.setAttribute('aria-label', 'Fetched FHIR data'); document.body.append(stale);
    });
    const selection = page.waitForResponse(response => response.url().endsWith('/selection'));
    await page.locator('#configured-patient').selectOption('http://fhir.health.gov.il/identifier/il-hdp-test-id|2');
    expect((await selection).ok()).toBe(true);
    await expect(page.locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    await expect(page.locator('#patient-id')).toHaveValue('2');
    await page.getByRole('link', { name: 'Patient library', exact: true }).click();
    await page.locator('[data-library-view="sample"]').click();
    const load = page.locator('#sample-load');
    if (await load.isDisabled()) {
        await expect(page.locator('#sample-state')).toContainText('disabled');
        const forged = await page.request.post(`${sp}/patients/load`, { data: { identity: 'hospital-a', sourceId: 'ho-a' } }); expect(forged.status()).toBe(400);
    } else {
        const response = page.waitForResponse(response => response.url().endsWith('/patients/load') && response.request().method() === 'POST');
        await load.click(); const payload = await (await response).json(); expect(payload.requests).toBe(1); expect(payload.patients.length).toBe(10);
        await expect(page.locator('#sample-state')).toContainText('refreshed');
        await page.locator('#sample-results button').first().click();
        await expect(page.locator('#patient-id')).toHaveValue(payload.patients[0].idValue);
        await expect(page.locator('#configured-patient option')).toHaveCount(14);
        await page.getByRole('link', { name: 'Patient library', exact: true }).click();
        await page.locator('[data-library-view="sample"]').click();
        await page.locator('#sample-source').selectOption('ho-b'); await expect(page.locator('#sample-results button')).toHaveCount(0);
        await load.click(); await expect(page.locator('#sample-state')).toContainText('Empty');
    }
    await page.getByRole('link', { name: 'Back to request', exact: true }).click();
    await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click();
    await page.locator('#patient-id').fill('http://fhir.health.gov.il/identifier/il-national-id|000000018');
    await expect(page.locator('#patient-id')).toHaveValue('000000018');
});
