'use strict';
/** Real selected-detail UI over emitted fixtures, keyboard and native touch. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
/** Exercise native interaction paths across both projects. */
async function activate(locator, info) { if (info.project.name.endsWith('mobile')) await locator.tap(); else { await locator.focus(); await locator.press('Enter'); } }
/** Search only selected detail and wait for the synchronous bounded result. */
async function search(page, text, info) {
    await page.getByRole('searchbox', { name: 'Search field names or values' }).fill(text);
    await activate(page.getByRole('button', { name: 'Search fields', exact: true }), info);
}

/** Focused regression for visible action results and the frontend-only type column. */
test('Explore and Read reveal their results and event icons distinguish known types', async ({ page }, info) => {
    await page.request.post('/fixture/reset');
    await page.goto('/logs-view?diagnostics=true');
    await expect(page.locator('.log-row')).toHaveCount(7);
    if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
    for (const [message, label] of [['Malformed assertion fixture', 'Request'], ['Recorded HTTP fixture', 'Response'],
        ['Opaque issuance fixture', 'Processing'], ['Unknown field fixture', 'Other/unknown']]) {
        const id = await page.evaluate(message => currentLogs.find(log => log.message === message).id, message);
        const row = page.locator(`[data-log-id="${id}"]`);
        await expect(row.locator('[data-column="kind"]')).toHaveAttribute('title', label);
        await expect(row.getByRole('img', { name: label, exact: true })).toBeVisible();
    }
    const id = await page.evaluate(() => currentLogs.find(log => log.message === 'Recorded HTTP fixture').id);
    await activate(page.locator(`[data-log-id="${id}"]`), info);
    await activate(page.locator('#tab-structured'), info);
    const host = page.locator('#record-explorer-host');
    await expect(host.getByRole('button', { name: 'Explore method', exact: true })).toHaveCount(0);
    await activate(host.getByRole('button', { name: 'Read method', exact: true }), info);
    const value = page.getByLabel('Complete chosen field value', { exact: true });
    await expect(value).toHaveText('POST'); await expect(value).toBeFocused(); await expect(value).toBeInViewport();
    await activate(host.getByRole('button', { name: 'Read body', exact: true }), info);
    const body = await page.evaluate(() => selectedResult.entry.details.body);
    await expect(value).toHaveText(JSON.stringify(body)); await expect(value).toBeFocused(); await expect(value).toBeInViewport();
    await activate(host.getByRole('button', { name: 'Explore body', exact: true }), info);
    const root = host.getByText('Exploring $["details"]["body"]', { exact: true });
    await expect(root).toBeFocused(); await expect(root).toBeInViewport();
    await activate(host.locator('.explorer-tree summary').first(), info);
    await expect(host.locator('.explorer-children')).toContainText('access_token');
    // Rebuilding saved detail must not steal focus or move its restored scroll position.
    const before = await page.evaluate(() => {
        const state = selectedExplorer.state();
        const panel = document.getElementById('details-pane'), top = panel.scrollTop;
        selectedExplorer = PCM_LOG_RECORD.mount(document.getElementById('record-explorer-host'), selectedResult.entry, { state });
        return { top, after: panel.scrollTop };
    });
    // The old focused tree is replaced; restoration must leave focus outside the new explorer.
    expect(await host.locator(':focus').count()).toBe(0);
    expect(before.after).toBe(before.top);
});

