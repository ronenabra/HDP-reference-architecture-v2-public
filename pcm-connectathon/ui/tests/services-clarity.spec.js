'use strict';
/** Mounted Blank creation and expanded source-specific Help close the Services wording audit. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/clarity19' }); });
test.afterAll(async () => { await fixture?.close(); });

/** Inspect popup geometry as well as its source claim and visible dismissal. */
async function popup(page) {
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByRole('button', { name: 'Dismiss explanation' })).toBeInViewport({ ratio: 1 });
    const box = await tooltip.boundingBox(), viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    return tooltip;
}

test('CLARITY Blank creates only a catalog definition; expanded exact facts Help states protected provenance and preserves state', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), errors = [], traffic = [];
    const click = target => mobile ? target.tap() : target.click();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/admin/services')) traffic.push({ method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() }); });
    try {
        await page.goto(fixture.base + '/admin/services');
        const before = fixture.store.getAll('HealthcareService').filter(item => item.providedBy);
        await click(page.locator('[data-service-new]'));
        const form = page.locator('[data-service-create]');
        await expect(form.locator('[data-service-blank]')).toHaveAttribute('aria-pressed', 'true');
        await form.getByLabel('Service name', { exact: true }).fill(`Blank definition ${info.project.name}`);
        await form.getByLabel('Purpose', { exact: true }).fill('Explicit Blank starting point, no provider assignment');
        await form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]').check();
        await expect(form.locator('[data-preview-status]')).toContainText('Generated at');
        const shown = await form.getByLabel('Final service scope', { exact: true }).inputValue();
        await click(form.getByRole('button', { name: 'Create service', exact: true }));
        await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        const saved = fixture.store.getAll('HealthcareService').find(item => item.name === `Blank definition ${info.project.name}`);
        expect(saved.providedBy).toBeUndefined(); expect(fixture.store.getAll('HealthcareService').filter(item => item.providedBy)).toEqual(before);
        expect(fixture.store.privateRecords.services.getDefinition(saved.id).grant.scope).toBe(shown);
        await click(form.getByRole('link', { name: 'Refresh Services', exact: true }));
        await click(page.locator('[data-service-cancel]'));
        const row = page.locator(`[data-catalog-id="${saved.id}"]`);
        const details = row.locator('[data-service-expansion]');
        if (!await details.evaluate(node => node.open)) await click(details.locator(':scope > summary'));
        const facts = row.getByText('Exact public FHIR facts', { exact: true });
        await click(facts);
        const snapshot = JSON.stringify(fixture.store.getAll('HealthcareService')), requests = fixture.requests.length, tokens = fixture.tokens.size, events = fixture.events.length;
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await facts.focus(); await expect(await popup(page)).toContainText('Protected Admin inventory is distinct');
        await page.screenshot({ path: info.outputPath('expanded-details-help.png'), fullPage: false });
        await page.keyboard.press('Escape'); await expect(facts).toBeFocused();
        await page.setViewportSize({ width: mobile ? 320 : 1024, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        await page.evaluate(() => document.activeElement.blur());
        await facts.focus(); await popup(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('expanded-details-help-200-percent.png'), fullPage: false });
        await page.getByRole('button', { name: 'Dismiss explanation' }).click(); await expect(facts).toBeFocused();
        expect(JSON.stringify(fixture.store.getAll('HealthcareService'))).toBe(snapshot); expect(fixture.requests.length).toBe(requests); expect(fixture.tokens.size).toBe(tokens); expect(fixture.events.length).toBe(events);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('blank-and-passive-help.json'), JSON.stringify({ exactScope: shown, zeroNewRegistrations: true, passiveRequests: 0, traffic, diagnosticEvents: fixture.events.filter(event => event.target === `HealthcareService/${saved.id}`), errors }, null, 2));
    } finally { await context.close().catch(() => {}); }
});

/** Empty/error/loading displays remain distinct and passive on the actual mounted renderer. */
test('CLARITY empty inventory, invalid page and held Refresh retain honest recovery without mutations', async ({ browser }, info) => {
    const checkpoint = require(path.join(root, 'src/pcm-core/src/migration-checkpoint'));
    const original = checkpoint.snapshot(fixture.store, { privateState: true });
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 320 : 1024, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), click = target => mobile ? target.tap() : target.click();
    let release;
    try {
        fixture.store.clear();
        const requests = fixture.requests.length, tokens = fixture.tokens.size;
        await page.goto(fixture.base + '/admin/services');
        await expect(page.locator('[data-services-fragment="catalog"]')).toContainText('No shared service definitions on this page');
        await click(page.locator('[data-service-peer="assignments"]'));
        await expect(page.locator('[data-services-fragment="list"]')).toContainText('Create a service before connecting providers');
        await page.goto(fixture.base + '/admin/services?view=assignments&providerOffset=1');
        await expect(page.locator('[data-services-fragment="list"] [role="alert"]')).toContainText('Provider connections are unknown');
        await expect(page.locator('[data-services-fragment="list"] [role="alert"]')).toContainText('Refresh from the first page');
        checkpoint.hydrate(fixture.store, original, { rollback: true });
        await page.goto(fixture.base + '/admin/services');
        const count = await page.locator('[data-catalog-id]').count();
        const held = new Promise(resolve => { release = resolve; });
        await page.route(/\/admin\/services(?:\?.*)?$/, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); }, { times: 1 });
        await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('[data-services-loading]')).toHaveText('Loading Services…');
        await expect(page.locator('[data-services-loading]')).toBeVisible();
        await expect(page.locator('[data-catalog-id]')).toHaveCount(count);
        release(); await expect(page.locator('[data-services-loading]')).toBeHidden();
        expect(fixture.requests.length).toBe(requests); expect(fixture.tokens.size).toBe(tokens);
        fs.writeFileSync(info.outputPath('empty-error-loading.json'), JSON.stringify({ empty: true, errorRecovery: true, loadingRetainsRows: count, ordinaryRequests: 0, tokenChanges: 0 }, null, 2));
    } finally { release?.(); checkpoint.hydrate(fixture.store, original, { rollback: true }); await context.close().catch(() => {}); }
});
