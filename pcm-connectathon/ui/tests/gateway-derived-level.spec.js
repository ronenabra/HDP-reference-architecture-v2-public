'use strict';

/** Real HTTP browse/detail/filter/live projections; no intercepted API responses. */
const { test, expect } = require('@playwright/test');
const { gatewayRaw } = require('../../../test-support/gateway-log-fixture');

/** Close the mobile filter drawer before interacting with the table or detail.
 * @param {import('@playwright/test').Page} page Owned fixture page.
 * @returns {Promise<void>} Resolves after the drawer is closed when present.
 */
async function closeSidebar(page) {
    const dismiss = page.getByRole('button', { name: 'Dismiss explanation' });
    if (await dismiss.isVisible()) await dismiss.click();
    const close = page.locator('#close-workbench');
    if (await close.isVisible()) await close.click();
}

for (const order of ['timeline', 'flow']) for (const diagnostics of ['false', 'true']) {
    test(`gateway INFO arrivals and actual response severity in ${order}, diagnostics ${diagnostics}`, async ({ page, request }, testInfo) => {
        expect((await request.post('/fixture/reset')).ok()).toBe(true);
        await page.addInitScript(order => {
            localStorage.setItem('unifiedLogOrderMode', order);
            localStorage.setItem('unifiedLogTailPosition', 'top');
            // Retain real polling/catch-up functions with deterministic invocation.
            const schedule = window.setInterval.bind(window);
            window.setInterval = (callback, milliseconds, ...args) => milliseconds === 3000 ? 0 : schedule(callback, milliseconds, ...args);
        }, order);
        await page.goto(`/logs-view?role=gateway&healthOrganizationId=ho-b&diagnostics=${diagnostics}`);
        await expect(page.locator('.log-row')).toHaveCount(diagnostics === 'true' ? 14 : 13);
        await closeSidebar(page);
        const arrivals = page.locator('.log-row').filter({ hasText: 'Gateway Request:' });
        await expect(arrivals).toHaveCount(6);
        expect(await arrivals.evaluateAll(rows => rows.map(row => row.dataset.level))).toEqual(Array(6).fill('INFO'));
        if (order === 'flow') await expect(page.locator('.flow-group').first()).toBeVisible();
        for (const index of [1, 2, 4, 5]) {
            const correlation = `gateway-request-${index}`;
            const pair = page.locator(`.log-row[data-correlation-id="${correlation}"]`);
            const arrival = pair.filter({ hasText: 'Gateway Request:' });
            const response = pair.filter({ hasText: 'Gateway Response:' });
            await expect(arrival).toHaveAttribute('data-level', 'INFO');
            await expect(response).toHaveAttribute('data-level', index % 3 === 1 ? 'WARN' : 'ERROR');
            if (testInfo.project.name === 'chromium-mobile') await arrival.tap();
            else await arrival.click();
            const structured = page.locator('#panel-json pre[data-help-key="logs.payload"]');
            await expect(structured).toBeVisible();
            const detail = JSON.parse(await structured.textContent());
            expect(detail.level).toBe('INFO'); expect(detail.details.type).toBe('GATEWAY_REQUEST');
            expect(detail.details.status).toBeUndefined();
            await expect(page.locator('#event-metadata')).toContainText('derived');
            await page.locator('#tab-raw').click();
            await expect(page.locator('#panel-raw')).toContainText('source text belongs to the gateway response record');
            expect(await page.locator('.raw-source-text').textContent()).toBe(gatewayRaw(index));
            await page.locator('#tab-json').click();
        }
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('th[data-help-key="logs.level"]').focus();
        await expect(page.getByRole('tooltip')).toContainText('Derived gateway requests use INFO');
        await arrivals.first().locator('[data-help-key="logs.level-info"]').focus();
        await expect(page.getByRole('tooltip')).toContainText('Derived gateway requests use INFO');
        await page.locator('#tab-raw').focus();
        await expect(page.getByRole('tooltip')).toContainText('source response record');
        await page.locator('[data-open-panel="filters"]').click();
        await page.locator('#filter-level').focus();
        await expect(page.getByRole('tooltip')).toContainText('displayed event severity');
        await closeSidebar(page);
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        for (const level of ['INFO', 'WARN', 'ERROR']) {
            await page.locator('[data-open-panel="filters"]').click();
            await page.locator('#filter-level').selectOption(level);
            await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
            await closeSidebar(page);
            await expect(page.locator('.log-row')).toHaveCount(level === 'INFO' ? 8 : level === 'ERROR' ? (diagnostics === 'true' ? 4 : 3) : 2);
            expect(await page.locator('.log-row').evaluateAll((rows, expected) => rows.every(row => row.dataset.level === expected), level)).toBe(true);
            await expect(arrivals).toHaveCount(level === 'INFO' ? 6 : 0);
        }
        await page.locator('[data-open-panel="filters"]').click();
        await page.locator('#filter-level').selectOption('INFO');
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await closeSidebar(page);
        await expect(arrivals).toHaveCount(6);
        expect((await request.post('/fixture/append')).ok()).toBe(true);
        await page.locator('#follow-latest').click();
        await expect(arrivals).toHaveCount(12);
        expect(await arrivals.evaluateAll(rows => rows.every(row => row.dataset.level === 'INFO'))).toBe(true);
        await testInfo.attach('source-bound-gateway-projections', { body: JSON.stringify({ order, diagnostics,
            viewport: page.viewportSize(), arrivals: await arrivals.count(), nativeAPI: true, rawDOM: 'Exact source text including CR/tab/space; API raw also verified exact' }), contentType: 'application/json' });
        await page.screenshot({ path: testInfo.outputPath('gateway-info-arrivals.png'), fullPage: true });
    });
}