for (const order of ['timeline', 'flow']) test(`structured fields and specialized evidence ${order}`, async ({ page }, info) => {
    await page.request.post('/fixture/reset');
    const traffic = [], errors = [];
    page.on('request', request => { if (request.url().includes('/api/')) traffic.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(order => {
        localStorage.setItem('unifiedLogOrderMode', order); localStorage.setItem('unifiedLogTailPosition', 'top');
        // Verify submitted payloads at the shared boundary; native clipboard repair
        // and browser permission/fallback plumbing belong to LOGS-COPY-01.
        window.copiedValues = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedValues.push(text); } } });
    }, order);
    await page.goto('/logs-view?diagnostics=true'); await expect(page.locator('.log-row')).toHaveCount(7);
    if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
    const opaqueId = await page.evaluate(() => currentLogs.find(row => row.message === 'Opaque issuance fixture').id);
    await activate(page.locator(`[data-log-id="${opaqueId}"]`), info);
    await activate(page.locator('#tab-structured'), info);
    await expect(page.locator('#record-explorer-host')).toContainText('Issuance-time server record');
    const normalized = await page.evaluate(() => selectedResult.entry), raw = await page.evaluate(() => selectedResult.raw);
    await page.locator('#record-explorer-host').getByText(/^Exact opaque token/).click();
    await expect(page.locator('#record-explorer-host')).toContainText(normalized.details.access_token);
    await expect(page.locator('#record-explorer-host')).not.toContainText('Decoded recorded JWT');
    await activate(page.locator('#copy-detail'), info);
    expect(await page.evaluate(() => window.copiedValues.at(-1))).toBe(JSON.stringify(normalized, null, 2));
    await search(page, 'long', info);
    const longMatch = page.locator('.field-match').filter({ hasText: '$["details"]["issuanceRecord"]["long"]' });
    await activate(longMatch.getByRole('button', { name: 'Read match', exact: true }), info);
    expect(await page.locator('.explorer-value').textContent()).toBe(normalized.details.issuanceRecord.long);
    await activate(longMatch.getByRole('button', { name: 'Copy match value' }), info);
    expect(await page.evaluate(() => window.copiedValues.at(-1))).toBe(normalized.details.issuanceRecord.long);
    expect(await page.evaluate(() => window.UNTRUSTED)).toBeUndefined();
    await search(page, 'deep value target', info);
    await activate(page.locator('.field-match').filter({ hasText: '$["details"]["issuanceRecord"]["deep"]' }).getByRole('button', { name: 'Explore match' }), info);
    await expect(page.locator('.explorer-tree')).toContainText('deep value target');
    await expect(page.locator('.explorer-row')).toHaveCount(1);
    await search(page, 'deep', info);
    await activate(page.locator('.field-match').filter({ hasText: '$["details"]["issuanceRecord"]["deep"]' }).first().getByRole('button', { name: 'Explore match' }), info);
    for (let index = 0; index < 13; index++) await activate(page.locator('.explorer-tree summary').nth(index), info);
    await expect(page.getByRole('button', { name: 'Continue at this object' })).toBeVisible();
    await activate(page.getByRole('button', { name: 'Continue at this object' }), info);
    await expect(page.locator('.explorer-row')).toHaveCount(1);
    // Actual retained investigation/Return must rebuild working event listeners,
    // retain selected evidence and restore the chosen subtree/search batch.
    const beforePath = await page.locator('.explorer-row').getAttribute('data-field-path');
    await activate(page.locator('[data-inspect-field="flowId"]'), info);
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await activate(page.locator('#return-to-results'), info);
    expect(await page.locator('.explorer-row').getAttribute('data-field-path')).toBe(beforePath);
    await activate(page.locator('.explorer-tree').getByRole('button', { name: 'Copy value', exact: true }), info);
    expect(await page.evaluate(() => copiedValues.at(-1))).toContain('deep value target');
    await activate(page.locator('#tab-raw'), info); expect(await page.locator('.raw-source-text').textContent()).toBe(raw);
    await activate(page.locator('#copy-detail'), info); expect(await page.evaluate(() => copiedValues.at(-1))).toBe(raw);
    await page.locator('#tab-raw').press('ArrowLeft');
    await activate(page.locator('#tab-json'), info);
    expect(JSON.parse(await page.getByLabel('Complete normalized JSON', { exact: true }).textContent())).toEqual(normalized);
    await activate(page.locator('#tab-structured'), info);
    const before = traffic.filter(url => url.includes('/detail?')).length;
    await page.request.post('/fixture/append'); await page.evaluate(() => refreshLogs());
    expect(await page.evaluate(() => selectedResult.raw)).toBe(raw);
    expect(traffic.filter(url => url.includes('/detail?')).length).toBe(before);
    await activate(page.locator('#close-event-detail'), info); await activate(page.locator('#toggle-event-detail'), info);
    expect(await page.evaluate(() => selectedResult.raw)).toBe(raw);
    // Authored popup help is verified on dynamic and initial controls.
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const target = page.locator('[data-help-key="logs.field-search"]').first();
    if (info.project.name.endsWith('mobile')) await target.tap(); else await target.focus();
    await expect(page.getByRole('tooltip')).toContainText('12,000 fields');
    const dismiss = page.getByRole('button', { name: 'Dismiss explanation' }); if (await dismiss.isVisible()) await dismiss.click();
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    // Generic unknown schema: arbitrary keys and empty values survive search/copy.
    const unknownId = await page.evaluate(() => currentLogs.find(row => row.message === 'Unknown field fixture').id);
    await activate(page.locator(`[data-log-id="${unknownId}"]`), info);
    await expect(page.locator('#record-explorer-host')).toContainText('No specialized view');
    await search(page, 'last search target', info);
    await expect(page.locator('.explorer-results')).toBeEmpty(); await expect(page.getByRole('button', { name: 'Search next batch' })).toBeVisible();
    await activate(page.getByRole('button', { name: 'Search next batch' }), info);
    await expect(page.locator('.field-match').filter({ hasText: '$["details"]["wide"]["15999"]' })).toHaveCount(1);
    await search(page, 'a.b', info);
    await activate(page.locator('.field-match').filter({ hasText: '$["details"][""]["a.b"]' }).getByRole('button', { name: 'Explore match' }), info);
    await activate(page.locator('.explorer-tree summary'), info); await expect(page.locator('.explorer-row')).toHaveCount(7);
    const childRows = page.locator('.explorer-children > .explorer-row');
    for (const [index, value] of ['null', 'false', '0', '', '{}', '[]'].entries()) {
        await activate(childRows.nth(index).getByRole('button', { name: 'Copy value', exact: true }).first(), info);
        expect(await page.evaluate(() => copiedValues.at(-1))).toBe(value);
    }
    await activate(page.getByRole('button', { name: 'Reset field tree' }), info);
    await search(page, 'wide', info); await activate(page.locator('.field-match').first().getByRole('button', { name: 'Explore match' }), info);
    await activate(page.locator('.explorer-tree summary').first(), info);
    for (let index = 0; index < 12; index++) await activate(page.getByRole('button', { name: 'More fields', exact: true }), info);
    expect(await page.locator('.explorer-row').count()).toBeLessThanOrEqual(400);
    expect(await page.locator('#record-explorer-host *').count()).toBeLessThan(6500);
    await activate(page.locator('.explorer-tree summary').first(), info); await expect(page.locator('.explorer-row')).toHaveCount(1);
    // Recorded HTTP/JWT, malformed fallback, legacy missing snapshot and decision.
    for (const [message, phrase] of [['Recorded HTTP fixture', 'HTTP exchange'], ['Malformed assertion fixture', 'No decodable JWT'], ['Legacy token fixture', 'Unavailable (not recorded)'], ['Recorded denial fixture', 'Recorded authorization decision']]) {
        const id = await page.evaluate(message => currentLogs.find(row => row.message === message).id, message);
        await activate(page.locator(`[data-log-id="${id}"]`), info); await expect(page.locator('#record-explorer-host')).toContainText(phrase);
        if (message === 'Recorded HTTP fixture') { await page.getByText(/^Recorded token \/ assertion/).click(); await expect(page.locator('#record-explorer-host')).toContainText('Decoding does not establish signature validity'); }
    }
    const storage = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
    expect(JSON.stringify(storage)).not.toContain(normalized.details.access_token); expect(JSON.stringify(storage)).not.toContain('long synthetic');
    expect(await page.evaluate(() => window.UNTRUSTED)).toBeUndefined(); expect(errors).toEqual([]);
    expect(traffic.filter(url => /\/token(?:\?|$)|introspect/.test(url))).toEqual([]);
    const accessibility = await new AxeBuilder({ page }).include('#record-explorer-host').analyze(); expect(accessibility.violations).toEqual([]);
    const box = await page.locator('#record-explorer-host').boundingBox(); expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    const metrics = await page.evaluate(() => ({ rows: currentLogs.length, timings: window.logRenderTimings, bytesRead: currentResult.bytesRead, lineLimit: currentResult.maxLineBytes }));
    expect(metrics.rows).toBeLessThanOrEqual(600); expect(metrics.bytesRead).toBeLessThanOrEqual(1048576);
    fs.writeFileSync(info.outputPath('checks.json'), JSON.stringify({ order, project: info.project.name, normalizedBytes: JSON.stringify(normalized).length, metrics, detailRequests: traffic.filter(url => url.includes('/detail?')).length }, null, 2));
    await page.screenshot({ path: info.outputPath('structured.png'), fullPage: true });
    const heldRaw = await page.evaluate(() => selectedResult.raw), reference = await page.evaluate(() => selectedRecord.reference);
    await page.request.post('/fixture/rotate');
    expect((await page.request.get('/api/unified-logs/detail?reference=' + encodeURIComponent(reference))).status()).toBe(409);
    expect(await page.evaluate(() => selectedResult.raw)).toBe(heldRaw);
    page.once('dialog', dialog => dialog.accept()); await page.evaluate(() => clearLogs());
    expect(await page.evaluate(() => selectedResult)).toBeNull(); await expect(page.locator('#record-explorer-host')).toHaveCount(0);
    await expect(page.locator('#copy-detail')).toBeDisabled();
});
