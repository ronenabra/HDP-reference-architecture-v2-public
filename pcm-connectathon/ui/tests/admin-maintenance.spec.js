'use strict';
/** Actual protected mounted Maintenance; no private backup bytes are persisted as evidence. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
const read = () => JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
const address = () => `${fixture.base}/admin?section=maintenance&source=${fixture.config.healthOrganizations[1].dataSourceOrganization.id}`;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/admin-shell-fixture')).startAdminShellFixture();
    fs.cpSync(require(path.join(root, 'test-support/certificates')).certificates(), process.env.CERTS_DIR, { recursive: true });
    await require(path.join(root, 'src/pcm-core/src/bootstrap'))();
    const registry = new (require(path.join(root, 'src/pcm-core/src/data-operations')).DataOperationRegistry)();
    fixture.operation = registry.create('ho-b', 'import'); registry.transition(fixture.operation.id, 'failed');
});
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });

test('maintenance31 passive scope/restart review, widths/zoom, keyboard/native touch Help and source owner back/forward preserve bytes', async ({ page }, info) => {
    fs.writeFileSync(info.outputPath('runtime.json'), JSON.stringify({ node: process.version, openssl: process.versions.openssl, playwright: require('@playwright/test/package.json').version }, null, 2));
    const writes = [], errors = []; page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); }); page.on('pageerror', error => errors.push(error.message));
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await page.goto(address()); await expect(page.getByRole('heading', { name: 'Backup & restore', exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('credentials and private keys'); await expect(page.locator('main')).toContainText('complete runtime Consent state');
    await expect(page.locator('main')).toContainText('pcm-public-metadata-migration/1'); await expect(page.locator('main')).toContainText('31 seconds');
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath(`maintenance-${width}-${zoom}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; }); await page.setViewportSize({ width: 390, height: 1000 });
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' }), input = page.getByLabel('Paste backup JSON', { exact: true });
    await toggle.scrollIntoViewIfNeeded(); const beforeToggle = await input.boundingBox(); await toggle.check(); expect(await input.boundingBox()).toEqual(beforeToggle);
    await input.tap(); await expect(page.getByRole('tooltip')).toContainText('same team'); await page.keyboard.press('Escape'); await expect(input).toBeFocused();
    const freeze = page.getByRole('button', { name: 'Freeze migration checkpoint', exact: true }); await freeze.focus(); await expect(page.getByRole('tooltip')).toContainText('Freeze PCM'); await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).click(); await expect(freeze).toBeFocused();
    await toggle.uncheck();
    await expect(page.getByRole('link', { name: 'Open this operation in Logs', exact: true })).toHaveAttribute('href', new RegExp(`operationId=${fixture.operation.id}&sourceId=org-team-a-ho-b-source$`));
    await page.getByRole('link', { name: `Saved operation · ${fixture.operation.id}`, exact: true }).click(); await expect(page.locator('body')).toContainText(fixture.operation.id); await page.goBack(); await expect(page).toHaveURL(/section=maintenance&source=org-team-a-ho-b-source$/);
    await page.getByRole('link', { name: /^Source deletion and import recovery/ }).click(); await expect(page).toHaveURL(/section=sources&source=org-team-a-ho-b-source&view=data$/);
    await page.goBack(); await expect(page).toHaveURL(/section=maintenance&source=org-team-a-ho-b-source$/); await page.goForward(); await expect(page.locator('[data-managed-fhir-server]')).toHaveCount(1);
    await page.goBack(); await page.getByRole('link', { name: 'How to renew certificates', exact: true }).click(); await expect(page).toHaveURL(/section=certificates&source=org-team-a-ho-b-source&owner=org-team-a-ho-b-source$/);
    await page.goBack(); await page.getByRole('link', { name: 'Log export and clear', exact: true }).click(); await expect(page).toHaveURL(/section=logs&source=org-team-a-ho-b-source$/);
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(process.env.STATE_DIR, 'pcm-ig-041-maintenance'))).toBe(false);
});

test('maintenance31 file and paste share protected restore, malformed/oversized feedback focus, existing confirmations and actual reset effects', async ({ page }, info) => {
    const store = require(path.join(root, 'src/pcm-core/src/fhir/store')), tokens = require(path.join(root, 'src/pcm-core/src/store')).tokens;
    await page.goto(address());
    const file = page.getByLabel('Select backup JSON file', { exact: true }), input = page.getByLabel('Paste backup JSON', { exact: true });
    await file.setInputFiles({ name: 'malformed.json', mimeType: 'application/json', buffer: Buffer.from('{PRIVATE_KEY_CANARY') });
    await expect(page.locator('#restore-backup-status')).toContainText('not valid JSON'); await expect(page.locator('#restore-backup-status')).toBeFocused(); await expect(input).toHaveValue('');
    await file.setInputFiles({ name: 'oversize.json', mimeType: 'application/json', buffer: Buffer.alloc(1024 * 1024 + 1, 32) });
    await expect(page.locator('#restore-backup-status')).toContainText('1 MiB'); await expect(page.locator('#restore-backup-status')).toBeFocused();
    // The genuine protected export remains in process memory only.
    const response = await page.request.get(`${fixture.base}/admin/backup`, { headers: { 'x-admin-password': fixture.password } }), backup = await response.json();
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await file.setInputFiles({ name: 'configuration-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await expect(page.locator('#restore-backup-status')).toContainText('No server changes'); expect(await input.inputValue()).toBe(JSON.stringify(backup)); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Restore backup', exact: true }).click(); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    // Submit the same selected file through the existing ordinary confirmation.
    store.add({ resourceType: 'Consent', id: 'browser-old-consent', status: 'draft' }); const oldToken = tokens.issue('management', {}, 60).token;
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(page).toHaveURL(/admin\/restore\?source=org-team-a-ho-b-source$/); await expect(page.locator('main')).toContainText('Previous runtime Consents were not restored'); expect(store.get('Consent', 'browser-old-consent')).toBeNull(); expect(tokens.peek(oldToken)).toBeUndefined(); expect(store.getAll('HealthcareService').length).toBeGreaterThan(0);
    await expect(page.locator('#restore-backup-json')).toHaveValue('');
    // Wrong-team paste gets the same server flow and focused non-secret error.
    const wrong = { ...backup, teamId: 'another-owned-team' }; await page.locator('#restore-backup-json').fill(JSON.stringify(wrong));
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
    await expect(page.locator('#admin-error-summary')).toContainText('another team'); await expect(page.locator('#admin-error-summary')).toBeFocused(); await expect(page.locator('#restore-backup-json')).toHaveValue(''); await expect(page.locator('body')).not.toContainText('PRIVATE_KEY_CANARY');
    await page.screenshot({ path: info.outputPath('maintenance-restore-error.png'), fullPage: true });
    await page.locator('#restore-backup-json').fill('{invalid PRIVATE_KEY_CANARY'); page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Restore backup', exact: true }).click(); await expect(page.locator('#admin-error-summary')).toContainText('not valid JSON'); await expect(page.locator('#admin-error-summary')).toBeFocused();
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })) ).not.toMatch(/BEGIN|PRIVATE_KEY_CANARY|teamConfig/);
    const resetToken = tokens.issue('management', {}, 60).token; store.add({ resourceType: 'Consent', id: 'browser-reset-consent', status: 'draft' });
    page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Reset runtime', exact: true }).click(); expect(store.get('Consent', 'browser-reset-consent')).not.toBeNull();
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Reset runtime', exact: true }).click(); await expect(page.locator('main')).toContainText('PCM runtime reset. Issued tokens were cleared'); expect(store.get('Consent', 'browser-reset-consent')).toBeNull(); expect(tokens.peek(resetToken)).toBeUndefined();
    await page.screenshot({ path: info.outputPath('maintenance-reset-result.png'), fullPage: true });
});

test('maintenance31 actual Freeze remains separately confirmed and creates the existing private checkpoint/fence only on acceptance', async ({ page }, info) => {
    process.env.PCM_MIGRATION_RUNTIME_ID = require(path.join(root, 'src/shared/public-metadata-compatibility')).artifacts(root).pcm;
    await page.goto(address()); const fence = path.join(process.env.STATE_DIR, 'pcm-ig-041-maintenance');
    expect(fs.existsSync(fence)).toBe(false);
    page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Freeze migration checkpoint', exact: true }).click(); expect(fs.existsSync(fence)).toBe(false);
    const response = page.waitForResponse(response => response.url().includes('/admin/migration/checkpoint') && response.request().method() === 'POST');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Freeze migration checkpoint', exact: true }).click();
    const result = await response, state = await result.json(); expect(result.status()).toBe(200); expect(state.phase).toBe('prepared'); expect(state.privateSchema).toBe('pcm-private-state/1'); expect(state.runtimeId).toBe(process.env.PCM_MIGRATION_RUNTIME_ID); expect(fs.existsSync(fence)).toBe(true);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(process.env.STATE_DIR, 'pcm-ig-041/checkpoint.json'))); expect(checkpoint._private).toBeTruthy(); expect(checkpoint.HealthcareService.length).toBeGreaterThan(0);
    const blocked = await page.request.post(`${fixture.base}/admin/reset`, { headers: { 'x-admin-password': fixture.password }, data: {} }); expect(blocked.status()).toBe(503);
    fs.writeFileSync(info.outputPath('checkpoint-scope.json'), JSON.stringify({ phase: state.phase, privateSchema: state.privateSchema, publicProjectionSchema: state.publicProjectionSchema, scope: state.scope, runtimeId: state.runtimeId, previewRequired: state.previewRequired, ordinaryResetStatus: blocked.status() }, null, 2));
});
