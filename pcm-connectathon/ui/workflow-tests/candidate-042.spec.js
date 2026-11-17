'use strict';
/** Focused candidate portal journeys. Backend credentials remain in the PCM runtime. */
const { test, expect } = require('@playwright/test');
const { workflowPostUrl, workflowCsrfSelector } = require('./browser-boundary');
const pcm = process.env.PCM_UI_PCM_URL;
test.skip(process.env.PCM_UI_CANDIDATE_042 !== 'true', 'Explicit candidate fixture selection is required');

/** Complete the separately labelled local OTP transport using its browser-bound diagnostic. */
async function otp(page) {
    await expect(page.getByRole('heading', { name: 'Verify code' })).toBeVisible();
    await page.getByText('Show the local test code', { exact: true }).click();
    await page.getByRole('button', { name: 'Show local code', exact: true }).click();
    const code = (await page.locator('[data-local-code]').innerText()).match(/\b\d{6}\b/)[0];
    await page.getByLabel('Six-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verified test patient' })).toBeVisible();
}

test('candidate 0.4.2 SSO is independent of OTP and rejects invented wire context', async ({ page }, testInfo) => {
    await page.goto(`${pcm}/sandbox/authentication`);
    await page.getByText('Local trusted SSO simulation', { exact: true }).click();
    const help = page.getByRole('checkbox', { name: 'Explain this page' });
    await help.check();
    await page.getByRole('button', { name: 'Sign in with local SSO simulation', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('fabricated provider facts');
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-sso-help.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await help.uncheck();
    await page.getByRole('button', { name: 'Sign in with local SSO simulation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Verified test patient' })).toBeVisible();
    await page.getByText('Sign-in details', { exact: true }).click();
    await expect(page.getByText('Authentication method: local-trusted-sso-simulation')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Verify code' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Dependent checks complete' })).toBeVisible();
    await expect(page.locator('[data-dependent-card]')).toHaveCount(2);
    expect(await page.content()).not.toMatch(/PRIVATE KEY|client_assertion|access_token|local_jwt/);
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-sso-discovery.png`, fullPage: true });
    await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
    const csrf = await page.locator(workflowCsrfSelector('start')).inputValue();
    const forged = await page.request.post(workflowPostUrl(page.url(), 'discover'), { form: { csrf, flowId: 'arbitrary', representative: '000000018', authenticated: 'true' } });
    expect(forged.status()).toBe(200);
    expect(await forged.text()).toContain('expired or was cleared');
});

test('candidate 0.4.2 Palestinian and eligible foreign passport OTP login use trusted server facts', async ({ page }) => {
    const status = await page.request.get(`${pcm}/admin/status`, { headers: { Accept: 'application/json', 'x-admin-password': process.env.PCM_UI_ADMIN_PASSWORD } });
    expect(status.status()).toBe(200);
    const source = (await status.json()).config.healthOrganizations.find(item => item.id === 'ho-c');
    expect(source?.dataSourceOrganization?.id).toBeTruthy();
    // Both maintained foreign-identity Patients and their trusted eligibility facts belong to HMO C.
    for (const [system, value] of [['http://fhir.health.gov.il/identifier/pna-national-id', '000123'], ['http://hl7.org/fhir/sid/passport-USA', 'FABRICATED042']]) {
        await page.goto(`${pcm}/sandbox/authentication`);
        await page.getByLabel('Identifier type', { exact: true }).selectOption(system);
        await expect(page.locator(`#home-hmo option[value="${source.dataSourceOrganization.id}"]`)).toHaveCount(1);
        await page.getByLabel('Home HMO for this test', { exact: true }).selectOption(source.dataSourceOrganization.id);
        await page.getByLabel('Patient identifier').fill(value);
        await page.getByLabel('Full date of birth').fill('1990-01-01');
        await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
        await otp(page);
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
    }
});

