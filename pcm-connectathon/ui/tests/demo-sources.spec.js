'use strict';
/** Actual direct sandbox source changes, conflicts and zero selection on desktop/mobile; strict remains read-only. */
const { test, expect } = require('@playwright/test');
const { createConsent } = require('./helpers/consent-creation');
const sp = process.env.PCM_UI_SP_URL, pcm = process.env.PCM_UI_PCM_URL;
/** Open R5's existing source-settings disclosure before deliberately editing its form. */
async function openSourceSettings(page) {
    const settings = page.locator('[data-source-settings]');
    if (await settings.getAttribute('open') === null) await settings.locator(':scope > summary').click();
}
/** Wait for the successful command's actual reload before inspecting its persisted selection. */
async function apply(page, form) {
    await Promise.all([page.waitForEvent('domcontentloaded'), form.locator('[data-source-apply]').click()]);
    await openSourceSettings(page);
}
const NOTICE = 'Test a source-list change';
test('DEMO sources separates approval, applies changed selections, detects stale tabs and reloads zero sources', async ({ page, context }, info) => {
    test.setTimeout(120000); test.skip(!info.project.name.startsWith('chromium-'), 'Desktop/mobile Chromium');
    await page.request.post(`${sp}/reset`);
    if (process.env.PCM_UI_ADMIN_PASSWORD) await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
    await page.goto(sp);
    const service = await page.locator('#service-id option').filter({ hasText: 'Laboratory follow-up' }).getAttribute('value');
    await page.locator('#service-id').selectOption(service);
    await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click(); await page.locator('#patient-id').fill('http://fhir.health.gov.il/identifier/il-national-id|000000018');
    const id = await createConsent(page, { origin: sp, expect });
    await page.goto(`${pcm}/ui/approve/${id}`);
    await expect(page.getByRole('button', { name: 'Approve request', exact: true })).toBeVisible();
    await expect(page.locator('[data-source-change]')).toHaveCount(0);
    for (const box of await page.locator('input[name="sources"]').all()) await box.uncheck();
    await page.locator('input[name="sources"]').first().check();
    await page.getByRole('button', { name: 'Approve request', exact: true }).click();
    await page.goto(`${pcm}/ui/approve/${id}`);
    await expect(page.getByRole('button', { name: 'Approve request', exact: true })).toHaveCount(0);
    const form = page.locator('[data-source-change]');
    if (!(await form.count())) {
        const forged = await page.request.post(`${pcm}/admin/consents/${id}/sandbox-sources`, { data: { action: 'apply', sourceIds: [], expectedVersion: '1', csrf: 'forged' } });
        expect(forged.status()).toBe(403);
    } else {
        await page.goto(sp);
        const doctor = page.locator('.card').filter({ has: page.locator(`input[name="consentId"][value="${id}"]`) });
        await doctor.locator('button[formaction="/discover"]').click();
        await expect(doctor.locator('[data-source-choice] option:not([value=""])')).toHaveCount(1);
        await doctor.locator('button[formaction="/fetch-data"]').click();
        await expect(doctor.getByRole('region', { name: 'Fetched FHIR data' })).toBeVisible();
        await page.goto(`${pcm}/ui/approve/${id}`);
        await openSourceSettings(page);
        await expect(page.getByText(NOTICE, { exact: true })).toBeVisible();
        const boxes = form.locator('input[name="sourceIds"]');
        await expect(boxes.first()).toBeChecked(); await expect(boxes.nth(1)).not.toBeChecked();
        await boxes.nth(1).check();
        await expect(form.locator('[data-source-apply]')).toBeEnabled();
        await form.getByRole('button', { name: 'Discard unsaved changes', exact: true }).click(); await expect(boxes.nth(1)).not.toBeChecked();
        await expect(form.locator('[data-source-apply]')).toBeDisabled();
        const stale = await context.newPage(); await stale.goto(`${pcm}/ui/approve/${id}`); await openSourceSettings(stale);
        await boxes.nth(1).check();
        await apply(page, form); await expect(page.locator('[data-source-audit]')).toContainText('Sandbox source list changed on');
        const old = stale.locator('[data-source-change]'); await old.locator('input[name="sourceIds"]').first().uncheck();
        await old.locator('[data-source-apply]').click(); await expect(old.locator('[data-source-result]')).toContainText('another tab'); await stale.close();
        await form.locator('input[name="sourceIds"]').first().uncheck(); await apply(page, form);
        await expect(form.locator('input[name="sourceIds"]:checked')).toHaveCount(1);
        await form.locator('input[name="sourceIds"]:checked').uncheck();
        await apply(page, form);
        await expect(form.locator('input[name="sourceIds"]:checked')).toHaveCount(0); await page.reload(); await expect(form.locator('input[name="sourceIds"]:checked')).toHaveCount(0);
        const passiveSelections = [];
        const recordSelection = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/selection') passiveSelections.push(request.url()); };
        page.on('request', recordSelection);
        await page.goto(sp);
        await expect(doctor.locator('[data-source-choice] option:not([value=""])')).toHaveCount(0);
        await expect(doctor.getByRole('region', { name: 'Fetched FHIR data' })).toHaveCount(0);
        await expect(doctor.locator('input[name="endpointUrl"]')).toHaveValue('');
        await page.waitForLoadState('networkidle'); page.off('request', recordSelection);
        expect(passiveSelections, 'Fresh public source context must not restore a stale target through a passive selection write').toEqual([]);
    }
    // Automatic test provenance remains visible on a distinct existing active Consent.
    await page.goto(sp); await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click(); await page.locator('#patient-id').fill('http://fhir.health.gov.il/identifier/il-hdp-test-id|1');
    const automaticId = await createConsent(page, { origin: sp, expect });
    await page.goto(`${pcm}/ui/approve/${automaticId}`); await expect(page.getByText(/Originally approved automatically for testing/)).toBeVisible();
    const automaticForm = page.locator('[data-source-change]');
    if (await automaticForm.count()) {
        await openSourceSettings(page);
        for (const box of await automaticForm.locator('input[name="sourceIds"]').all()) if (await box.isChecked()) await box.uncheck();
        await apply(page, automaticForm);
        await expect(automaticForm.locator('input[name="sourceIds"]:checked')).toHaveCount(0);
        await expect(page.getByText(/Originally approved automatically for testing/)).toBeVisible();
    }
});
