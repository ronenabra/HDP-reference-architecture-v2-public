'use strict';
/** Current real gateway trace in the existing reader: selection, interruptions, return and truthful gaps. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');

/** Use native touch or keyboard activation for the representative project. */
async function activate(locator, info) {
    if (info.project.name.endsWith('mobile')) await locator.tap();
    else { await locator.focus(); await locator.press('Enter'); }
}

test('actual gateway parentage survives exact investigation, interruption, Back and Return', async ({ page, request }, info) => {
    await request.post('/fixture/reset');
    const manifest = await (await request.get('/fixture/manifest')).json(), samples = [], renderSamples = [], responseSamples = [], responseReads = [], errors = [];
    const starts = new WeakMap();
    page.on('response', response => { if (response.url().includes('/api/unified-logs') && response.status() === 200) responseReads.push(response.body().then(body => responseSamples.push({ path: new URL(response.url()).pathname, bytes: body.length }))); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', value => starts.set(value, performance.now()));
    page.on('requestfinished', value => { if (value.url().includes('/api/unified-logs')) samples.push({ path: new URL(value.url()).pathname, elapsedMs: performance.now() - starts.get(value) }); });
    await page.goto('/logs-view?role=hapi&diagnostics=false');
    await expect(page.locator('.log-row').first()).toBeVisible();
    await page.evaluate(trace => { document.getElementById('filter-traceId').value = trace; return startSearch(); }, manifest.traceId);
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    const native = await page.evaluate(() => currentLogs.find(row => row.details.type === 'HAPI_RESPONSE'));
    await activate(page.locator('[data-log-id="' + native.id + '"]'), info);
    await expect(page.locator('.record-metadata')).toContainText('Parent span ID');
    await expect(page.locator('.record-metadata')).toContainText(native.details.parentSpanId);
    await page.locator('#tab-raw').click();
    const raw = await page.evaluate(() => selectedResult.raw);
    await activate(page.locator('[data-inspect-field="traceId"]'), info);
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    const roles = await page.evaluate(() => searchSession.observedRoles);
    renderSamples.push(await page.evaluate(() => window.logPageTimings));
    for (const role of ['doctor', 'gateway', 'adapter', 'pcm', 'hapi']) expect(roles).toContain(role);
    expect(await page.evaluate(() => showDiagnosticLogs)).toBe(false);
    await expect(page.locator('#investigation-description')).toContainText('correlation-only events are excluded');
    const gateway = await page.evaluate(() => currentLogs.find(row => row.event?.source?.role === 'gateway' && row.details.type === 'GATEWAY_REQUEST' && row.details.url === '/auth'));
    const gatewayDetail = await (await request.get('/api/unified-logs/detail?reference=' + encodeURIComponent(gateway.reference))).json();
    expect(gatewayDetail.entry.details.traceContextOrigin).toBe('internal');
    expect(await page.evaluate(parent => currentLogs.some(row => row.event?.correlation?.spanId === parent), gateway.details.parentSpanId)).toBe(true);
    await activate(page.locator('#return-to-results'), info);
    await expect.poll(() => page.evaluate(() => selectedResult?.raw)).toBe(raw);
    await page.goBack(); await expect(page.locator('#investigation-title')).toContainText('Trace');
    await page.goForward(); await expect.poll(() => page.evaluate(() => selectedResult?.raw)).toBe(raw);
    // Repeat the exact investigation after interrupting its transport. Retry retains admitted scope.
    await page.route('**/api/unified-logs/search', route => route.abort());
    await activate(page.locator('[data-inspect-field="traceId"]'), info);
    await expect(page.locator('#search-progress')).toContainText(/fail|could|unavailable/i);
    await page.unroute('**/api/unified-logs/search');
    await page.evaluate(() => retrySearch());
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await activate(page.locator('#return-to-results'), info);
    await expect.poll(() => page.evaluate(() => selectedResult?.raw)).toBe(raw);
    await page.evaluate(() => holdReading()); expect(await page.evaluate(() => followingLatest)).toBe(false);
    await request.post('/fixture/source/missing');
    const missing = await (await request.get('/api/unified-logs?page=true&diagnostics=false')).json();
    expect(missing.sources.find(value => value.componentId === 'ho-b-gateway').state).toBe('missing');
    expect(missing.entries.length).toBeGreaterThan(0);
    await request.post('/fixture/source/heal');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const parentHelp = page.locator('.record-metadata [data-help-key="logs.parent-span-id"]');
    await parentHelp.scrollIntoViewIfNeeded();
    if (info.project.name.endsWith('mobile')) await parentHelp.tap(); else await parentHelp.focus();
    await expect(page.getByRole('tooltip')).toContainText('recorded parent');
    const helpBounds = await page.getByRole('tooltip').boundingBox();
    expect(helpBounds.x).toBeGreaterThanOrEqual(0); expect(helpBounds.y).toBeGreaterThanOrEqual(0);
    expect(helpBounds.x + helpBounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    if (info.project.name.endsWith('mobile')) await page.getByRole('button', { name: 'Dismiss' }).tap(); else await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
    if (await page.locator('#workbench').isVisible()) await page.locator('#close-workbench').click();
    for (const width of (info.project.name.endsWith('mobile') ? [390, 320] : [1440, 1024])) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: info.outputPath('trace-' + width + '.png'), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    if (!info.project.name.endsWith('mobile')) {
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        await page.screenshot({ path: info.outputPath('trace-200-percent.png'), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    for (const sample of samples) expect(sample.elapsedMs).toBeLessThan(2000);
    await Promise.all(responseReads);
    for (const sample of renderSamples) { expect(sample.renderMilliseconds).toBeLessThan(2000); expect(sample.rows).toBeLessThanOrEqual(600); }
    for (const sample of responseSamples) expect(sample.bytes).toBeLessThanOrEqual(1048576);
    expect(errors).toEqual([]);
    fs.writeFileSync(info.outputPath('journey.json'), JSON.stringify({ manifest, roles, raw, samples, renderSamples, responseSamples, missing: missing.sources.find(value => value.componentId === 'ho-b-gateway') }, null, 2));
});
