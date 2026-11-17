'use strict';
/** Actual mounted Admin integration and installed-engine smoke; no retained services. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/admin-sources-fixture')).startAdminSourcesFixture(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });
const address = (section, source, view) => `${fixture.base}/admin?section=${section}${source ? `&source=${source}` : ''}${view ? `&view=${view}` : ''}`;

test('Admin32 engine smoke: complete task navigation, source/app identities and actual responsive Explain remain passive', async ({ page, browser }, info) => {
    const errors = [], writes = [], views = [], source = fixture.config.healthOrganizations[1].dataSourceOrganization.id;
    const legacy = require(path.join(root, 'src/pcm-core/src/data-sources')).getConfiguredDataSources(fixture.config, { includeDisabled: true }).find(item => item.compatibilityOnly).id;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    const tasks = [
        ['overview'], ['sources', '', 'onboarding'], ['sources', legacy, 'mappings'],
        ['sources', source, 'data'], ['sources', source, 'limits'], ['security', source], ['apps'], ['certificates', source], ['logs', source], ['maintenance', source]
    ];
    for (const [section, selected, view] of tasks) {
        await page.goto(address(section, selected, view));
        await expect(page.locator(`[data-admin-section="${section}"][aria-current=page]`)).toBeVisible();
        if (section === 'sources' && selected) {
            await expect(page.locator('[data-source-workspace]')).toHaveAttribute('data-source-workspace', selected);
            await expect(page.locator('.admin-source-links [aria-current=page]')).toHaveText(({ mappings: 'Identity mappings', data: 'Clinical data', limits: 'Limits & capabilities' })[view]);
        }
        if (view === 'mappings') await expect(page.locator('main')).toContainText('000000018');
        const missing = await page.locator('[data-help-key], [data-help-disabled-key]').evaluateAll(nodes => [...new Set(nodes.flatMap(node => [node.dataset.helpKey, node.dataset.helpDisabledKey].filter(Boolean)))].filter(key => !window.PCM_HELP_COPY[key]?.body));
        expect(missing).toEqual([]);
        const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
        await toggle.uncheck(); await toggle.scrollIntoViewIfNeeded();
        const target = page.locator(`[data-admin-section="${section}"]`), before = await target.boundingBox();
        await toggle.check(); expect(await target.boundingBox()).toEqual(before);
        await target.focus(); await expect(page.getByRole('tooltip')).toBeVisible();
        await expect(page.getByRole('tooltip')).not.toHaveText('');
        await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).click(); await expect(target).toBeFocused();
        await toggle.uncheck();
        for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) {
            await page.setViewportSize({ width, height: 1000 }); await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${section}/${view || ''} ${width}/${zoom}`).toBe(true);
            if (info.project.name === 'chromium' && (width === 320 || width === 1440 && zoom === 1) && ['sources', 'apps', 'maintenance'].includes(section)) await page.screenshot({ path: info.outputPath(`${section}-${view || 'main'}-${width}.png`), fullPage: true });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '1'; }); await page.setViewportSize({ width: 1440, height: 1000 });
        expect(await page.locator('.help-icon, .help-gutter, .explain-icon').count()).toBe(0);
        views.push({ section, source: selected || '', view: view || '' });
    }
    await page.goto(address('apps', source));
    const assignment = page.getByRole('link', { name: 'Open provider assignments', exact: true }).first();
    await expect(assignment).toHaveAttribute('href', '/pcm/admin/services?view=assignments&providerRole=serviceProvider');
    await assignment.click(); await expect(page).toHaveURL(/\/pcm\/admin\/services\?view=assignments&providerRole=serviceProvider$/);
    await page.goBack(); await expect(page).toHaveURL(new RegExp(`section=apps&source=${source}$`));
    await page.getByRole('link', { name: 'View app in Certificates', exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`section=certificates&source=${source}&owner=${fixture.config.organizations.serviceProvider.id}$`));
    await page.getByRole('link', { name: 'Refresh', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`section=certificates&source=${source}&owner=${fixture.config.organizations.serviceProvider.id}$`));
    await page.getByRole('button', { name: 'Show owner', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`section=certificates&source=${source}&owner=${fixture.config.organizations.serviceProvider.id}$`));
    await page.getByRole('link', { name: 'Open app registration', exact: true }).first().click(); await expect(page).toHaveURL(new RegExp(`section=apps&source=${source}#provider-serviceProvider$`));
    await page.goto(address('sources', 'removed-exact-source', 'data')); await expect(page.getByRole('alert')).toContainText('no longer configured'); await expect(page.locator('[data-source-workspace]')).toHaveCount(0);
    expect(errors).toEqual([]); expect(writes).toEqual([]); expect(fixture.unchanged()).toBe(true);
    fs.writeFileSync(info.outputPath('runtime.json'), JSON.stringify({ engine: info.project.name, browserVersion: browser.version(), node: process.version, openssl: process.versions.openssl, playwright: require('@playwright/test/package.json').version, views, writes, errors, configUnchanged: fixture.unchanged() }, null, 2));
});

test('Admin32 engine smoke: actual mounted sign-in retains the exact certificate owner and source', async ({ browser }) => {
    const context = await browser.newContext();
    try {
        const page = await context.newPage(), source = fixture.config.healthOrganizations[1].dataSourceOrganization.id;
        const destination = `${address('certificates', source)}&owner=${fixture.config.organizations.serviceProvider.id}`;
        await page.goto(destination); await expect(page.getByLabel('Admin password', { exact: true })).toBeVisible();
        await page.getByLabel('Admin password', { exact: true }).fill(fixture.password); await page.getByRole('button', { name: 'Open Admin', exact: true }).click();
        await expect(page).toHaveURL(destination); await expect(page.locator('[data-credential-inventory]')).toBeVisible();
        await expect(page.locator('#certificate-owner')).toHaveValue(fixture.config.organizations.serviceProvider.id);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await page.locator('#certificate-owner').focus();
        await expect(page.getByRole('tooltip')).toContainText('retain the selected source context'); await page.keyboard.press('Escape'); await expect(page.locator('#certificate-owner')).toBeFocused();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.getByRole('button', { name: 'How to renew certificates', exact: true }).click();
        await expect(page).toHaveURL(destination);
        await expect(page.locator('main')).toContainText('No credentials were changed');
        await page.getByRole('link', { name: 'Back to Certificates', exact: true }).click(); await expect(page).toHaveURL(destination);
        expect(fixture.unchanged()).toBe(true);
    } finally { await context.close(); }
});

test('Admin32 engine smoke: dynamic trust/credential fields and native disabled recovery Help keep source state', async ({ page }, info) => {
    const writes = [], errors = [], { DataOperationRegistry } = require(path.join(root, 'src/pcm-core/src/data-operations'));
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(address('sources', '', 'onboarding')); await page.locator('[name=credentialMode]').selectOption('upload');
    await page.locator('[name=credentialProfile]').selectOption('separate-es384'); await page.locator('[name=serverTrustMode]').selectOption('custom-ca');
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' }); await toggle.check();
    const field = page.locator('[name=serverTrustCaCert]'); await field.tap(); await expect(page.getByRole('tooltip')).toContainText('CA');
    await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).click(); await expect(field).toBeFocused();
    const profile = page.locator('[name=credentialProfile]'); await profile.focus(); await expect(page.getByRole('tooltip')).toContainText('P-384'); await page.keyboard.press('Escape'); await expect(profile).toBeFocused();
    const registry = new DataOperationRegistry(), operation = registry.create('ho-b', 'import', { targetIdentity: JSON.stringify(fixture.config.healthOrganizations[1]) });
    registry.transition(operation.id, 'failed', { mutationSubmitted: true, needsReconciliation: true });
    const operationBytes = fs.readFileSync(registry.file(operation.id)), source = fixture.config.healthOrganizations[1].dataSourceOrganization.id;
    await page.goto(address('sources', source, 'limits')); await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const disabled = page.getByRole('button', { name: 'Save upload limits', exact: true }); await expect(disabled).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 1000 }); await disabled.scrollIntoViewIfNeeded();
    const box = await disabled.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole('tooltip')).toContainText('partially completed'); await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeFocused();
    await page.goto(address('sources', source, 'data')); await expect(page.locator('main')).toContainText(operation.id);
    await expect(page.locator('[data-managed-fhir-server]')).toHaveCount(1);
    expect(fs.readFileSync(registry.file(operation.id)).equals(operationBytes)).toBe(true); expect(writes).toEqual([]); expect(errors).toEqual([]); expect(fixture.unchanged()).toBe(true);
    await page.screenshot({ path: info.outputPath('recovery-state.png'), fullPage: true });
    fs.rmSync(registry.directory, { recursive: true, force: true });
});
