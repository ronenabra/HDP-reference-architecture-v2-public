'use strict';
/** Doctor-only application acceptance authorized by the owner on 2026-10-06. */
const { test, expect } = require('@playwright/test');
const { verifyOwnedPicker } = require('./helpers/service-picker');
const { createConsent } = require('./helpers/consent-creation');
const { readFetchedPreview } = require('./helpers/fetched-preview');
const sp = process.env.PCM_UI_SP_URL;
const pcm = process.env.PCM_UI_PCM_URL;

/** Inspect actual DOM options, preserving prompt, ownership, readiness and opaque stamp separately. */
async function ownedPicker(page, config, identity) {
    const options = await page.locator('#service-id option').evaluateAll(nodes => nodes.map(node => ({
        value: node.value, text: node.textContent.trim(), disabled: node.disabled, stamp: node.getAttribute('data-service-stamp')
    })));
    return verifyOwnedPicker(options, config, identity);
}

test('DEMO catalog selects owned services and completes a bounded Doctor fetch', async ({ page }, info) => {
    test.skip(!info.project.name.startsWith('chromium-'), 'Doctor qualification uses desktop/mobile Chromium');
    if (process.env.PCM_UI_ADMIN_PASSWORD) await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
    const status = await page.request.get(`${pcm}/admin/status`);
    expect(status.ok()).toBeTruthy();
    const config = (await status.json()).config;
    await page.goto(sp);
    const firstProvider = await ownedPicker(page, config, 'hospital-a');
    const special = page.locator('#service-id option').filter({ hasText: 'Sandbox:' });
    if (await special.isDisabled()) await expect(special).toBeDisabled(); else await expect(special).toBeEnabled();
    await page.locator('#service-id').selectOption(firstProvider.laboratoryId);
    await expect(page.locator('#service-id')).toHaveValue(firstProvider.laboratoryId);
    await expect(page.locator('[name="serviceStamp"]')).toHaveValue(firstProvider.laboratoryStamp);
    await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click(); await page.locator('#patient-id').fill('http://fhir.health.gov.il/identifier/il-hdp-test-id|1');
    const createdId = await createConsent(page, { origin: sp, expect });
    const card = page.locator('.card').filter({ has: page.locator(`input[name="consentId"][value="${createdId}"]`) });
    await expect(card).toHaveCount(1);
    await expect(card.getByText(/Test auto-approved/)).toBeVisible();
    await card.locator('button[formaction="/discover"]').click();
    await expect(card.getByText('Data source', { exact: true })).toBeVisible();
    await card.locator('button[formaction="/fetch-data"]').click();
    await expect(card.getByRole('region', { name: 'Fetched FHIR data', exact: true })).toContainText('First-page preview');
    const result = await readFetchedPreview(card);
    expect(result.entry.some(entry => entry.resource?.resourceType === 'Patient')).toBe(true);
    await page.locator('#doctor-identity').selectOption('hospital-b');
    await page.waitForURL(url => url.searchParams.get('identity') === 'hospital-b');
    const secondProvider = await ownedPicker(page, config, 'hospital-b');
    expect(secondProvider.ids.every(id => !firstProvider.ids.includes(id))).toBeTruthy();
    await page.locator('#service-id').selectOption(secondProvider.laboratoryId);
    await expect(page.locator('#service-id')).toHaveValue(secondProvider.laboratoryId);
    await expect(page.locator('[name="serviceStamp"]')).toHaveValue(secondProvider.laboratoryStamp);
    await expect(page.locator(`input[name="consentId"][value="${createdId}"]`)).toHaveCount(0);
});
