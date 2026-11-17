'use strict';
/** Disposable real API/view search checks, including native touch, help and accessibility. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { TRACE, RARE } = require('../../../test-support/log-search-corpus');

/** Open the ordinary Filters workbench on either viewport. */
async function filters(page) {
    const dismiss = page.getByRole('button', { name: 'Dismiss explanation' });
    if (await dismiss.isVisible()) await dismiss.click();
    if (!await page.locator('#filter-traceId').isVisible()) await page.locator('[data-open-panel="filters"]').click();
}
/** Start through the real control; the fixture never intercepts the product API. */
async function search(page, testInfo) {
    if (testInfo.project.name === 'chromium-mobile') await page.locator('#search-start').tap();
    else await page.locator('#search-start').click();
    await expect(page.locator('#search-progress')).not.toHaveText('Starting retained search…');
    await expect.poll(() => page.evaluate(() => searchSession?.state)).not.toBe('running');
}

for (const order of ['timeline', 'flow']) for (const diagnostics of [false, true]) {
    test(`retained exact/text/combined search and held browse return ${order}, diagnostics ${diagnostics}`, async ({ page, request }, testInfo) => {
        const manifest = await (await request.get('/fixture/manifest')).json();
        await page.addInitScript(order => {
            localStorage.setItem('unifiedLogOrderMode', order);
            const interval = window.setInterval.bind(window);
            window.setInterval = (fn, ms, ...args) => ms === 3000 ? 0 : interval(fn, ms, ...args);
        }, order);
        await page.goto(`/logs-view?role=pcm&diagnostics=${diagnostics}`);
        await expect(page.locator('.log-row').first()).toBeVisible();
        if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
        const first = page.locator('.log-row').first(); const savedId = await first.getAttribute('data-log-id');
        await first.click(); await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
        const savedRaw = await page.evaluate(() => selectedResult.raw);
        await filters(page);
        await page.locator('#filter-role').selectOption('');
        await page.locator('#filter-traceId').fill(TRACE);
        await page.locator('#search-text').fill('RARE LITERAL [x]');
        await page.locator('#search-source').fill(manifest.lateSource);
        await page.locator('#search-since').fill('2026-11-04T10:00:00Z');
        await page.locator('#search-until').fill('2026-11-04T10:00:03Z');
        await search(page, testInfo);
        await expect(page.locator('.log-row')).toHaveCount(4);
        await expect(page.locator('#search-progress')).toContainText('4 matches');
        await expect(page.locator('#filter-summary')).toContainText('Source: ' + manifest.lateSource);
        await expect(page.locator('#filter-full')).not.toContainText('Role: pcm');
        await expect(page.locator('#search-page')).toContainText('appends excluded');
        const ids = await page.locator('.log-row').evaluateAll(rows => rows.map(row => row.dataset.logId));
        expect(new Set(ids).size).toBe(4);
        await page.locator('.log-row').first().click();
        await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toContainText('non-AWS-synthetic');
        await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).not.toContainText('FAKE_CORPUS_AWS_SECRET');
        const before = await page.locator('#log-list').evaluate(node => node.scrollTop);
        await page.waitForTimeout(200); await page.evaluate(() => refreshLogs());
        expect(await page.locator('#log-list').evaluate(node => node.scrollTop)).toBe(before);
        await expect(page.locator('.log-row')).toHaveCount(4);
        // Help on initial fields, dynamic progress and disabled page/cancel actions.
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('#search-progress').focus();
        await expect(page.getByRole('tooltip')).toContainText('Zero matches while searching');
        await page.getByRole('button', { name: 'Explain Cancel search', exact: true }).focus();
        await expect(page.getByRole('tooltip')).toContainText('button becomes unavailable');
        await page.getByRole('button', { name: 'Explain Search result pages', exact: true }).first().focus();
        await expect(page.getByRole('tooltip')).toContainText('200 matching summaries');
        await filters(page);
        for (const [id, phrase] of [['search-text', 'never interprets regex'], ['search-source', 'filesystem path'],
            ['search-since', 'inclusive'], ['search-start', 'five rotations']]) {
            await page.locator('#' + id).focus(); await expect(page.getByRole('tooltip')).toContainText(phrase);
        }
        if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Dismiss explanation' }).tap();
        else await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        await page.locator('#close-workbench').click();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        const accessibility = await new AxeBuilder({ page }).include('#search-banner').analyze();
        expect(accessibility.violations).toEqual([]);
        await page.getByRole('button', { name: 'Return to browsing' }).click();
        if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
        await expect(page.locator('#search-banner')).toBeHidden();
        await expect(page.locator('.log-row.selected')).toHaveAttribute('data-log-id', savedId);
        expect(await page.evaluate(() => selectedResult.raw)).toBe(savedRaw);
        // A genuinely complete empty source-narrowed search differs from an in-progress empty page.
        await filters(page); await page.locator('#filter-role').selectOption('');
        await page.locator('#filter-traceId').fill('absent-exact-id');
        await page.locator('#search-text').fill(''); await page.locator('#search-source').fill(manifest.earlySource);
        await page.locator('#search-since').fill(''); await page.locator('#search-until').fill('');
        await search(page, testInfo);
        await expect(page.locator('#search-progress')).toContainText('Search complete within captured files · 0 matches');
        await expect(page.locator('#log-table-body')).toContainText('No matches within the captured retained files');
        // Literal-only search returns the four default-visible payload matches.
        await filters(page); await page.locator('#filter-traceId').fill('');
        await page.locator('#search-source').fill(manifest.lateSource); await page.locator('#search-text').fill(RARE);
        await search(page, testInfo); await expect(page.locator('.log-row')).toHaveCount(4);
        const bounds = await page.locator('#search-banner').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
        if (order === 'timeline' && !diagnostics) await page.screenshot({ path: testInfo.outputPath('retained-search.png'), fullPage: true });
    });
}

