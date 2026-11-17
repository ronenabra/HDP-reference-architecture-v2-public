'use strict';
/** R4 behavior proof against authored pages; synthetic delivery isolates polling/detail races. */
const { test, expect } = require('@playwright/test');
const { installWorkbenchFixture, event } = require('./logs-workbench-fixture');
const base = 'http://127.0.0.1:43180';

test('R4 JSON, purpose facts, filtering, stable polls and independent tools retain selected evidence', async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const fixture = await installWorkbenchFixture(page, { count: 1200 });
    const writes = []; page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
    await page.goto(`${base}/logs-view?diagnostics=false`);
    await expect(page.locator('#view-state')).toHaveText('Following latest');
    await expect(page.locator('[data-open-panel="coverage"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit filters', exact: true }).click();
    await expect(page.locator('#filter-role')).toBeVisible();
    await page.locator('#filter-role').selectOption('doctor');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    if (await page.locator('#workbench').isVisible()) await page.locator('#close-workbench').click();
    await expect(page.locator('#filter-summary')).toHaveText('Role: doctor');
    await expect(page.locator('#filter-overflow')).toBeHidden();
    const toolbar = await page.locator('#scope-strip').boundingBox();
    for (let i = 0; i < 3; i++) {
        let release; fixture.responseGate = new Promise(resolve => { release = resolve; });
        await page.evaluate(() => { refreshLogs(); });
        await expect(page.locator('#view-state')).toHaveText('Following latest');
        expect(await page.locator('#scope-strip').boundingBox()).toEqual(toolbar);
        fixture.responseGate = null; release();
        await expect.poll(() => page.evaluate(() => activeRead === null)).toBe(true);
    }
    fixture.detailResponder = async (route, reference) => {
        const id = Number(reference.replace('fabricated-reference-', ''));
        const entry = event(id); entry.details = { type: 'HAPI_RESULT_FILTER_SUMMARY', examined: 3, allowed: 3, removed: 0, nested: [{ child: { exact: 'nested-current-' + id } }] };
        await route.fulfill({ json: { entry, raw: 'exact source ' + id } }); return true;
    };
    await page.locator('.log-row').nth(10).click();
    await expect(page.locator('#tab-json')).toHaveAttribute('aria-selected', 'true');
    const json = page.locator('#panel-json pre');
    await expect(json).toContainText('nested-current-');
    const value = await json.textContent(); expect(value).toBe(JSON.stringify(JSON.parse(value), null, 2));
    await page.locator('#copy-detail').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    await page.locator('#tab-structured').click();
    await expect(page.locator('#record-explorer-host')).toContainText('Input examined');
    await expect(page.locator('#record-explorer-host')).toContainText('Excluded');
    await page.screenshot({ path: info.outputPath('logs-structured.png') });
    await expect(page.locator('#panel-structured [data-help-key="logs.payload"]')).toHaveCount(0);
    await page.locator('#record-explorer-host input').fill('nested-current');
    await page.locator('#record-explorer-host input').press('Enter');
    await expect(page.locator('.explorer-results')).toContainText('nested-current');
    await page.locator('#tab-raw').click(); await expect(page.locator('.raw-source-text')).toContainText('exact source');
    const held = await page.evaluate(() => ({ id: selectedId, scroll: document.getElementById('log-list').scrollTop }));
    await page.getByRole('button', { name: 'Tools and options', exact: true }).click();
    for (const name of ['coverage', 'columns', 'filters', 'tools']) {
        await page.locator(`[data-panel-tab="${name}"]`).click();
        await expect(page.locator(`[data-panel-tab="${name}"]`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#close-workbench')).toHaveText('Close tools');
    }
    await page.locator('[data-panel-tab="tools"]').press('Home');
    await expect(page.locator('[data-panel-tab="filters"]')).toBeFocused();
    await page.locator('[data-panel-tab="filters"]').press('End');
    await page.screenshot({ path: info.outputPath('logs-tools.png') });
    await page.keyboard.press('Escape'); await expect(page.locator('#workbench')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Tools and options', exact: true })).toBeFocused();
    await expect(page.locator('#event-detail')).toBeVisible();
    expect(await page.evaluate(() => ({ id: selectedId, scroll: document.getElementById('log-list').scrollTop }))).toEqual(held);
    const heldRaw = await page.locator('.raw-source-text').textContent();
    await page.evaluate(async () => {
        const list = document.getElementById('log-list'); list.scrollTop = list.scrollHeight;
        list.dispatchEvent(new Event('scroll')); await maybeLoadHistory();
    });
    await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(200);
    await expect(page.locator('#view-state')).toHaveText('Position held');
    expect(await page.evaluate(() => selectedId)).toBe(held.id);
    expect(await page.locator('.raw-source-text').textContent()).toBe(heldRaw);
    expect(fixture.reads.some(read => read.cursor && !read.cursor.startsWith('live@'))).toBe(true);
    await page.locator('#close-event-detail').click(); await expect(page.locator('#event-detail')).toBeHidden();
    await page.locator('.log-row').nth(11).click(); await page.locator('#tab-json').click();
    await expect(json).not.toHaveText(value);
    fixture.detailResponder = async route => { await route.fulfill({ status: 410, json: { error: 'Selected source cleared' } }); return true; };
    await page.locator('.log-row').nth(12).click(); await expect(page.locator('#panel-json')).toContainText('Selected source cleared');
    await expect(page.locator('#copy-detail')).toBeDisabled();
    fixture.detailResponder = async route => { await route.fulfill({ json: {} }); return true; };
    await page.locator('.log-row').nth(13).click(); await expect(page.locator('#panel-json')).toContainText('Selected record is unavailable');
    await expect(page.locator('#copy-detail')).toBeDisabled();
    const detailReads = fixture.details.length;
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    if (info.project.name.endsWith('mobile')) {
        const bounds = await page.locator('#copy-detail').boundingBox();
        await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    } else await page.getByRole('button', { name: 'Explain Copy selected format', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('complete normalized JSON');
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    if (info.project.name.endsWith('mobile')) await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeFocused();
    else await expect(page.getByRole('button', { name: 'Explain Copy selected format', exact: true })).toBeFocused();
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    expect(fixture.details.length).toBe(detailReads);
    expect(writes).toEqual([]);
    await page.screenshot({ path: info.outputPath('logs-error.png') });
});

test('R4 reserved Explain remains reachable at scroll and narrow zoom without mutations', async ({ page }, info) => {
    await installWorkbenchFixture(page);
    const writes = []; page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
    for (const width of (info.project.name.endsWith('mobile') ? [390, 320] : [1440, 1024])) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}/logs-view`);
        await expect(page.locator('#view-state')).toHaveText('Following latest');
        await page.locator('.log-row').nth(10).click();
        await expect(page.locator('#panel-json pre')).toBeVisible();
        const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
        const before = await page.locator('#command-bar').boundingBox(); await toggle.check();
        expect(await page.locator('#command-bar').boundingBox()).toEqual(before);
        await page.locator('#copy-detail').focus(); await expect(page.getByRole('tooltip')).toBeVisible();
        await page.keyboard.press('Escape'); await toggle.uncheck();
        const geometry = await page.locator('.explain-bar').evaluate(node => ({ top: node.getBoundingClientRect().top, right: node.getBoundingClientRect().right, width: innerWidth, overflow: document.documentElement.scrollWidth }));
        expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width + 1); expect(geometry.overflow).toBeLessThanOrEqual(width + 1);
        await page.screenshot({ path: info.outputPath(`logs-${width}.png`) });
    }
    // Browser zoom reduces the CSS viewport; CSS body zoom leaves viewport units
    // unchanged and can manufacture clipping in fixed-position drawers.
    const unzoomedViewport = page.viewportSize();
    await page.setViewportSize({ width: Math.floor(unzoomedViewport.width / 2), height: Math.floor(unzoomedViewport.height / 2) });
    await page.getByRole('button', { name: 'Tools and options', exact: true }).click();
    const drawerTop = await page.locator('#workbench').evaluate(node => node.getBoundingClientRect().top);
    const explainBottom = await page.locator('.explain-bar').evaluate(node => node.getBoundingClientRect().bottom);
    if (page.viewportSize().width < 768) expect(drawerTop).toBeGreaterThanOrEqual(explainBottom - 1);
    for (const control of await page.locator('#workbench [role="tab"], #close-workbench').all()) {
        const bounds = await control.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    }
    await page.screenshot({ path: info.outputPath('logs-tools-200.png') });
    await page.locator('#close-workbench').click();
    await page.goto(`${base}/fixture/doctor`);
    await page.locator('#doctor-tools-button').click();
    await expect(page.locator('#doctor-tools-panel')).toBeVisible();
    const barBottom = await page.locator('.explain-bar').evaluate(node => node.getBoundingClientRect().bottom);
    expect((await page.locator('#doctor-tools-panel').boundingBox()).y).toBeGreaterThanOrEqual(barBottom);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#doctor-tools-button').focus(); await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    if (await page.locator('#doctor-tools-panel').isVisible()) await page.locator('#doctor-tools-panel [data-tools-close]').click();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.explain-toggle')).toBeInViewport();
    await page.evaluate(() => { document.body.style.zoom = '2'; });
    await expect(page.locator('.explain-toggle')).toBeInViewport();
    await page.screenshot({ path: info.outputPath('doctor-scroll-200.png') });
    await page.goto(`${base}/admin`);
    await expect(page.locator('.explain-bar .explain-toggle')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await expect(page.locator('.explain-toggle')).toHaveCount(1);
    expect(writes).toEqual([]);
});
