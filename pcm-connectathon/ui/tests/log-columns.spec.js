'use strict';
/** Real bounded Logs API, table layout, native clipboard and local display preferences. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
/** Native keyboard or touch activation. */
async function activate(locator, info) { if (info.project.name.endsWith('mobile')) await locator.tap(); else { await locator.focus(); await locator.press('Enter'); } }
/** Open Columns using the actual command-bar control/drawer. */
async function columns(page, info) { if (await page.locator('#workbench').isVisible()) await activate(page.locator('#close-workbench'), info); await activate(page.locator('[data-open-panel="columns"]'), info); }
/** Close the upper sidebar so the event table remains reachable on mobile. */
async function close(page, info) { if (await page.locator('#workbench').isVisible()) await activate(page.locator('#close-workbench'), info); }
/** Compare actual column rectangles and spans rather than CSS declarations. */
async function alignment(page) {
    const data = await page.evaluate(() => {
        const head = [...document.querySelectorAll('th[data-column]')].filter(node => !node.hidden);
        const row = document.querySelector('.log-row');
        return { columns: head.map(node => { const cell = row.querySelector(`[data-column="${node.dataset.column}"]`); return { id: node.dataset.column, head: node.getBoundingClientRect().x, cell: cell.getBoundingClientRect().x, width: node.getBoundingClientRect().width, cellWidth: cell.getBoundingClientRect().width }; }),
            spans: [...document.querySelectorAll('#log-table-body [colspan]')].map(node => node.colSpan), scrollable: document.querySelector('#log-list').scrollWidth > document.querySelector('#log-list').clientWidth };
    });
    for (const column of data.columns) { expect(Math.abs(column.head - column.cell)).toBeLessThan(1); expect(Math.abs(column.width - column.cellWidth)).toBeLessThan(1); }
    expect(data.spans.every(span => span === data.columns.length)).toBe(true);
    return data;
}
for (const order of ['timeline', 'flow']) for (const tail of ['top', 'bottom']) test(`columns preserve ${order} ${tail}`, async ({ page, context }, info) => {
    await page.request.post('/fixture/reset'); await page.request.post('/fixture/columns');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const requests = [], errors = [], bytes = [];
    page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => { if (/\/api\/unified-logs\?/.test(response.url())) { const body = await response.json().catch(() => null); if (body) bytes.push({ bytes: body.bytesRead, rows: body.entries?.length }); } });
    await page.addInitScript(({ order, tail }) => { localStorage.setItem('unifiedLogOrderMode', order); localStorage.setItem('unifiedLogTailPosition', tail); }, { order, tail });
    await page.goto('/logs-view?diagnostics=true&level=INFO');
    await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(100); await close(page, info);
    const id = await page.evaluate(() => currentLogs.find(log => log.message === 'Columns exact ID fixture').id);
    await activate(page.locator(`[data-log-id="${id}"]`), info); await expect(page.locator('#record-explorer-host')).toBeVisible();
    const full = await page.evaluate(() => ({ correlationId: getCorrelationId(selectedResult.entry), flowId: getFlowId(selectedResult.entry), traceId: getTraceId(selectedResult.entry) }));
    const selected = await page.evaluate(() => selectedId), detailsBefore = requests.filter(url => url.includes('/detail?')).length;
    await page.evaluate(() => { holdReading(); document.querySelector('#log-list').scrollTop = 650; });
    const held = await page.evaluate(() => ({ anchor: captureAnchor(), follow: followingLatest, url: location.href, json: JSON.stringify(selectedResult.entry) }));
    await columns(page, info);
    for (const field of ['flowId', 'traceId']) await page.locator(`[data-column-toggle="${field}"]`).check();
    for (const field of ['time', 'component', 'kind', 'level', 'class']) await page.locator(`[data-column-toggle="${field}"]`).uncheck();
    await expect(page.locator('[data-column-toggle="message"]')).toBeDisabled();
    await close(page, info);
    const after = await page.evaluate(() => ({ anchor: captureAnchor(), follow: followingLatest, url: location.href, json: JSON.stringify(selectedResult.entry) }));
    expect(after.anchor.id).toBe(held.anchor.id); expect(Math.abs(after.anchor.offset - held.anchor.offset)).toBeLessThanOrEqual(2);
    expect(after.follow).toBe(held.follow); expect(after.url).toBe(held.url); expect(after.json).toBe(held.json);
    const layout = await alignment(page); expect(layout.columns.map(column => column.id)).toEqual(['correlationId', 'flowId', 'traceId', 'message']);
    // Opening/copying each ID preserves selected evidence, and reads the real native clipboard.
    for (const field of ['correlationId', 'flowId', 'traceId']) {
        const button = page.locator(`[data-log-id="${id}"] [data-id-field="${field}"]`);
        await activate(button, info); await expect(page.locator('#column-id-value')).toHaveValue(full[field]);
        await activate(page.getByRole('button', { name: 'Copy complete ID', exact: true }), info);
        await expect(page.locator('#column-id-status')).toContainText('Complete ID copied');
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(full[field]);
        await page.locator('#column-id-value').press('Escape'); await expect(page.locator('#column-id-dialog')).not.toBeVisible(); await expect(button).toBeFocused();
        expect(await page.evaluate(() => selectedId)).toBe(selected);
    }
    const legacy = page.locator('.log-row').filter({ has: page.locator('[data-id-field="correlationId"]') }); expect(await legacy.count()).toBeGreaterThan(1);
    const missing = page.locator('.log-row [data-column="flowId"] [aria-label="Not recorded"]'); expect(await missing.count()).toBeGreaterThan(0);
    // Test authored help on live configuration, dynamic ID button and the required disabled checkbox.
    await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await columns(page, info);
    const help = page.locator('[data-column-toggle="traceId"]'); if (info.project.name.endsWith('mobile')) await help.tap(); else await help.focus();
    await expect(page.getByRole('tooltip')).toContainText('display only');
    if (await page.getByRole('button', { name: 'Dismiss explanation' }).isVisible()) await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await page.getByRole('button', { name: 'Explain Message is required', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('identify and select');
    if (await page.getByRole('button', { name: 'Dismiss explanation' }).isVisible()) await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await close(page, info);
    await page.locator(`[data-log-id="${id}"] [data-id-field="flowId"]`).focus();
    await expect(page.getByRole('tooltip')).toContainText('complete recorded value');
    if (await page.getByRole('button', { name: 'Dismiss explanation' }).isVisible()) await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await activate(page.locator(`[data-log-id="${id}"] [data-id-field="flowId"]`), info);
    await page.getByRole('button', { name: 'Copy complete ID', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('entire recorded ID');
    expect(await page.getByRole('tooltip').evaluate(node => node.closest('dialog')?.open)).toBe(true);
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await activate(page.getByRole('button', { name: 'Close ID', exact: true }), info);
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    // An open ID dialog must retain its originating keyed row/button on refresh.
    const originButton = page.locator(`[data-log-id="${id}"] [data-id-field="flowId"]`);
    await activate(originButton, info); const originalButton = await originButton.elementHandle();
    await page.request.post('/fixture/append'); await page.evaluate(() => refreshLogs(true));
    expect(await originalButton.evaluate(node => node.isConnected)).toBe(true);
    await activate(page.getByRole('button', { name: 'Close ID', exact: true }), info); await expect(originButton).toBeFocused();
    // Preserve the chosen layout through exact inspection/Return and a held live append.
    await page.evaluate(() => { document.querySelector('#log-list').scrollTop = 650; holdReading(); });
    const settings = await page.evaluate(() => JSON.stringify(visibleColumns));
    await activate(page.locator('[data-inspect-field="flowId"]'), info); await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await columns(page, info); await page.locator('[data-column-toggle="class"]').check(); await close(page, info);
    const inspectionSettings = await page.evaluate(() => JSON.stringify(visibleColumns));
    await activate(page.locator('#return-to-results'), info); expect(await page.evaluate(() => JSON.stringify(visibleColumns))).toBe(inspectionSettings);
    expect(await page.evaluate(() => selectedId)).toBe(selected); expect(await page.evaluate(() => followingLatest)).toBe(false);
    const anchor = await page.evaluate(() => captureAnchor());
    await page.request.post('/fixture/append'); await page.evaluate(() => refreshLogs());
    expect(await page.evaluate(() => captureAnchor().id)).toBe(anchor.id); expect(await page.evaluate(() => selectedId)).toBe(selected);
    expect(requests.filter(url => url.includes('/detail?')).length).toBe(detailsBefore);
    await alignment(page);
    await page.reload(); await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(100); await close(page, info);
    expect(await page.evaluate(() => JSON.stringify(visibleColumns))).toBe(inspectionSettings);
    await columns(page, info); await activate(page.getByRole('button', { name: 'Reset to defaults', exact: true }), info); await close(page, info);
    expect((await alignment(page)).columns.map(column => column.id)).toEqual(['time', 'component', 'correlationId', 'kind', 'level', 'class', 'message']);
    await page.evaluate(() => followLatest()); await expect.poll(() => page.evaluate(() => followingLatest)).toBe(true);
    await columns(page, info); await page.locator('[data-column-toggle="flowId"]').check(); await close(page, info);
    expect(await page.evaluate(() => followingLatest)).toBe(true);
    // Real rendered spacer/group spanning after the layout changes.
    await page.evaluate(() => { selectedId = currentLogs[0].id; toggleSelectedSpacer('before'); }); await alignment(page);
    expect(await page.locator('.log-row').count()).toBeLessThanOrEqual(600);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.every(result => result.bytes <= 1048576 && result.rows <= 200)).toBe(true); expect(errors).toEqual([]);
    const axe = await new AxeBuilder({ page }).include('#log-list').analyze(); expect(axe.violations.filter(item => ['serious', 'critical'].includes(item.impact))).toEqual([]);
    fs.writeFileSync(info.outputPath('checks.json'), JSON.stringify({ order, tail, project: info.project.name, full, readingAnchor: { before: held.anchor, after: after.anchor }, settingsChangedDuringInspection: inspectionSettings, columns: layout.columns, detailRequests: detailsBefore, bounds: bytes, finalRows: await page.locator('.log-row').count(), errors, axe: axe.violations }, null, 2));
});

test('denied storage and complete ID manual copy are usable', async ({ page, context }, info) => {
    await page.request.post('/fixture/reset'); await page.request.post('/fixture/columns');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Denied', 'SecurityError'); } }); });
    await page.route('**/logs-view**', async route => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'permissions-policy': 'clipboard-write=()' } }); });
    await page.goto('/logs-view?diagnostics=true'); await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(100);
    await columns(page, info); await page.locator('[data-column-toggle="flowId"]').check(); await expect(page.locator('#column-status')).toContainText('Storage unavailable'); await close(page, info);
    const id = await page.evaluate(() => currentLogs.find(log => log.message === 'Columns exact ID fixture').id);
    await activate(page.locator(`[data-log-id="${id}"] [data-id-field="flowId"]`), info);
    const full = await page.locator('#column-id-value').inputValue();
    // Actual policy rejection still allows the compatible copy inside the modal.
    await activate(page.getByRole('button', { name: 'Copy complete ID', exact: true }), info);
    await expect(page.locator('#column-id-status')).toContainText('Complete ID copied');
    const compatibleReader = await context.newPage(); await compatibleReader.goto('/healthz');
    expect(await compatibleReader.evaluate(() => navigator.clipboard.readText())).toBe(full); await compatibleReader.close(); await page.bringToFront();
    // Inject only legacy rejection to exercise the last manual fallback.
    await page.evaluate(() => { document.execCommand = () => false; });
    await activate(page.getByRole('button', { name: 'Copy complete ID', exact: true }), info); await expect(page.locator('#column-id-status')).toContainText('Automatic copy was blocked');
    await activate(page.locator('#column-id-select'), info); await page.keyboard.press('Control+c');
    const reader = await context.newPage(); await reader.goto('/healthz'); expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(full); await reader.close();
    await activate(page.getByRole('button', { name: 'Close ID', exact: true }), info);
    await page.reload(); await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(100); expect(await page.evaluate(() => visibleColumns.flowId)).toBe(false);
});
