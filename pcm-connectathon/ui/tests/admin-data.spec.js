'use strict';
/** Data25 selected-source forms, native Help and honest read/save/error presentation. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/admin-shell-fixture')).startAdminShellFixture(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });
const address = () => `${fixture.base}/admin?section=sources&source=${fixture.config.healthOrganizations[0].dataSourceOrganization.id}&view=data`;

test('data25 selected tasks stay passive, wrap long errors and support keyboard/native-touch Explain', async ({ page }, info) => {
    const writes = [], errors = [];
    page.on('request', req => { if (!['GET','HEAD'].includes(req.method())) writes.push(req.method()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(address());
    await expect(page.locator('[data-managed-fhir-server]')).toHaveCount(1);
    await expect(page.locator('main')).toContainText('Replacement clears this target before loading');
    await expect(page.locator('main')).toContainText('Saving this mapping does not import');
    await expect(page.locator('#delete-ho-a')).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Delete all data', exact: true })).toBeDisabled();
    const longError = 'Owned unavailable response ' + 'source-and-dataset-not-verified-'.repeat(24);
    await page.route('**/admin/api/fhir-servers/ho-a/data', route => route.fulfill({ status:502, json:{ error:longError } }));
    await page.locator('[data-target-counts]').click();
    await expect(page.locator('[data-target-count-output]')).toContainText('No zero count or empty state is inferred');
    const toggle = page.getByRole('checkbox', { name:'Explain this page' }); await toggle.check();
    await page.locator('#replace-ho-a').focus(); await expect(page.getByRole('tooltip')).toContainText('clears this target');
    await page.keyboard.press('Escape'); await expect(page.locator('#replace-ho-a')).toBeFocused();
    const reference = page.locator('#bootstrap-reference-ho-a');
    await reference.tap(); await expect(page.getByRole('tooltip')).toContainText('portable location');
    await page.getByRole('button', { name:'Dismiss explanation', exact:true }).click(); await expect(reference).toBeFocused();
    await toggle.uncheck();
    for (const [width, zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]) {
        await page.setViewportSize({ width, height:1000 });
        await page.evaluate(zoom => { document.documentElement.style.zoom=String(zoom); }, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth+1), `${width} zoom ${zoom}`).toBe(true);
        await expect(page.getByRole('button', { name:'Save bootstrap mapping', exact:true })).toBeVisible();
        if (width===1440 || width===320) await page.screenshot({ path:info.outputPath(`data-${width}-zoom${zoom}.png`), fullPage:true });
    }
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(fixture.unchanged()).toBe(true);
});

test('data25 startup conflict retains the exact source draft and explicit refresh does not import', async ({ page }, info) => {
    const imports=[]; page.on('request', req => { if (req.url().endsWith('/imports')) imports.push(req.url()); });
    await page.goto(address());
    await page.locator('#bootstrap-policy-ho-a').selectOption('if-empty');
    await page.locator('#bootstrap-reference-ho-a').fill('catalog/draft.source.transaction.json');
    await page.locator('#bootstrap-source-ho-a').fill('owned-draft');
    await page.locator('[name=expectedRevision]').evaluate(input => { input.value='-1'; });
    await page.getByRole('button', { name:'Save bootstrap mapping', exact:true }).click();
    await expect(page.locator('[role=alert]').filter({ hasText:'Startup settings changed' })).toBeVisible();
    await expect(page.locator('#bootstrap-reference-ho-a')).toHaveValue('catalog/draft.source.transaction.json');
    await expect(page.locator('#bootstrap-source-ho-a')).toHaveValue('owned-draft');
    await expect(page.locator('[data-managed-fhir-server]')).toHaveAttribute('data-managed-fhir-server','ho-a');
    await page.getByRole('button', { name:'Refresh saved server details', exact:true }).click();
    // Refresh of a failed POST URL would otherwise repeat the mutation or become404.
    await expect(page.locator('main')).toContainText('Managed HAPI clinical data');
    expect(imports).toEqual([]); expect(fixture.unchanged()).toBe(true);
    await page.screenshot({ path:info.outputPath('startup-conflict.png'), fullPage:true });
});

test('data25 saved unknown keeps recovery proofs separate and links exact operation and Admin inventory', async ({ page }, info) => {
    const { DataOperationRegistry } = require(path.join(root, 'src/pcm-core/src/data-operations'));
    const registry = new DataOperationRegistry();
    const operation = registry.create('ho-a', 'import');
    registry.transition(operation.id, 'failed', { mutationSubmitted:true, needsReconciliation:true,
        submittedOutcome:'unknown', diagnostics:['Owned saved unknown outcome; no mutation was submitted by this browser fixture.'] });
    await page.goto(address());
    const result = page.locator('#data-operation-ho-a');
    await expect(result).toContainText("couldn't confirm whether the import finished");
    await expect(result).toContainText('Last observed stage');
    await expect(result.locator('details a')).toHaveAttribute('href', `/pcm/admin/api/data-operations/${operation.id}`);
    await expect(page.getByRole('link', { name:'Raw verified Admin inventory JSON (all managed sources)' })).toHaveAttribute('href','/pcm/admin/api/patients');
    const recovery = page.locator('[data-recovery-controls]');
    await expect(recovery).toContainText('import process and its database transaction have both stopped');
    await expect(recovery.locator('[name=workersStopped]')).toHaveCount(2);
    for (const checkbox of await page.locator('[name=workersStopped],[data-delete-acknowledgement]').all()) await expect(checkbox).not.toBeChecked();
    const clear = recovery.getByRole('button', { name:/Clear .* and allow another import/ });
    await expect(clear).toBeDisabled();
    await page.getByRole('checkbox', { name:'Explain this page' }).check();
    await recovery.locator('[name=workersStopped]').first().tap();
    await expect(page.getByRole('tooltip')).toContainText('database transaction');
    await page.getByRole('button', { name:'Dismiss explanation' }).tap();
    await page.getByRole('checkbox', { name:'Explain this page' }).uncheck();
    await page.reload();
    for (const checkbox of await page.locator('[name=workersStopped],[data-delete-acknowledgement]').all()) await expect(checkbox).not.toBeChecked();
    expect(registry.get(operation.id).submittedOutcome).toBe('unknown');
    expect(require('node:fs').existsSync(registry.lockFile('ho-a'))).toBe(true);
    for (const width of [1440,320]) {
        await page.setViewportSize({ width,height:1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth+1)).toBe(true);
        await page.screenshot({ path:info.outputPath(`saved-unknown-${width}.png`),fullPage:true });
    }
});
