'use strict';
/** Actual help bubbles on supported metadata, dynamic selections and both payload tabs.
 * Controlled source responses exercise presentation only; real API suites run separately.
 */
const { test, expect } = require('@playwright/test');
const { installWorkbenchFixture, event } = require('./logs-workbench-fixture');
const base = process.env.PCM_OPS_FIXTURE_URL;
const labels = ['Timestamp', 'Level', 'Event ID', 'Schema version', 'Classification', 'Event name', 'Source identity',
    'Source component ID', 'Source file', 'Source byte offset', 'Provenance', 'Derived from', 'Flow ID',
    'Correlation / request ID', 'Trace ID', 'Span ID', 'Parse status', 'Provenance note'];

/** Dismiss without Escape, which also closes ordinary panes by design. */
async function dismiss(page) { const close = page.getByRole('button', { name: 'Dismiss explanation' }); if (await close.isVisible()) await close.click(); }
for (const order of ['flow', 'timeline']) test(`complete metadata explanation audit ${order} @smoke`, async ({ page }, info) => {
    test.setTimeout(150000);
    const fixture = await installWorkbenchFixture(page);
    let variant = 'emitted';
    fixture.detailResponder = async (route, reference) => {
        const entry = event(Number(reference.replace('fabricated-reference-', '')));
        entry.event.correlation.spanId = 'bbbbbbbbbbbbbbbb';
        entry.event.provenance = { kind: variant, derivedFrom: { source: 'historical response' }, note: 'Synthetic recorded provenance note' };
        if (variant === 'legacy') { delete entry.event; entry.details = { type: 'LEGACY_EVENT', requestId: 'legacy-exact-request', arbitraryKey: 'literal value' }; }
        if (variant === 'unparsed') { delete entry.event; entry.details = {}; }
        await route.fulfill({ json: { entry, raw: 'synthetic exact source\r\n', parseError: 'Synthetic parse status',
            provenance: entry.event?.provenance || { kind: variant, derivedFrom: 'recorded source', note: 'Synthetic recorded provenance note' },
            source: { componentId: 'pcm-core', logFile: 'history/synthetic.log', byteOffset: 0 } } }); return true;
    };
    await page.addInitScript(order => localStorage.setItem('unifiedLogOrderMode', order), order);
    await page.goto(`${base}/logs-view?diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' }), tooltip = page.getByRole('tooltip');
    await page.locator('.log-row').first().click();
    await expect(page.locator('#event-metadata dt')).toHaveCount(labels.length);
    await page.locator('#event-metadata dt').first().hover(); await expect(tooltip).toBeHidden();
    for (const [index, kind] of ['emitted', 'derived', 'legacy', 'unparsed'].entries()) {
        if (index) {
            await dismiss(page); await toggle.uncheck(); await page.locator('#close-event-detail').click();
            variant = kind; await page.locator('.log-row').nth(index).click();
        }
        await toggle.check();
        const selected = await page.evaluate(() => selectedId), raw = await page.evaluate(() => selectedResult.raw);
        for (const tab of ['structured', 'raw']) {
            await dismiss(page); await page.locator(`#tab-${tab}`).click();
            for (const label of labels) {
                const target = page.locator('#event-metadata dt').filter({ hasText: new RegExp('^' + label + '$') });
                await target.focus();
                await expect(tooltip).toBeVisible();
                const key = await target.getAttribute('data-help-key');
                const authored = await page.evaluate(key => window.PCM_HELP_COPY[key], key);
                await expect(tooltip).toContainText(authored.body);
                expect(authored.body.length).toBeGreaterThan(35);
                const box = await tooltip.boundingBox();
                expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
                expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
            }
        }
        if (index === 0) {
            await dismiss(page);
            const span = page.locator('#event-metadata [data-help-key="logs.span-id"]');
            await span.scrollIntoViewIfNeeded();
            if (info.project.use.hasTouch) await span.tap(); else await span.hover();
            await expect(tooltip).toContainText('recorded span identifier');
            await dismiss(page); await page.locator('#event-metadata dt').first().focus();
            await page.keyboard.press('Tab'); await expect(tooltip).toContainText('informational event');
        }
        if (kind === 'derived') await expect(page.locator('#event-metadata')).toContainText('no separately captured raw request');
        if (kind === 'legacy' || kind === 'unparsed') {
            await expect(page.locator('#event-metadata')).toContainText('Legacy record (no event schema)');
            await expect(page.locator('#event-metadata')).toContainText('Not recorded');
        }
        expect(await page.evaluate(() => selectedId)).toBe(selected); expect(await page.evaluate(() => selectedResult.raw)).toBe(raw);
        await dismiss(page); await toggle.uncheck();
        await page.locator('#event-metadata dt').last().hover(); await expect(tooltip).toBeHidden();
        await expect(page.locator('.explain-affordance')).toHaveCount(0);
    }
    await page.screenshot({ path: info.outputPath(`help-${order}.png`), fullPage: true });
});

