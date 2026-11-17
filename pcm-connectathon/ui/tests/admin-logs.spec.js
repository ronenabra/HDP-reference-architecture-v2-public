'use strict';
/** Actual owned mounted routes, retained exact search, shared Help and both bulk entry points. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
/** Append only owned fixture records using the configured inventory path. */
function write(component, filename, entries) { const file = path.join(process.env.SHARED_LOGS_DIR, component, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, entries.map(item => JSON.stringify(item)).join('\n') + '\n'); }
const record = (message, details = {}) => ({ timestamp: '2026-11-14T01:00:00Z', level: 'INFO', message, details: { category: 'admin', visibility: 'diagnostic', ...details } });
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/admin-shell-fixture')).startAdminShellFixture({ observability: { sources: [{ id: 'owned30', label: 'Owned read-only', role: 'addon' }] } }, { logToInventory: true });
    write('pcm-core', 'history/retained/app.log', [record('owned source event', { sourceId: 'admin22-custom' }), record('owned import event', { operationId: '00000000-0000-4000-8000-000000000030' }), record('unrelated event', { operationId: 'unrelated' })]);
    write('extensions/owned30', 'current.log', [record('read-only extension evidence')]);
});
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });

test('Admin30 one-viewer layout wraps at all widths and uses native touch/keyboard Explain without mutations', async ({ page }, info) => {
    const mutations = [], errors = []; page.on('request', req => { if (!['GET', 'HEAD'].includes(req.method())) mutations.push(req.url()); }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base + '/admin?section=logs'); await expect(page.getByRole('link', { name: 'Download full logs JSON', exact: true })).toHaveAttribute('href', '/pcm/admin/logs/download');
    await expect(page.locator('main table')).toHaveCount(0); await expect(page.locator('main input[type=search]')).toHaveCount(0);
    for (const [width, zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]) {
        await page.setViewportSize({ width, height:1000 }); await page.evaluate(zoom => { document.documentElement.style.zoom=String(zoom); }, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth+1), `${width} zoom${zoom}`).toBe(true);
        await expect(page.getByRole('button', { name:'Clear built-in logs', exact:true })).toBeVisible(); await page.screenshot({ path:info.outputPath(`admin-logs-${width}-zoom${zoom}.png`), fullPage:true });
    }
    await page.evaluate(() => { document.documentElement.style.zoom='1'; }); await page.setViewportSize({ width:390, height:1000 });
    const toggle = page.getByRole('checkbox', { name:'Explain this page' }), download = page.getByRole('link', { name:'Download full logs JSON', exact:true });
    await toggle.scrollIntoViewIfNeeded(); const before = await download.boundingBox(); await toggle.check(); expect(await download.boundingBox()).toEqual(before);
    await page.locator('p[data-help-key="admin.logs-json"]').tap(); await expect(page.getByRole('tooltip')).toContainText('Viewer filters never restrict'); await page.keyboard.press('Escape'); await expect(page.locator('p[data-help-key="admin.logs-json"]')).toBeFocused(); await download.focus(); await expect(page.getByRole('tooltip')).toContainText('Viewer filters never restrict'); await page.keyboard.press('Escape'); await expect(download).toBeFocused();
    const clear = page.getByRole('button', { name:'Clear built-in logs', exact:true }); await clear.focus(); await expect(page.getByRole('tooltip')).toContainText('Read-only extension'); await page.getByRole('button', { name:'Dismiss explanation', exact:true }).click(); await expect(clear).toBeFocused(); await toggle.uncheck();
    expect(mutations).toEqual([]); expect(errors).toEqual([]); expect(fixture.unchanged()).toBe(true);
    await page.getByRole('link', { name:'Open Logs', exact:true }).last().click(); await expect(page).toHaveURL(/\/pcm\/logs-view\?diagnostics=true$/); await expect(page.locator('#diagnostic-visibility')).toHaveText('Diagnostics shown');
    await page.getByRole('button', { name:'Filters', exact:true }).click();
    await expect(page.getByLabel('Operation ID (exact)', { exact:true })).toBeVisible(); await expect(page.getByLabel('Registered source ID (exact)', { exact:true })).toBeVisible();
    for (const [width, zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]) {
        await page.setViewportSize({ width,height:1000 }); await page.evaluate(z=>{document.documentElement.style.zoom=String(z);},zoom);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`central filters ${width} zoom${zoom}`).toBe(true);
        await expect(page.getByLabel('Registered source ID (exact)',{exact:true})).toBeVisible();
        if(width===1440||width===320) await page.screenshot({path:info.outputPath(`central-filters-${width}-zoom${zoom}.png`),fullPage:true});
    }
    await page.evaluate(()=>{document.documentElement.style.zoom='1';}); await page.setViewportSize({width:390,height:1000});
    await page.locator('#close-workbench').click(); await page.getByRole('checkbox',{name:'Explain this page'}).check(); await page.getByRole('button',{name:'Filters',exact:true}).click(); const sourceFilter=page.getByLabel('Registered source ID (exact)',{exact:true}); await sourceFilter.focus(); await expect(page.getByRole('tooltip')).toContainText('recorded registered source ID exactly'); await page.getByRole('button',{name:'Dismiss explanation',exact:true}).click(); await expect(sourceFilter).toBeFocused(); await page.keyboard.press('Escape'); await expect(page.getByRole('button',{name:'Filters',exact:true})).toBeFocused();
    expect(mutations).toEqual([]); expect(errors).toEqual([]);
});