for (const order of ['timeline', 'flow']) test(`current API emitted and derived provenance help ${order}`, async ({ page, request }, info) => {
    await page.addInitScript(order => localStorage.setItem('unifiedLogOrderMode', order), order);
    for (const kind of ['emitted', 'derived']) {
        expect((await request.post(kind === 'emitted' ? '/fixture/native-arrivals' : '/fixture/reset')).ok()).toBe(true);
        await page.goto('/logs-view?role=gateway&healthOrganizationId=ho-b&diagnostics=false');
        await expect(page.locator('.log-row').first()).toBeVisible(); await closeSidebar(page);
        const id = await page.evaluate(kind => currentLogs.find(row => row.details.type === 'GATEWAY_REQUEST' && row.event.provenance.kind === kind).id, kind);
        const row = page.locator(`[data-log-id="${id}"]`);
        if (info.project.use.hasTouch) await row.tap(); else await row.click();
        await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
        const detail = await page.evaluate(() => selectedResult);
        expect(detail.entry.event.provenance.kind).toBe(kind);
        expect(detail.entry.level).toBe('INFO');
        await expect(page.locator('#event-metadata dt').filter({ hasText: /^Span ID$/ }).locator('+ dd')).toHaveText('Not recorded');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        for (const tab of ['structured', 'raw']) {
            const dismiss = page.getByRole('button', { name: 'Dismiss explanation' }); if (await dismiss.isVisible()) await dismiss.click();
            await page.locator('#tab-' + tab).click();
            await page.locator('#event-metadata [data-help-key="logs.provenance"]').focus();
            await expect(page.getByRole('tooltip')).toContainText('Emitted means a recorded source event');
            await page.locator('#event-metadata [data-help-key="logs.span-id"]').focus();
            await expect(page.getByRole('tooltip')).toContainText('Missing spans');
        }
        expect(await page.locator('.raw-source-text').textContent()).toBe(detail.raw);
        if (kind === 'derived') await expect(page.locator('#event-metadata')).toContainText('no separately captured raw request');
        else await expect(page.locator('#event-metadata')).not.toContainText('no separately captured raw request');
        await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    }
});
