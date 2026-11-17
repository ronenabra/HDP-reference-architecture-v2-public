'use strict';
/** Current approval choices use actual PCM routes and lossless saved decisions in a disposable process. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/approval-scope-fixture')).startApprovalFixture(); });
test.afterAll(async () => { await fixture?.close(); });

/** Author a new owned fixture definition before creating a pending decision; retained approvals stay unchanged. */
function masterDefinition(enabled) {
    const service = fixture.store.get('HealthcareService', 'approval-lab-follow-up');
    const id = require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle')).basedOnId(service);
    const canonical = fixture.store.get('HealthcareService', id);
    const input = { ...fixture.store.privateRecords.services.getDefinition(canonical.id).grant.authoring, includeMasterData: enabled, scopeOrigin: 'generated' };
    delete input.approvalScope;
    require(path.join(root, 'test-support/private-definition')).replaceDefinition(fixture.store, canonical, input);
    return service;
}

test('approval defaults to exact saved service text and offers separate complete generated alternatives @smoke', async ({ page }) => {
    const consent = fixture.create('medication-reconciliation'), service = fixture.store.get('HealthcareService', 'approval-medication-reconciliation');
    await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
    const review = JSON.parse(await page.locator('[name="approvalReview"]').inputValue());
    const options = require(path.join(root, 'src/pcm-core/src/approval-scopes')).approvalScopeOptions(fixture.store, service, { now: Date.parse(review.anchor) / 1000 });
    await expect(page.locator('#scope-service-provided')).toBeChecked();
    for (const option of options) await expect(page.locator('#scope-' + option.id)).toHaveAttribute('data-scope-value', option.value);
    await page.locator('[data-alternative-permissions] > summary').click();
    await expect(page.getByRole('radio', { name: /Medication records only/ })).toHaveCount(0);
    await page.locator('#scope-auto-resources').check();
    await Promise.all([page.waitForURL(`${fixture.base}/ui`), page.getByRole('button', { name: 'Approve request' }).click()]);
    await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
    await expect(page.locator('[data-approved-scope]')).toHaveText(options[1].value);
    await expect(page.locator('[data-scope-origin]')).toContainText("Generated from the service's data types");
});

for (const [label, scope, warned] of [
    ['valid', 'patient/Observation.rs', false], ['suspect', '  patient/Unknown.rs?_filter=x  ', true], ['empty', '', true],
    ['preset-equal', 'patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs', false], ['escaped', '<script>window.scopeInjected=true</script>', true]
]) test(`custom ${label} scope submits and reloads exactly with advisory warnings @smoke`, async ({ page }) => {
    const consent = fixture.create(), url = `${fixture.base}/ui/approve/${consent.id}`;
    await page.goto(url); await page.locator('[data-alternative-permissions] > summary').click(); await page.locator('#scope-custom').check(); await page.getByLabel('OAuth scope text').fill(scope);
    if (warned) await expect(page.locator('[data-scope-warnings]')).toContainText('Advisory warnings:');
    else await expect(page.locator('[data-scope-warnings]')).toBeEmpty();
    await Promise.all([page.waitForURL(`${fixture.base}/ui`), page.getByRole('button', { name: 'Approve request' }).click()]);
    await page.goto(url); expect(await page.locator('[data-approved-scope]').textContent()).toBe(scope);
    await expect(page.locator('[data-scope-origin]')).toContainText('Manual override — advanced');
    expect(await page.evaluate(() => window.scopeInjected)).toBeUndefined();
    await page.reload(); expect(await page.locator('[data-approved-scope]').textContent()).toBe(scope);
});

test('MASTER generated alternatives preserve explicit known-ID read clauses and current choice labels @smoke', async ({ page }) => {
    for (const enabled of [false, true]) {
        const service = masterDefinition(enabled), consent = fixture.create();
        await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
        const review = JSON.parse(await page.locator('[name="approvalReview"]').inputValue());
        const options = require(path.join(root, 'src/pcm-core/src/approval-scopes')).approvalScopeOptions(fixture.store, service, { now: Date.parse(review.anchor) / 1000 });
        await page.locator('[data-alternative-permissions] > summary').click();
        for (const option of options) {
            const row = page.locator('#scope-' + option.id).locator('..'); await expect(row.locator('label')).toHaveText(option.label);
            await expect(row.locator('[name=scopeChoice]')).toHaveAttribute('data-scope-value', option.value);
            if (enabled) { expect(option.value).toContain('patient/Organization.r?'); expect(option.value).toContain('patient/Practitioner.r?'); expect(option.value).not.toContain('Organization.rs'); }
            else expect(option.value).not.toContain('patient/Organization.');
        }
        await expect(page.locator('#scope-service-provided')).toBeChecked();
    }
});

test('MASTER manual complete approval stays exact and the invariant notice replaces the retired full-access bypass @smoke', async ({ page }, info) => {
    masterDefinition(false);
    const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
    const exact = `patient/Patient.rs?${V} patient/Observation.rs?${V} patient/Organization.r?${V} patient/Practitioner.r?${V}`;
    const consent = fixture.create(), url = `${fixture.base}/ui/approve/${consent.id}`;
    await page.goto(url); await page.locator('[data-alternative-permissions] > summary').click(); await page.locator('#scope-custom').check(); await page.getByLabel('OAuth scope text').fill(exact);
    await Promise.all([page.waitForURL(`${fixture.base}/ui`), page.getByRole('button', { name: 'Approve request' }).click()]);
    await page.goto(url); await expect(page.locator('[data-approved-scope]')).toHaveText(exact);
    await page.locator('[data-exact-permissions] > summary').click();
    await expect(page.getByText('Every security preset enforces that scope and Patient/source context.', { exact: false })).toBeVisible();
    await expect(page.getByText('Sandbox override active:', { exact: false })).toHaveCount(0);
    expect(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope).toBe(exact);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('manual-master-approval.png'), fullPage: true });
});