test('Admin30 source, import and failed-readiness links preserve exact identity; missing/cleared/unavailable evidence never substitutes a record', async ({ page }, info) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base + '/admin?section=sources&source=admin22-custom&view=diagnostics'); await page.getByRole('link', { name:'Open related diagnostics', exact:true }).click();
    await expect(page).toHaveURL(/sourceId=admin22-custom$/); await expect(page.locator('#log-table-body')).toContainText('owned source event'); await expect(page.locator('#log-table-body')).not.toContainText('unrelated event'); await expect(page.locator('#diagnostic-visibility')).toHaveText('Diagnostics shown');
    await page.goto(fixture.base + '/admin/logs/view?operationId=00000000-0000-4000-8000-000000000030'); await expect(page).toHaveURL(/logs-view\?diagnostics=true&operationId=/); await expect(page.locator('#log-table-body')).toContainText('owned import event'); await expect(page.locator('#log-table-body')).not.toContainText('unrelated event'); await page.screenshot({ path:info.outputPath('exact-import.png'), fullPage:true });
    await page.goto(fixture.base + '/admin/logs/view?operationId=missing-owned30'); await expect(page.locator('#log-table-body')).toContainText('No matches within'); await expect(page.locator('#log-table-body tr[data-log-id]')).toHaveCount(0);
    await page.goto(fixture.base + '/admin/logs/view?operationId=old30&stage=failure'); await expect(page.getByRole('status').filter({ hasText:'cannot preserve' })).toContainText('stage'); await expect(page.locator('main table')).toHaveCount(0); await expect(page.getByRole('link', { name:'Open broader Logs context', exact:true })).toHaveAttribute('href', /operationId=old30/);
    await page.goto(fixture.base + '/admin?section=sources&source=admin22-custom&view=diagnostics'); await page.getByRole('button', { name:'Test source', exact:true }).click(); await expect(page.getByRole('heading', { name:'Source readiness', exact:true })).toBeVisible(); await expect(page.locator('main')).toContainText('fail. Readiness is not conformance certification'); const readinessUrl = await page.getByRole('link', { name:'Open related diagnostics', exact:true }).getAttribute('href');
    await page.getByRole('link', { name:'Open related diagnostics', exact:true }).click(); await expect(page.locator('#log-table-body')).toContainText('DATA_SOURCE_READINESS_COMPLETED'); await expect(page.locator('#diagnostic-visibility')).toHaveText('Diagnostics shown'); await page.screenshot({ path:info.outputPath('failed-readiness-context.png'), fullPage:true });
    await page.goto(fixture.base + '/admin?section=logs'); let dialogs=0; page.once('dialog', async dialog => { dialogs++; await dialog.accept(); }); await page.getByRole('button', { name:'Clear built-in logs', exact:true }).click(); await expect(page).toHaveURL(/admin\?section=logs$/); expect(dialogs).toBe(1);
    await page.goto(new URL(readinessUrl, fixture.base).href); await expect(page.locator('#log-table-body')).toContainText('No matches within');
    write('pcm-core', 'current.log', [record('post-clear event', { operationId:'post-clear' })]);
    await page.goto(fixture.base + '/admin/logs/view?operationId=post-clear'); await expect(page.locator('#log-table-body')).toContainText('post-clear event');
    await page.getByRole('button', { name:'Tools', exact:true }).click(); const exportLink=page.getByRole('link', { name:'Full logs JSON (Admin)', exact:true }); await expect(exportLink).toHaveAttribute('href','/pcm/admin/logs/download'); await expect(exportLink).toBeVisible();
    page.once('dialog', async dialog => { dialogs++; await dialog.accept(); }); await page.getByRole('button', { name:'Clear built-in logs', exact:true }).click(); await expect(page.locator('#log-status')).toContainText('read-only extension'); expect(dialogs).toBe(2);
    write('pcm-core', 'current.log', [record('fresh after viewer clear', { operationId:'after-viewer-clear' })]);
    // Deliberate non-file source proves unavailable scope is visible in the existing viewer.
    fs.rmSync(path.join(process.env.SHARED_LOGS_DIR,'sp-client/current.log'), { force:true }); fs.mkdirSync(path.join(process.env.SHARED_LOGS_DIR,'sp-client/current.log'));
    await page.goto(fixture.base + '/logs-view?diagnostics=true&operationId=unavailable-owned30'); await expect(page.locator('#search-progress')).toContainText('unavailable sources: sp-client'); await expect(page.locator('#log-table-body')).toContainText('Search stopped'); await expect(page.locator('#log-table-body tr[data-log-id]')).toHaveCount(0);
    expect(errors).toEqual([]); expect(fixture.unchanged()).toBe(true);
});
