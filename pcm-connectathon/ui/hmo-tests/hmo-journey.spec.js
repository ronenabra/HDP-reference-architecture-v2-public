'use strict';
/** Owned ordinary-HMO acceptance: real source requests, native touch and actual contextual help. */
const { test, expect } = require('@playwright/test');
const pcm = process.env.PCM_UI_PCM_URL;
const headers = { Accept: 'application/json', 'x-admin-password': process.env.PCM_UI_ADMIN_PASSWORD };

test('ordinary PCM HMO sign-in, recovery, partial results and help @smoke', async ({ browser, page }, info) => {
    test.setTimeout(150000);
    const touch = info.project.name === 'chromium-mobile';
    const context = touch ? await browser.newContext({ hasTouch: true, isMobile: true, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } }) : null;
    if (context) page = await context.newPage();
    page.setDefaultTimeout(10000);
    let original, custom;
    const save = async teamConfig => {
        const response = await page.request.post(`${pcm}/admin/restore`, { headers, data: { teamConfig } });
        expect(response.status(), await response.text()).toBe(200);
    };
    const explain = async (locator, text) => {
        if (touch && await locator.getAttribute('data-help-proxy') !== null) await locator.locator('xpath=following-sibling::button[@data-help-for][1]').tap();
        else if (touch) await locator.tap(); else await locator.focus();
        await expect(page.getByRole('tooltip')).toContainText(text);
        await page.keyboard.press('Escape');
    };
    const start = async (date = '1980-01-02') => {
        await page.locator('#home-hmo').selectOption(original.healthOrganizations[0].dataSourceOrganization.id);
        await page.getByLabel('Patient identifier', { exact: true }).fill(' 000000018 ');
        await page.getByLabel('Full date of birth').fill(date);
        await page.getByRole('button', { name: 'Check HMO and show verification step', exact: true }).click();
    };
    const showCode = async () => {
        const details = page.locator('details').filter({ has: page.locator('form[action$="/local-code"]') });
        if (!await details.evaluate(node => node.open)) await details.locator('summary').click();
        await page.getByRole('button', { name: 'Show local code', exact: true }).click();
        return (await page.locator('[data-local-code]').innerText()).match(/\b\d{6}\b/)[0];
    };
    try {
        const backup = await page.request.get(`${pcm}/admin/backup`, { headers }); expect(backup.status()).toBe(200);
        original = (await backup.json()).teamConfig;
        const bounded = structuredClone(original);
        bounded.patients = []; bounded.systemAuthorization.memberships = []; bounded.systemAuthorization.participatingHmos = []; bounded.systemAuthorization.presenceEligiblePatients = [];
        bounded.systemAuthorization.discovery.eligibleRelationships = [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'PRN' }];
        bounded.systemAuthorization.otp.expirySeconds = 30; bounded.systemAuthorization.otp.resendSeconds = 5;
        await save(bounded);
        const hospitalOnly = structuredClone(bounded);
        for (const ho of hospitalOnly.healthOrganizations) ho.institutionType = 'hospital';
        for (const source of hospitalOnly.sources?.custom || []) source.institutionType = 'hospital';
        await save(hospitalOnly);
        await page.goto(pcm);
        await page.getByRole('link', { name: 'Test patient sign-in and dependents', exact: true }).click();
        const canonical = page.url(); expect(new URL(canonical).protocol).toBe('https:');
        await expect(page.getByText('No HMO is ready', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Check HMO and show verification step', exact: true })).toBeDisabled();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await explain(page.locator('[data-help-for="workflow.send"]').first(), 'Admin');
        await save(bounded); await page.reload();
        await expect(page.locator('#configured-patient')).toBeDisabled();
        await explain(page.locator('[data-help-for="workflow.picker"]').first(), 'manual');
        await explain(page.locator('#birthDate'), 'complete date');
        await explain(page.locator('#home-hmo'), 'Registration does not prove');
        await explain(page.locator('#system'), 'leading zeros');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await start('1980-01-03');
        await expect(page.locator('[data-workflow-feedback]')).toContainText('Could not verify');
        await expect(page.locator('#identifier')).toHaveValue('000000018');
        expect(page.url()).toBe(canonical);
        await page.reload(); await expect(page.getByRole('heading', { name: 'Verify code', exact: true })).toHaveCount(0);
        await start();
        await expect(page.getByRole('heading', { name: 'Verify code', exact: true })).toBeVisible();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await explain(page.locator('#code'), 'six-digit');
        const resend = page.getByRole('button', { name: 'Request a new code', exact: true });
        if (await resend.isDisabled()) await explain(page.locator('[data-help-for="workflow.resend"]').first(), 'code');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        const first = await showCode();
        await page.locator('#code').fill(first === '000000' ? '111111' : '000000');
        await page.getByRole('button', { name: 'Verify code', exact: true }).click();
        await expect(page.locator('[data-workflow-feedback]')).toContainText('not correct');
        await expect(resend).toBeEnabled({ timeout: 7000 }); await resend.click();
        const code = await showCode();
        await page.locator('#code').fill(code); await page.getByRole('button', { name: 'Verify code', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Verified test patient', exact: true })).toBeVisible();
        // A newly registered unavailable custom HMO stays an explicit unknown result.
        const add = await page.request.post(`${pcm}/admin/config/data-sources/add`, { headers, data: { name: 'Owned unavailable HMO', endpoint: 'https://127.0.0.1:9/fhir', institutionType: 'hmo', generateCertificate: true } });
        expect(add.status()).toBe(201); custom = (await add.json()).dataSource.id;
        await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Some HMOs could not be checked', exact: true })).toBeVisible();
        await expect(page.locator('[data-discovery-sources]')).toContainText('Owned unavailable HMO: Could not check');
        const child = page.locator('[data-dependent-card]').filter({ hasText: '000000026' });
        await expect(child).toHaveCount(1);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await explain(page.locator('[data-discovery-sources] > li').first(), 'last-check');
        await explain(child.getByRole('button', { name: 'Recheck relationship and select', exact: true }), 'Consent');
        await child.getByRole('button', { name: 'Recheck relationship and select', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Selected for this PCM test:' })).toContainText('000000026');
        await expect(page.getByText('It does not select a patient in Doctor', { exact: false })).toBeVisible();
        await page.getByRole('button', { name: 'Check my source presence', exact: true }).click();
        await expect(page.locator('[data-presence-results]')).toContainText('independent source-list eligibility is missing');
        await explain(page.locator('[data-presence-results] > li').first(), 'count-only');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        // Navigate each real cross-listener link, then return to the current bound flow.
        for (const [name, suffix] of [['Doctor', '/'], ['Consents', '/ui'], ['Logs', '/logs-view']]) {
            const link = page.getByRole('link', { name, exact: true }); const destination = await link.getAttribute('href');
            expect(new URL(destination).port).not.toBe(new URL(canonical).port);
            await link.click(); await expect(page.locator('h1').first()).toBeVisible();
            expect(new URL(page.url()).pathname).toBe(suffix); await page.goto(canonical);
        }
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
        await start(); await showCode();
        await expect(page.getByRole('button', { name: 'Verify code', exact: true })).toBeDisabled({ timeout: 35000 });
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await explain(page.locator('[data-help-for="workflow.verify"]').first(), 'expired');
        await page.screenshot({ path: `/artifacts/${info.project.name}-hmo-expiry-help.png`, fullPage: true });
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Choose patient', exact: true })).toBeVisible();
    } finally {
        const cleanup = async (route, body) => {
            const response = await fetch(`${pcm}${route}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
            expect(response.ok, `owned cleanup ${route}`).toBeTruthy();
        };
        if (custom) await cleanup('/admin/config/data-sources/remove', { id: custom });
        if (original) await cleanup('/admin/restore', { teamConfig: original });
        await context?.close();
    }
});

test('optional local SSO and HTEST remain separate from ordinary person login @smoke', async ({ page }) => {
    test.setTimeout(60000); page.setDefaultTimeout(10000);
    const backup = await page.request.get(`${pcm}/admin/backup`, { headers }); expect(backup.status()).toBe(200);
    const original = (await backup.json()).teamConfig;
    const fixture = structuredClone(original);
    fixture.systemAuthorization.memberships = [
        { identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }, homeHmoId: 'ho-a', localSso: { birthDate: '1980-01-02', display: 'Owned fabricated SSO', name: [{ text: 'Owned fabricated SSO patient' }] } },
        { identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }, homeHmoId: 'ho-a', sandboxFixture: true, fixtureBirthDate: '1990-01-01' }
    ];
    try {
        const save = await page.request.post(`${pcm}/admin/restore`, { headers, data: { teamConfig: fixture } });
        expect(save.status(), await save.text()).toBe(200);
        await page.goto(`${pcm}/sandbox/authentication`);
        await page.getByText('Local trusted SSO simulation', { exact: true }).click();
        await page.getByRole('button', { name: 'Sign in with local SSO simulation', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Verified test patient', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Verify code', exact: true })).toHaveCount(0);
        await page.getByText('Sign-in details', { exact: true }).click();
        await expect(page.getByText('Authentication method: local-trusted-sso-simulation')).toBeVisible();
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
        await page.getByText('HTEST lookup fixture simulation', { exact: true }).click();
        await page.getByRole('button', { name: 'Start HTEST fixture OTP', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Verify code', exact: true })).toBeVisible();
        await page.getByText('Show the local test code', { exact: true }).click();
        await page.getByRole('button', { name: 'Show local code', exact: true }).click();
        const code = (await page.locator('[data-local-code]').innerText()).match(/\b\d{6}\b/)[0];
        await page.locator('#code').fill(code); await page.getByRole('button', { name: 'Verify code', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Verified test patient', exact: true })).toBeVisible();
        await page.getByText('Sign-in details', { exact: true }).click();
        await expect(page.getByText('HTEST fixture simulation — no person login', { exact: false })).toBeVisible();
        await page.getByRole('button', { name: 'End this test sign-in', exact: true }).click();
    } finally {
        const restored = await fetch(`${pcm}/admin/restore`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ teamConfig: original }), signal: AbortSignal.timeout(20000) });
        expect(restored.ok, 'restore optional owned fixture configuration').toBeTruthy();
    }
});

test('PCM workflow navigation follows reachable hostname and IP listeners @smoke', async ({ page }) => {
    page.setDefaultTimeout(10000);
    const configured = new URL(pcm);
    const hosts = ['pcm-hmo-browser.test', '127.0.0.1', process.env.PCM_UI_DEPLOYMENT_IP].filter(Boolean);
    for (const host of hosts) {
        const entry = new URL(configured); entry.hostname = host;
        const dashboard = await page.goto(entry.toString()); expect(dashboard.status()).toBe(200);
        await page.getByRole('link', { name: 'Test patient sign-in and dependents', exact: true }).click();
        const workflow = page.url(); expect(new URL(workflow).hostname).toBe(host);
        expect(new URL(workflow).port).toBe(String(Number(configured.port) + 1));
        expect(new URL(workflow).protocol).toBe('https:');
        for (const name of ['Doctor', 'Consents', 'Logs']) {
            const link = page.getByRole('link', { name, exact: true });
            expect(new URL(await link.getAttribute('href')).hostname).toBe(host);
            const response = await Promise.all([page.waitForNavigation(), link.click()]);
            expect([200, 304]).toContain(response[0].status());
            await expect(page.locator('h1').first()).toBeVisible();
            if (name === 'Doctor') await expect(page.getByRole('link', { name: 'PCM authentication and dependents' })).toHaveCount(0);
            await page.goto(workflow);
        }
        await page.goto(new URL('/sandbox/authentication', entry).toString());
        expect(page.url()).toBe(workflow);
    }
});
