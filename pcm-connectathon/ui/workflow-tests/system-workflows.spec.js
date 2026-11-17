'use strict';

/** Browser-to-HAPI authentication and discovery using the explicit fabricated workflow dataset. */
const { test, expect } = require('@playwright/test');
const { workflowPostUrl, workflowCsrfSelector } = require('./browser-boundary');
const pcm = process.env.PCM_UI_PCM_URL;
const sp = process.env.PCM_UI_SP_URL;
const fs = require('node:fs');
const adminHeaders = { Accept: 'application/json', 'x-admin-password': process.env.PCM_UI_ADMIN_PASSWORD || '' };

/** Replace only the disposable team's fabricated source data, using the maintained Admin import. */
async function relationships(page, active) {
    for (const ho of ['ho-a', 'ho-b']) {
        const bundle = JSON.parse(fs.readFileSync(`/workflow-fixtures/${ho}.transaction.json`, 'utf8'));
        const child = bundle.entry.find(entry => entry.resource.resourceType === 'Patient' && entry.resource.identifier?.some(id => id.value === '000000026'));
        for (const entry of bundle.entry) if (entry.resource.resourceType === 'RelatedPerson' && [child.fullUrl, `Patient/${child.resource.id}`].includes(entry.resource.patient?.reference)) entry.resource.active = active;
        const response = await page.request.post(`${pcm}/admin/api/fhir-servers/${ho}/imports`, { headers: adminHeaders, multipart: {
            replace: 'true', bundle: { name: `${ho}.source.transaction.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) }
        } });
        expect(response.status()).toBe(202);
        const operation = await response.json();
        await expect.poll(async () => {
            const state = await page.request.get(`${pcm}/admin/api/data-operations/${operation.id}`, { headers: adminHeaders });
            return (await state.json()).phase;
        }, { timeout: 120000, intervals: [250, 500, 1000] }).toBe('succeeded');
    }
}


if (process.env.PCM_UI_WORKFLOW_PARTIAL !== 'true') test('PCM 0.4.0 home-HMO OTP and dependent discovery complete through real gateways', async ({ page }, testInfo) => {
    test.setTimeout(360000);
    await page.goto(pcm);
    await page.getByRole('link', { name: 'Test patient sign-in and dependents', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Test patient sign-in and dependents');
    await expect(page.getByText('Test environment. Codes are shown here; no SMS or email is sent.', { exact: true })).toBeVisible();
    const help = page.getByRole('checkbox', { name: 'Explain this page' });
    await help.check();
    await page.getByLabel('Full date of birth').focus();
    await expect(page.getByRole('tooltip')).toContainText('complete date');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
    await help.uncheck();
    // A bad date produces no successful authentication and preserves the restart form.
    await page.getByLabel('Home HMO for this test', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Patient identifier').fill('000000018');
    await page.getByLabel('Full date of birth').fill('1980-01-03');
    await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verified test patient' })).toHaveCount(0);
    await page.getByLabel('Home HMO for this test', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Patient identifier').fill('000000018');
    await page.getByLabel('Full date of birth').fill('1980-01-02');
    await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verify code' })).toBeVisible();
    await page.getByText('Show the local test code', { exact: true }).click();
    await page.getByRole('button', { name: 'Show local code', exact: true }).click();
    const code = (await page.locator('[data-local-code]').innerText()).match(/\b\d{6}\b/)?.[0];
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';
    await page.getByLabel('Six-digit code').fill(wrong);
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByLabel('Six-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verified test patient' })).toBeVisible();
    await page.getByRole('button', { name: 'Check my source presence', exact: true }).click();
    await expect(page.locator('[data-presence-results]')).toContainText('000000018 · Reference Health Organization A Data Source: Records found');
    await expect(page.locator('[data-presence-results]')).toContainText('000000018 · Reference Health Organization B Data Source: No matching record found');
    await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dependent checks complete' })).toBeVisible();
    const cards = page.locator('[data-dependent-card]');
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: '000000026' })).toContainText('Reference Health Organization A Data Source, Reference Health Organization B Data Source');
    await expect(cards.filter({ hasText: '000000034' })).toContainText('Reference Health Organization A Data Source, Reference Health Organization C Data Source');
    await expect(page.getByText('000000042', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Check source presence for me and verified dependents', exact: true }).click();
    await expect(page.locator('[data-presence-results]')).toContainText('000000026 · Reference Health Organization B Data Source: Records found');
    await expect(page.locator('[data-presence-results]')).toContainText('000000034 · Reference Health Organization C Data Source: Records found');
    await cards.filter({ hasText: '000000026' }).getByRole('button', { name: 'Recheck relationship and select', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Selected for this PCM test:' })).toContainText('Selected for this PCM test:');
    await expect(page.getByRole('status').filter({ hasText: 'Selected for this PCM test:' })).toContainText('000000026');
    // Invalidate actual source evidence after selection; refresh must clear the stored selection.
    try {
        await relationships(page, false);
        await page.getByRole('button', { name: 'Check source presence for me and verified dependents', exact: true }).click();
        await expect(page.getByText('Selected for this PCM test:', { exact: false })).toHaveCount(0);
        await expect(cards.filter({ hasText: '000000026' })).toHaveCount(0);
    } finally { await relationships(page, true); }
    await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
    await cards.filter({ hasText: '000000026' }).getByRole('button', { name: 'Recheck relationship and select', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Selected for this PCM test:' })).toContainText('000000026');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check HMO and show verification step', exact: true })).toBeVisible();
    await expect(page.locator('[data-dependent-card]')).toHaveCount(0);
    // A standalone discovery action has no private authentication evidence.
    const csrf = await page.locator(workflowCsrfSelector('start')).inputValue();
    const denied = await page.request.post(workflowPostUrl(page.url(), 'discover'), { form: { csrf } });
    expect(denied.status()).toBe(200);
    expect(await denied.text()).toContain('expired or was cleared');
    await testInfo.attach('system-workflow-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        status: 'pass', executed: true, scenarios: ['home-hmo-authentication', 'online-presence', 'batch-presence', 'bad-dob', 'wrong-otp', 'verified-otp', 'three-hmo-discovery', 'same-record-negative', 'deduplication', 'selection-revalidation', 'relationship-change-refresh', 'explicit-reselection', 'clear', 'standalone-denied'],
        conformanceException: 'PCM-SANDBOX-FULL-DIAGNOSTICS'
    })) });
});


// The host runner stops only its disposable ho-b gateway after the successful
// journey has persisted source knowledge. No browser response mocking is used.
if (process.env.PCM_UI_WORKFLOW_PARTIAL === 'true') test('PCM 0.4.0 failed source preserves known presence and partial discovery', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    await page.goto(`${pcm}/sandbox/authentication`);
    await page.getByLabel('Home HMO for this test', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Patient identifier').fill('000000018');
    await page.getByLabel('Full date of birth').fill('1980-01-02');
    await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
    await page.getByText('Show the local test code', { exact: true }).click();
    await page.getByRole('button', { name: 'Show local code', exact: true }).click();
    const code = (await page.locator('[data-local-code]').innerText()).match(/\b\d{6}\b/)?.[0];
    expect(code).toMatch(/^\d{6}$/);
    await page.getByLabel('Six-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await page.getByRole('button', { name: 'Check my source presence', exact: true }).click();
    await expect(page.locator('[data-presence-results]')).toContainText('000000018 · Reference Health Organization A Data Source: Records found');
    await expect(page.locator('[data-presence-results]')).toContainText('000000018 · Reference Health Organization B Data Source: Could not check · Previously known: absent');
    await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Some HMOs could not be checked' })).toBeVisible();
    const unavailableDiscovery = page.locator('[data-discovery-sources] li').filter({ hasText: 'Reference Health Organization B Data Source: Could not check' });
    await expect(unavailableDiscovery).toHaveCount(1);
    await expect(unavailableDiscovery).toBeVisible();
    await expect(page.locator('[data-dependent-card]')).toHaveCount(2);
    await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
    await testInfo.attach('partial-workflow-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        status: 'pass', executed: true, source: 'ho-b', presence: 'unknown', previouslyKnown: 'absent', discovery: 'partial'
    })) });
});


if (process.env.PCM_UI_WORKFLOW_PARTIAL !== 'true') test('PCM local OTP diagnostics deny expired and cancelled deliveries', async ({ page }) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(10000);
    const backup = await page.request.get(`${pcm}/admin/backup`, { headers: adminHeaders });
    expect(backup.status()).toBe(200);
    const original = await backup.json();
    const bounded = structuredClone(original);
    bounded.teamConfig.systemAuthorization.otp.expirySeconds = 30;
    bounded.teamConfig.systemAuthorization.otp.resendSeconds = 5;
    const restore = async candidate => {
        const review = await page.request.get(`${pcm}/admin/backup`, { headers: adminHeaders });
        expect(review.status()).toBe(200);
        const current = await review.json();
        const response = await page.request.post(`${pcm}/admin/restore`, { headers: adminHeaders,
            data: { backupJson: JSON.stringify(candidate), expectedRevision: String(current.teamConfig.runtime.revision || 0) }, timeout: 15000 });
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'restored', applied: 'pcm-runtime-reset', listenerAdoption: 'not-checked' });
    };
    try {
        await restore(bounded);
        await page.goto(`${pcm}/sandbox/authentication`);
        await page.getByLabel('Home HMO for this test', { exact: true }).selectOption({ index: 1 });
        await page.getByLabel('Patient identifier').fill('000000018');
        await page.getByLabel('Full date of birth').fill('1980-01-02');
        await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
        await page.getByText('Show the local test code', { exact: true }).click();
        await page.getByRole('button', { name: 'Show local code', exact: true }).click();
        const code = (await page.locator('[data-local-code]').innerText()).match(/\b\d{6}\b/)?.[0];
        expect(code).toMatch(/^\d{6}$/);
        const csrf = await page.locator(workflowCsrfSelector('verify')).inputValue();
        await expect.poll(async () => {
            const response = await page.request.post(workflowPostUrl(page.url(), 'local-code'), { form: { csrf } });
            return (await response.text()).includes('No current code is available');
        }, { timeout: 35000, intervals: [1000] }).toBe(true);
        const expired = await page.request.post(workflowPostUrl(page.url(), 'verify'), { form: { csrf, code } });
        expect(await expired.text()).toContain('This code expired');
        // Expiry invalidates this delivery while leaving the restartable flow open. Clear it explicitly.
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Check HMO and show verification step', exact: true })).toBeVisible();
        // Cancellation has its own live delivery; an already expired flow cannot prove cancellation.
        await page.getByLabel('Home HMO for this test', { exact: true }).selectOption({ index: 1 });
        await page.getByLabel('Patient identifier').fill('000000018');
        await page.getByLabel('Full date of birth').fill('1980-01-02');
        await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Verify code' })).toBeVisible();
        const cancelCsrf = await page.locator(workflowCsrfSelector('verify')).inputValue();
        expect((await page.request.post(workflowPostUrl(page.url(), 'local-code'), { form: { csrf: cancelCsrf } })).status()).toBe(200);
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
        expect(await (await page.request.post(workflowPostUrl(page.url(), 'local-code'), { form: { csrf: cancelCsrf } })).text()).toContain('expired or was cleared');
    } finally { await restore(original); }
});
