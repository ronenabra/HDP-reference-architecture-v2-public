'use strict';
/** Actual mounted PCM/Doctor routes over disposable files; no retained team or clinical calls. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let server, localServer, central, origin, localOrigin, localFile;
const record = { id: 'local37-exact', timestamp: '2026-11-14T01:00:00Z', level: 'INFO', message: 'Owned37 literal <script> event',
    details: { type: 'REQUEST', category: 'system', visibility: 'default', method: 'GET', url: '/fhir/Patient', token: 'complete-owned37-token', flowId: 'owned37-flow', traceId: 'a'.repeat(32) } };
test.beforeAll(async () => {
    const express = require(path.join(root, 'node_modules/express')), app = express(), doctor = express();
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    localServer = doctor.listen(0, '127.0.0.1'); await new Promise(resolve => localServer.once('listening', resolve));
    localOrigin = `http://127.0.0.1:${localServer.address().port}`;
    require(path.join(root, 'test-support/team-config')).installTestRuntime({ publicBaseUrls: { pcmUi: origin+'/pcm', spClient: localOrigin+'/doctor' } });
    central = require(path.join(root, 'src/pcm-core/src/index')).createUiApp(); app.use('/pcm', central);
    process.env.LOG_DIR = path.join(process.env.SHARED_LOGS_DIR, 'sp-client');
    doctor.use('/doctor', require(path.join(root, 'src/sp-client/src/index')).app);
    localFile = require(path.join(root, 'src/sp-client/src/logger')).getLogPath();
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    fs.writeFileSync(localFile, JSON.stringify(record)+'\n');
});
test.afterAll(async () => { await central?.locals.closeLogSearch(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); localServer?.closeAllConnections(); if (localServer) await new Promise(resolve => localServer.close(resolve)); });
/** Check actual widths and zoom without assuming screen similarity implies interaction parity. */
async function layouts(page, info, prefix) {
    const sizes = info.project.name.endsWith('mobile') ? [[390,1],[320,1]] : [[1440,1],[1024,1],[1440,2]];
    for (const [width, zoom] of sizes) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom=String(z); }, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth+1), `${prefix} ${width} zoom${zoom}`).toBe(true);
        const shell = await page.locator('header.sandbox-header').evaluate(header => { const nav=header.querySelector('.sandbox-navigation'); return { bottom:header.getBoundingClientRect().bottom, navBottom:nav.getBoundingClientRect().bottom }; });
        expect(shell.navBottom).toBeLessThanOrEqual(shell.bottom+1);
        await expect(page.getByRole('checkbox',{name:'Explain this page'})).toBeVisible();
        await page.screenshot({ path: info.outputPath(`${prefix}-${width}-zoom${zoom}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.style.zoom='1'; });
    await page.setViewportSize({ width: info.project.name.endsWith('mobile') ? 390 : 1440, height: 1000 });
}
/** Open reference help by keyboard; normal touch actions retain their action semantics. */
async function explain(page, target, text, info) {
    await target.focus(); await expect(page.getByRole('tooltip')).toContainText(text);
    if (info) await page.screenshot({path:info.outputPath('tools-explanation.png'),fullPage:true});
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toBeHidden(); await expect(target).toBeFocused();
}
test('Logs37 local/central navigation, exact selection/copy, tools and icon-free Help preserve reads and scope', async ({ page }, info) => {
    const queries=[], mutations=[], errors=[];
    page.on('request', req => { if (req.url().includes('/api/unified-logs/search')) queries.push(req.method()); if (!['GET','HEAD'].includes(req.method())) mutations.push(req.method()+' '+req.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.owned37Copies=[]; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.owned37Copies.push(text); } } }); });
    await page.goto(localOrigin+'/doctor/logs-view'); await expect(page.locator('.log-entry').filter({ hasText: record.message })).toBeVisible();
    await page.locator('#pauseSwitch').check(); await layouts(page, info, 'doctor-local');
    await page.locator('#local-tools-button').click(); await expect(page.locator('#close-local-tools')).toBeFocused();
    await expect(page.locator('#copy-local')).toBeDisabled();
    await page.getByRole('checkbox', { name:'Explain this page' }).check();
    if (info.project.name.endsWith('mobile')) { const disabled = await page.locator('#copy-local').boundingBox(); await page.touchscreen.tap(disabled.x+disabled.width/2, disabled.y+disabled.height/2); await expect(page.getByRole('tooltip')).toContainText('Select an event first'); await page.screenshot({path:info.outputPath('local-disabled-touch-help.png'),fullPage:true}); await page.keyboard.press('Escape'); }
    else { await explain(page, page.locator('#close-local-tools'), 'return keyboard focus'); }
    await expect(page.locator('#local-tools')).toBeVisible();
    await page.getByRole('checkbox', { name:'Explain this page' }).uncheck();
    await page.locator('#close-local-tools').click(); await expect(page.locator('#local-tools-button')).toBeFocused();
    await page.locator('.log-entry').filter({ hasText:record.message }).click();
    await expect(page.locator('#details-pane pre')).toHaveText(JSON.stringify(record.details,null,2));
    await page.locator('#local-tools-button').click(); await page.locator('#copy-local').click();
    expect(JSON.parse(await page.evaluate(() => window.owned37Copies.at(-1)))).toEqual(record);
    await page.keyboard.press('Escape'); await expect(page.locator('#local-tools-button')).toBeFocused();
    await page.getByRole('link', { name:'Open central Logs', exact:true }).click();
    await expect(page).toHaveURL(/\/pcm\/logs-view\?role=doctor$/); await expect(page.locator('.log-row').first()).toBeVisible();
    expect(await page.locator('#filter-role').inputValue()).toBe('doctor');
    await page.evaluate(() => holdReading()); await page.locator('.log-row').filter({ hasText:'GET /fhir/Patient' }).first().click();
    await page.locator('#tab-raw').click(); const raw=await page.locator('pre.raw-source-text').textContent(); expect(JSON.parse(raw).message).toBe(record.message);
    await page.locator('#copy-detail').click(); expect(await page.evaluate(() => window.owned37Copies.at(-1))).toBe(raw);
    await layouts(page, info, 'central');
    const before = await page.evaluate(() => ({ selected:selectedId, following:followingLatest, anchor:captureAnchor() }));
    const controlRect = await page.locator('#follow-latest').boundingBox();
    await page.getByRole('checkbox', { name:'Explain this page' }).check();
    expect(await page.locator('#follow-latest').boundingBox()).toEqual(controlRect);
    const trace = page.locator('#event-metadata-body [data-help-key="logs.trace-id"]').first();
    if (info.project.name.endsWith('mobile')) await trace.tap(); else await trace.focus();
    await expect(page.getByRole('tooltip')).toContainText('recorded propagated trace');
    await page.screenshot({path:info.outputPath('dynamic-trace-explanation.png'),fullPage:true});
    await page.getByRole('button',{name:'Dismiss explanation',exact:true}).click();
    await expect(page.locator('#event-detail')).toBeVisible();
    await page.locator('[data-open-panel="tools"]').click(); await expect(page.locator('#close-workbench')).toHaveText('Close tools');
    await explain(page,page.locator('#close-workbench'),'Event detail stays open',info);
    await expect(page.locator('#workbench')).toBeVisible(); await expect(page.locator('#event-detail')).toBeVisible();
    await page.screenshot({path:info.outputPath('tools-popup-dismissed.png'),fullPage:true});
    await page.locator('#close-workbench').click(); await expect(page.locator('[data-open-panel="tools"]')).toBeFocused();
    // Focus return may open the trigger's own Help; dismiss it before switching Explain off.
    await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(page.locator('#event-detail')).toBeVisible();
    await page.getByRole('checkbox', { name:'Explain this page' }).uncheck();
    const held = await page.evaluate(() => captureAnchor());
    expect(held.id).toBe(before.anchor.id); expect(Math.abs(held.offset-before.anchor.offset)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => selectedId)).toBe(before.selected); expect(await page.evaluate(() => followingLatest)).toBe(false);
    expect(await page.locator('pre.raw-source-text').textContent()).toBe(raw);
    await page.locator('[data-open-panel="filters"]').click(); await page.locator('#filter-method').selectOption('GET');
    await page.getByRole('button',{name:'Apply filters',exact:true}).click();
    if(await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
    await expect(page.locator('#filter-summary')).toContainText('GET');
    await page.locator('#follow-latest').click(); await expect(page.locator('#view-state')).toContainText('Following latest');
    await page.locator('[data-open-panel="tools"]').click();
    await expect(page.getByRole('link',{name:'Full logs JSON (Admin)'})).toHaveAttribute('href','/pcm/admin/logs/download');
    let confirmed=false; page.once('dialog',async dialog=>{confirmed=true; await dialog.dismiss();});
    await page.getByRole('button',{name:'Clear built-in logs',exact:true}).click(); expect(confirmed).toBe(true);
    expect(queries).toEqual([]); expect(mutations).toEqual([]); expect(errors).toEqual([]);
    await info.attach('passive-and-selection', {body:JSON.stringify({queries,mutations,errors,before,rawBytes:Buffer.byteLength(raw)}),contentType:'application/json'});
});
