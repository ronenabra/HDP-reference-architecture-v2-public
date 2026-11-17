'use strict';
/** Real built-in catalog/provider controls with retained choices and passive Help. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const lifecycle = require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle'));
const checkpoint = require(path.join(root, 'src/pcm-core/src/migration-checkpoint'));
const id = lifecycle.BUILTIN_CATALOG_ID;
let fixture, original;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/full18' });
    const config = { ...fixture.config, serviceCatalog: { file: 'config/demo-services.json', bindings: [] } };
    const draft = require(path.join(root, 'src/pcm-core/src/bootstrap')).buildSeedDrafts(config).find(item => item.id === id);
    require(path.join(root, 'src/pcm-core/src/public-fhir')).publishNewResource(fixture.store, draft);
    for (const provider of fixture.store.getAll('Organization')) lifecycle.enrollProviderDefault({ store: fixture.store, provider });
    require(path.join(root, 'src/pcm-core/src/fhir/participant-lifecycle')).createServiceProviderChild({ store: fixture.store,
        callerOrganization: fixture.store.get('Organization', fixture.config.organizations.serviceProvider.id), request: { name: 'Later registered provider' }, idGenerator: () => 'later-provider18' });
    original = checkpoint.snapshot(fixture.store, { privateState: true });
});
test.beforeEach(() => { checkpoint.hydrate(fixture.store, original, { rollback: true }); });
test.afterAll(async () => { await fixture?.close(); });
const group = page => page.locator(`[data-service-group="${id}"]`);
const pair = (page, provider) => group(page).locator(`[data-provider-pair="${provider}"]`);
const registration = provider => fixture.store.getAll('HealthcareService').find(item => lifecycle.basedOnId(item) === id && lifecycle.ownerId(item) === provider && lifecycle.businessStatus(item) !== 'cancelled');

/** Open only mounted current HTML/JS and exact provider targets. */
async function open(browser, info, view = 'assignments') {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.base}/admin/services?view=${view}&target=${id}`);
    return { context, page, errors, mobile, click: locator => mobile ? locator.tap() : locator.click() };
}
/** Existing confirmations precede each deliberate lifecycle command. */
async function action(page, click, provider, name) {
    page.once('dialog', dialog => dialog.accept());
    await click(pair(page, provider).locator('[data-service-status-form]').getByRole('button', { name, exact: true }));
}

test('FULL18 exact scope/RV, every actual provider, independent choices and ordinary reconnect remain visible', async ({ browser }, info) => {
    const { page, context, click, errors, mobile } = await open(browser, info);
    try {
        const a = fixture.config.organizations.serviceProvider.id, b = fixture.config.organizations.hospitalBServiceProvider.id;
        await expect(group(page)).toContainText('Built-in'); await expect(group(page)).toContainText('patient/*.rs');
        await expect(group(page)).toContainText('Very Restricted (V)'); await expect(group(page).locator('[data-provider-pair]')).toHaveCount(3);
        const bId = registration(b).id;
        for (const [name, state] of [['Pause · Admin', 'Paused'], ['Resume · Admin', 'Connected']]) {
            page.once('dialog', dialog => dialog.accept());
            await click(pair(page, 'later-provider18').locator('[data-service-sandbox]').getByRole('button', { name, exact: true }));
            await expect(pair(page, 'later-provider18')).toContainText(state);
        }
        await action(page, click, a, 'Pause'); await expect(pair(page, a)).toContainText('Paused');
        await action(page, click, b, 'Disconnect'); await expect(pair(page, b)).toContainText('Ended');
        await click(pair(page, a).locator('[data-service-expansion] > summary'));
        await expect(pair(page, a).locator('[data-service-expansion]')).toContainText('Retained individual choice: paused');
        await click(pair(page, b).locator('[data-service-expansion] > summary'));
        await expect(pair(page, b).locator('[data-service-expansion]')).toContainText('Retained individual choice: disconnected');
        await expect(pair(page, 'later-provider18')).toContainText('Connected');
        await expect(pair(page, 'later-provider18').locator('[data-service-status-form]').getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
        await expect(pair(page, 'later-provider18')).toContainText('Ordinary API unavailable');
        for (const width of mobile ? [390, 320] : [1440, 1024]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await group(page).screenshot({ path: info.outputPath(`full-provider-${width}.png`) });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await group(page).screenshot({ path: info.outputPath('full-provider-200-percent.png') });
        await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        await page.goto(`${fixture.base}/admin/services?view=catalog&target=${id}`);
        const catalog = () => page.locator(`[data-catalog-id="${id}"]`);
        await expect(catalog()).toContainText('All supported patient data · read/search');
        await click(catalog().locator('[data-service-expansion] > summary'));
        await expect(catalog()).toContainText('Very Restricted (V)');
        await click(catalog().getByText('Exact saved service scope', { exact: true }));
        await expect(catalog().locator('[data-saved-scope]')).toHaveText('patient/*.rs');
        for (const label of ['Disable', 'Enable']) {
            page.once('dialog', dialog => dialog.accept()); await click(catalog().getByRole('button', { name: label, exact: true }));
            await expect(catalog().locator('[data-service-result]')).toContainText('Sandbox change saved');
            await click(catalog().getByRole('link', { name: 'Refresh Services', exact: true }));
            await expect(catalog()).toContainText(label === 'Disable' ? 'Disabled / frozen' : 'Active');
            await expect(catalog()).toContainText('Built-in');
        }
        await page.goto(`${fixture.base}/admin/services?view=assignments&target=${id}`);
        await expect(pair(page, a)).toContainText('Paused'); await expect(pair(page, b)).toContainText('Ended');
        await click(pair(page, b).getByRole('button', { name: 'Connect', exact: true }));
        await expect(group(page)).toContainText('Pending — waiting for activation');
        const pending = registration(b); expect(pending.id).not.toBe(bId); expect(lifecycle.businessStatus(pending)).toBe('pending');
        await action(page, click, a, 'Resume'); await expect(pair(page, a)).toContainText('Connected');
        expect(lifecycle.businessStatus(fixture.store.get('HealthcareService', bId))).toBe('cancelled');
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('full-access-receipt.json'), JSON.stringify({ requests: fixture.requests, events: fixture.events,
            defaults: fixture.store.getAll('Organization').filter(item => item.type?.some(code => code.coding?.some(value => value.code === 'service-provider'))).map(item => ({ id: item.id, defaults: fixture.store.privateRecords.services.getProviderDefaults(item.id) })), errors }, null, 2));
    } finally { await context.close(); }
});

test('FULL18 protected delete, exact catalog details and disabled native-touch/keyboard Help are passive', async ({ browser }, info) => {
    const { page, context, click, mobile, errors } = await open(browser, info, 'catalog');
    try {
        const row = page.locator(`[data-catalog-id="${id}"]`);
        await click(row.locator('[data-service-expansion] > summary')); await expect(row).toContainText('Includes Restricted (R) and Very Restricted (V)');
        await click(row.locator('[data-catalog-overflow] > summary'));
        const button = row.getByRole('button', { name: 'Delete definition', exact: true }); await expect(button).toBeDisabled();
        const before = JSON.stringify(checkpoint.snapshot(fixture.store, { privateState: true })), requests = fixture.requests.length;
        const explain = page.getByRole('checkbox', { name: 'Explain this page' }); await explain.check();
        if (mobile) {
            await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox();
            await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else {
            await row.locator('[data-help-for="services.delete"]').last().focus();
        }
        await expect(page.getByRole('tooltip')).toContainText('Built-in');
        await click(page.getByRole('button', { name: 'Dismiss explanation' }));
        if (mobile) await expect(explain).toBeFocused();
        await explain.uncheck(); await page.keyboard.press('Escape');
        expect(JSON.stringify(checkpoint.snapshot(fixture.store, { privateState: true }))).toBe(before);
        expect(fixture.requests.length).toBe(requests); expect(errors).toEqual([]);
        await row.screenshot({ path: info.outputPath('full-catalog-details.png') });
    } finally { await context.close(); }
});