test('result-page navigation, literal syntax, input errors and retry are accessible', async ({ page, request }, testInfo) => {
    const manifest = await (await request.get('/fixture/manifest')).json();
    await page.goto('/logs-view'); await expect(page.locator('.log-row').first()).toBeVisible();
    await filters(page); await page.locator('#search-text').fill('Observation');
    await search(page, testInfo);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await expect(page.locator('#search-progress')).toContainText('1,000 result limit');
    const first = await page.locator('.log-row').evaluateAll(rows => rows.map(row => row.dataset.logId));
    await page.locator('#search-next').click(); await expect(page.locator('#search-page')).toContainText('Result page 2');
    const second = await page.locator('.log-row').evaluateAll(rows => rows.map(row => row.dataset.logId));
    expect(second.some(id => first.includes(id))).toBe(false);
    await page.locator('#search-previous').click(); await expect(page.locator('#search-page')).toContainText('Result page 1');
    expect(await page.locator('.log-row').evaluateAll(rows => rows.map(row => row.dataset.logId))).toEqual(first);
    await filters(page); await page.locator('#search-text').fill('[.*]'); await page.locator('#search-source').fill(manifest.earlySource);
    await search(page, testInfo); await expect(page.locator('#search-progress')).toContainText('0 matches');
    await filters(page); await page.locator('#search-since').fill('yesterday');
    await search(page, testInfo); await expect(page.locator('#search-progress')).toContainText('must be an ISO UTC time');
    await filters(page); await page.locator('#search-since').fill(''); await page.locator('#search-text').fill('Synthetic early match');
    await search(page, testInfo); await expect(page.locator('.log-row')).toHaveCount(1);
});

test('cancel before admission response still cancels the actual server job', async ({ page, request }, testInfo) => {
    const manifest = await (await request.get('/fixture/manifest')).json();
    await page.goto('/logs-view'); await expect(page.locator('.log-row').first()).toBeVisible();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let admittedId;
    await page.route('**/api/unified-logs/search', async route => {
        const response = await route.fetch(); admittedId = (await response.json()).id;
        await held; await route.fulfill({ response });
    });
    await filters(page); await page.locator('#search-source').fill(manifest.earlySource);
    await page.locator('#search-text').fill('absent admission race');
    if (testInfo.project.name === 'chromium-mobile') await page.locator('#search-start').tap();
    else await page.locator('#search-start').click();
    await expect.poll(() => admittedId).toBeTruthy();
    await page.locator('#search-cancel').click();
    await expect(page.locator('#search-progress')).toContainText('Cancellation requested');
    const cancelled = page.waitForRequest(request => request.method() === 'DELETE' && request.url().includes('/api/unified-logs/search/'));
    release();
    expect((await cancelled).url()).toContain(admittedId);
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toMatch(/^(complete|cancelled)$/);
    expect((await (await request.get('/api/unified-logs/search/' + admittedId)).json()).state).not.toBe('running');
});
