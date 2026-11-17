'use strict';
/** Runtime demo grant access is explicit in every preset; aggregate runtime execution remains the final batch gate. */
const { test, expect } = require('@playwright/test');
const { readFetchedPreview } = require('./helpers/fetched-preview');
const { selectDemoApproval, DEFAULT_SCOPE, MANUAL_SCOPE } = require('./helpers/demo-access-approval');
const pcm = process.env.PCM_UI_PCM_URL, sp = process.env.PCM_UI_SP_URL;
test('DEMO access exposes invariant clinical permission and an explicit broad service in every preset', async ({ page }, info) => {
    test.setTimeout(120000);
    test.skip(!info.project.name.startsWith('chromium-'), 'Desktop/mobile Chromium qualification');
    if (process.env.PCM_UI_ADMIN_PASSWORD) await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
    await page.goto(`${pcm}/admin?section=security`);
    await expect(page.locator('[name="grantFullClinicalAccess"]')).toHaveCount(0);
    await expect(page.locator('[name="control.oauthBearer"]')).toHaveCount(0);
    await expect(page.getByText('Every preset enforces the exact approved scope, Patient/source context and current authority.', { exact: false })).toBeVisible();
    await page.goto(sp);
    const special = page.locator('#service-id option').filter({ hasText: 'Sandbox:' }); await expect(special).toBeEnabled();
    await page.locator('#service-id').selectOption(await special.getAttribute('value'));
    await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click(); await page.locator('#patient-id').fill('http://fhir.health.gov.il/identifier/il-national-id|000000018');
    const create = () => require('./helpers/consent-creation').createConsent(page, { origin: sp, expect });
    const approve = async (id, manual) => {
        const approval = await page.context().newPage();
        await approval.goto(`${pcm}/ui/approve/${id}`);
        const exact = await selectDemoApproval(approval, expect, manual);
        await Promise.all([approval.waitForURL(`${pcm}/ui`), approval.getByRole('button', { name: 'Approve request' }).click()]);
        await approval.close(); return exact;
    };
    const defaultId = await create();
    expect(await approve(defaultId, false)).toBe(DEFAULT_SCOPE);
    await page.reload();
    const ordinary = page.locator('.card').filter({ has: page.locator(`input[name="consentId"][value="${defaultId}"]`) });
    await ordinary.getByText('Approval details', { exact: true }).click();
    await expect(ordinary.locator('[data-token-details]')).toContainText('Granted permissions not yet obtained');
    // A new ordinary request owns the deliberate broader decision; never rewrite the saved default.
    const id = await create(); expect(id).not.toBe(defaultId);
    const exact = await approve(id, true); expect(exact).toBe(MANUAL_SCOPE);
    expect(exact).toContain('patient/Condition.rs?'); expect(exact).toContain('|V');
    await page.reload();
    const card = page.locator('.card').filter({ has: page.locator(`input[name="consentId"][value="${id}"]`) });
    await card.getByText('Approval details', { exact: true }).click();
    const previous = await page.request.get(`${pcm}/ui/approve/${defaultId}`);
    expect(previous.ok()).toBeTruthy(); expect(await previous.text()).toContain(DEFAULT_SCOPE);
    // Public service facts select finite app intent; broader approval alone never adds a query.
    await card.getByText('Request overrides', { exact: true }).click();
    await card.locator('[name="requestedScope"]').fill('patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs patient/Condition.rs');
    await card.locator('button[formaction="/discover"]').click(); await card.locator('button[formaction="/fetch-data"]').click();
    await expect(card.getByRole('region', { name: 'Fetched FHIR data', exact: true })).toContainText('First-page preview');
    await card.getByText('Approval details', { exact: true }).click();
    await card.getByText('Exact scope and authorization_details', { exact: true }).click();
    await expect(card.locator('[data-effective-scope]')).toHaveText(exact);
    const result = await readFetchedPreview(card); expect(result.entry.some(entry => entry.resource?.resourceType === 'Condition')).toBe(true);
    expect(result.entry.every(entry => !(entry.resource?.meta?.security || []).some(label => label.system === 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality' && label.code === 'V'))).toBe(true);
});
