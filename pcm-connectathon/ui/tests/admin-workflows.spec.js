'use strict';
/** Three distinct protected workflows with passive preview, real forms and native Explain. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/admin-shell-fixture')).startAdminShellFixture({ conformance: { preset: 'connectathon-balanced' } });
    await require(path.join(root, 'src/pcm-core/src/bootstrap'))();
});
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });
const address = area => `${fixture.base}/admin?section=${area}`;
const saved = () => JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
test('workflow28 three owners remain separate and passive with responsive keyboard/touch Explain', async ({ page }, info) => {
    const writes = [], errors = []; page.on('request', req => { if (!['GET', 'HEAD'].includes(req.method())) writes.push(req.url()); }); page.on('pageerror', error => errors.push(error.message));
    const bytes = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await page.goto(address('security')); await expect(page.getByRole('heading', { name: 'Test workflows', exact: true })).toBeVisible(); await expect(page.locator('[data-doctor-connectivity]')).toHaveCount(0);
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await expect(page.getByRole('button', { name: 'Save test workflows', exact: true })).toBeVisible();
        if (width === 1440 || width === 320) await page.screenshot({ path: info.outputPath(`workflows-security-${width}-${zoom}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; }); await page.setViewportSize({ width: 390, height: 1000 });
    const field = page.locator('[name="otp.expirySeconds"]'); const before = await field.boundingBox(); await page.getByRole('checkbox', { name: 'Explain this page' }).check(); expect(await field.boundingBox()).toEqual(before);
    await field.focus(); await expect(page.getByRole('tooltip')).toContainText('Resend must be shorter'); await page.keyboard.press('Escape'); await expect(field).toBeFocused();
    await page.locator('[name="otp.resendSeconds"]').tap(); await expect(page.getByRole('tooltip')).toContainText('Attempts count'); await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).click(); await expect(page.locator('[name="otp.resendSeconds"]')).toBeFocused();
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await page.getByRole('link', { name: 'Source-specific budgets and HMO classification' }).click(); await page.getByRole('link', { name: 'Eligible HMO source reconciliation' }).click();
    await expect(page.getByRole('heading', { name: 'Eligible HMO sources', exact: true })).toBeVisible(); await expect(page.locator('[data-test-workflows]')).toHaveCount(0);
    await page.getByRole('link', { name: 'Preview eligible sources', exact: true }).click(); await expect(page.locator('main')).toContainText('Exact reviewed source versions');
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) { await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath(`workflows-sources-${width}-${zoom}.png`), fullPage: true }); }
    await page.goto(address('apps')); await expect(page.getByRole('heading', { name: 'Doctor & SMART', exact: true })).toBeVisible(); await expect(page.locator('[data-workflow-sources]')).toHaveCount(0);
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) { await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true); await page.screenshot({ path: info.outputPath(`workflows-apps-${width}-${zoom}.png`), fullPage: true }); }
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(bytes)).toBe(true);
});
test('workflow28 timing save and stale/invalid drafts show associated errors without replacing saved clocks', async ({ page }, info) => {
    await page.goto(address('security')); await page.locator('[name="otp.expirySeconds"]').fill('45'); await page.locator('[name="otp.resendSeconds"]').fill('2'); await page.getByRole('button', { name: 'Save test workflows', exact: true }).click();
    await expect(page).toHaveURL(/workflowSaved=/); expect(saved().systemAuthorization.otp.expirySeconds).toBe(45); await expect(page.locator('main')).toContainText('Changed settings invalidate outstanding local flows');
    await page.locator('[name="otp.expirySeconds"]').fill('50'); await page.locator('[data-workflow-settings] [name=expectedRevision]').evaluate(input => { input.value = '-1'; }); await page.getByRole('button', { name: 'Save test workflows', exact: true }).click();
    await expect(page.locator('#admin-error-summary')).toBeFocused(); await expect(page.locator('[name="otp.expirySeconds"]')).toHaveValue('50'); expect(saved().systemAuthorization.otp.expirySeconds).toBe(45);
    await page.goto(address('security')); await page.locator('[data-workflow-settings]').evaluate(form => { form.noValidate = true; }); await page.locator('[name="discovery.maxRetries"]').fill('4'); await page.getByRole('button', { name: 'Save test workflows', exact: true }).click();
    await expect(page.locator('[name="discovery.maxRetries"]')).toHaveValue('4'); await expect(page.locator('[name="discovery.maxRetries"]')).toHaveAttribute('aria-invalid', 'true'); await expect(page.locator('#admin-error-summary')).toBeFocused(); await page.screenshot({ path: info.outputPath('workflows-clock-error.png'), fullPage: true });
});
test('workflow28 exact source and callback reviews reject stale Apply and retain non-secret proposed base', async ({ page }, info) => {
    await page.goto(`${fixture.base}/admin/workflow-sources/preview`); await page.getByRole('button', { name: 'Apply reviewed source reconciliation', exact: true }).click(); await expect(page.locator('main')).toContainText('Reconciliation saved');
    await page.goto(`${fixture.base}/admin/workflow-sources/preview`); const cfg = saved(); cfg.runtime.revision++; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(cfg));
    await page.getByRole('button', { name: 'Apply reviewed source reconciliation', exact: true }).click(); await expect(page.locator('#admin-error-summary')).toBeFocused(); await expect(page.locator('main')).toContainText('Refresh the preview');
    await page.goto(address('apps')); const proposed = 'http://doctor.example.test:13100/owned-mount'; await page.getByLabel('Proposed Doctor browser base', { exact: true }).fill(proposed); await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await page.getByLabel('Proposed Doctor browser base', { exact: true }).focus(); await expect(page.getByRole('tooltip')).toContainText('explicit browser application base'); await page.keyboard.press('Escape'); await expect(page.getByLabel('Proposed Doctor browser base', { exact: true })).toBeFocused(); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck(); const bytes = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await page.getByRole('button', { name: 'Preview Doctor callbacks', exact: true }).click(); await expect(page.getByRole('region', { name: 'Doctor callback review' })).toContainText(`${proposed}/callback`); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(bytes)).toBe(true); await expect(page.locator('main')).toContainText('Restart pending SMART tests'); await expect(page.getByRole('region', { name: 'Doctor callback review' })).toContainText('existing provider ownership verified'); await page.screenshot({ path: info.outputPath('workflows-callback-review.png'), fullPage: true });
    const changed = saved(); changed.runtime.revision++; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(changed)); await page.getByRole('button', { name: 'Apply reviewed Doctor callbacks', exact: true }).click(); await expect(page.locator('#admin-error-summary')).toBeFocused(); await expect(page.getByLabel('Proposed Doctor browser base', { exact: true })).toHaveValue(proposed); await page.screenshot({ path: info.outputPath('workflows-callback-stale.png'), fullPage: true });
    await page.getByRole('button', { name: 'Preview Doctor callbacks', exact: true }).click(); await page.getByRole('button', { name: 'Apply reviewed Doctor callbacks', exact: true }).click(); expect(saved().publicBaseUrls.spClient).toBe(proposed); await expect(page.locator('main')).toContainText('backed up privately'); await expect(page.locator('main')).toContainText('Live connectivity not checked');
});

test('workflow28 unavailable Contract reason stays visible and disabled Apply explains without mutation', async ({ page }, info) => {
    const store = require(path.join(root, 'src/pcm-core/src/fhir/store'));
    const contract = store.get('Contract', 'policy-patient-authentication'); store.update({ ...contract, status: 'revoked' });
    const bytes = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await page.goto(`${fixture.base}/admin/workflow-sources/preview`);
    await expect(page.locator('main')).toContainText('expired, not yet valid or not executed');
    const apply = page.getByRole('button', { name: 'Apply reviewed source reconciliation', exact: true }); await expect(apply).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await apply.tap({ force: true });
    await expect(page.getByRole('tooltip')).toContainText('missing, expired or terminal'); await page.keyboard.press('Escape'); await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeFocused();
    await page.screenshot({ path: info.outputPath('workflows-unavailable-policy.png'), fullPage: true });
    expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(bytes)).toBe(true); expect(store.get('Contract', contract.id).status).toBe('revoked');
});