test('candidate 0.4.2 normative login rejects Israeli passport, missing facts and HTEST; fixture OTP is separate', async ({ page }) => {
    for (const [system, value] of [['http://hl7.org/fhir/sid/passport-ISR', 'FABRICATED'], ['http://hl7.org/fhir/sid/passport-GBR', 'NOFACTS'], ['http://fhir.health.gov.il/identifier/il-hdp-test-id', '1']]) {
        await page.goto(`${pcm}/sandbox/authentication`);
        const csrf = await page.locator(workflowCsrfSelector('start')).inputValue();
        const homeHmoId = await page.locator('#home-hmo option').nth(1).getAttribute('value');
        const rejected = await page.request.post(new URL('authentication/start', page.url()).toString(), { form: { csrf, homeHmoId, system, identifier: value, birthDate: '1990-01-01' } });
        expect(await rejected.text()).toContain('workflow-feedback');
    }
    for (const subject of ['1', '2']) {
        await page.goto(`${pcm}/sandbox/authentication`);
        await page.getByText('HTEST lookup fixture simulation', { exact: true }).click();
        await page.getByLabel('HTEST fixture', { exact: true }).selectOption(subject);
        await page.getByRole('button', { name: 'Start HTEST fixture OTP', exact: true }).click();
        await otp(page);
        await page.getByText('Sign-in details', { exact: true }).click();
        await expect(page.getByText('HTEST fixture simulation — no person login', { exact: false })).toBeVisible();
        await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Dependent checks complete' })).toBeVisible();
        await expect(page.locator('[data-dependent-card]')).toHaveCount(1);
        await expect(page.locator('[data-dependent-card]')).toContainText('Reference Health Organization A Data Source, Reference Health Organization B Data Source, Reference Health Organization C Data Source');
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('candidate 0.4.2 Israeli OTP presence and direct Doctor sampling preserve labels and authority', async ({ page }) => {
    await page.goto(`${pcm}/sandbox/authentication`);
    await page.getByLabel('Home HMO for this test', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Patient identifier').fill('000000018');
    await page.getByLabel('Full date of birth').fill('1980-01-02');
    await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
    await otp(page);
    await page.getByRole('button', { name: 'Check my source presence', exact: true }).click();
    await expect(page.locator('[data-presence-results]')).toContainText('000000018 · Reference Health Organization A Data Source: Records found');
    if (process.env.PCM_UI_PRESET !== 'strict') await expect(page.locator('[data-presence-results]')).toContainText('legacy Node compatibility');
    await page.getByRole('button', { name: 'Check source presence for me and verified dependents', exact: true }).click();
    await expect(page.locator('[data-presence-results]')).toContainText('000000026 · Reference Health Organization B Data Source: Records found');
    await expect(page.getByText('Selection stays in this PCM test.', { exact: false })).toBeVisible();
    await page.goto(`${process.env.PCM_UI_SP_URL}/patients`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Doctor Patient library');
    await page.locator('[data-library-view="sample"]').click();
    await expect(page.getByText('Load up to ten synthetic patients from the selected source. All sampled patients require Consent review.', { exact: false })).toBeVisible();
    const load = page.getByRole('button', { name: 'Load sample', exact: true });
    if (process.env.PCM_UI_PRESET === 'strict') {
        await expect(load).toBeDisabled();
        await expect(page.locator('#sample-state')).toContainText('Unsupported: sampling is disabled in Strict');
    } else {
        const sampled = page.waitForResponse(response => response.url().endsWith('/patients/load') && response.request().method() === 'POST');
        await load.click();
        const response = await sampled; expect(response.status()).toBe(200);
        const payload = await response.json();
        expect(payload.requests).toBe(1); expect(payload.patients.length).toBeGreaterThan(0); expect(payload.patients.length).toBeLessThanOrEqual(10);
        await expect(page.locator('#sample-state')).toContainText('refreshed', { timeout: 20000 });
        await expect(page.locator('#sample-results')).toContainText('Candidate synthetic sampler');
    }
    expect(await page.content()).not.toMatch(/PRIVATE KEY|client_assertion|access_token|local_jwt/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