// This recreates the STATUS failure with a pending history render while a specific
// severity cell is focused. The cell must retain WARN help, including after scrolling.
test('specific severity keyboard help survives history rendering @smoke', async ({ page }) => {
    await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view`); await expect(page.locator('.log-row')).toHaveCount(200);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const warn = page.locator('[data-help-key="logs.level-warn"]').first();
    await warn.focus(); await expect(page.getByRole('tooltip')).toContainText('warning or recoverable');
    await page.evaluate(() => applyLogResult(currentResult, false, true));
    await expect(page.getByRole('tooltip')).toContainText('warning or recoverable');
    await expect(page.locator('[data-help-key="logs.level-warn"]:focus')).toHaveCount(1);
});

/** Concept identity is checked through actual bubbles on both consuming surfaces. */
test('table and metadata reuse complete ID concept bubbles without changing selection @smoke', async ({ page }) => {
    await installWorkbenchFixture(page); await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200); await page.locator('.log-row').first().click();
    const id = await page.evaluate(() => selectedId);
    await page.evaluate(() => { changeColumns('flowId', true); changeColumns('traceId', true); });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    for (const [column, key] of [['correlationId', 'logs.correlation'], ['flowId', 'logs.flow-id'], ['traceId', 'logs.trace-id']]) {
        const metadata = page.locator(`#event-metadata [data-help-key="${key}"]`);
        await metadata.focus(); const content = await page.getByRole('tooltip').textContent();
        const header = page.locator(`th[data-column="${column}"]`);
        await expect(header).toHaveAttribute('data-help-key', key); await header.focus();
        await expect(page.getByRole('tooltip')).toHaveText(content);
    }
    expect(await page.evaluate(() => selectedId)).toBe(id);
    await dismiss(page); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await expect(page.locator('td[data-column="level"][tabindex]')).toHaveCount(0);
});

/** Audit newer structured/copy controls with actual bubbles and no mutation traffic. */
test('structured and copy control explanations match the selected format @smoke', async ({ page }, info) => {
    await installWorkbenchFixture(page); const writes = [];
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.goto(`${base}/logs-view`); await expect(page.locator('.log-row')).toHaveCount(200);
    await page.locator('.log-row').first().click(); await expect(page.locator('#record-explorer-host')).toBeVisible();
    const selected = await page.evaluate(() => selectedId), raw = await page.evaluate(() => selectedResult.raw);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const targets = ['#tab-structured', '#tab-raw', '#wrap-detail', '#copy-detail', 'summary[data-help-key="logs.payload"]',
        '#record-explorer-host h3[data-help-key="logs.explorer"]', '#record-explorer-host input[data-help-key="logs.field-search"]',
        '#record-explorer-host button[data-help-key="logs.copy-value"]'];
    for (const selector of targets) {
        const target = page.locator(selector).first(); await target.focus();
        const key = await target.getAttribute('data-help-key');
        await expect(page.getByRole('tooltip')).toContainText(await page.evaluate(key => window.PCM_HELP_COPY[key].body, key));
    }
    await dismiss(page); await page.locator('#tab-raw').click();
    await expect(page.locator('#copy-detail')).toHaveText('Copy raw text'); await page.locator('#copy-detail').focus();
    await expect(page.getByRole('tooltip')).toContainText('exact source text after an explicit click');
    await page.screenshot({ path: info.outputPath('structured-copy-help.png'), fullPage: true });
    await dismiss(page); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    expect(await page.evaluate(() => selectedId)).toBe(selected); expect(await page.evaluate(() => selectedResult.raw)).toBe(raw);
    expect(writes).toEqual([]); await expect(page.getByRole('tooltip')).toBeHidden();
});
