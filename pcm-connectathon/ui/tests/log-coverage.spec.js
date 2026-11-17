'use strict';
/** Actual source-bound Coverage tasks, with isolated synthetic delivery boundaries explicitly labelled. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
/** Use native touch on Pixel and keyboard activation on desktop. */
async function activate(locator, info) { if (info.project.name.endsWith('mobile')) await locator.tap(); else { await locator.focus(); await locator.press('Enter'); } }
/** Keep the drawer lifecycle native so controls remain reachable on narrow screens. */
async function panel(page, name, info) { if (await page.locator('#workbench').isVisible()) await activate(page.locator('#close-workbench'), info); await activate(page.locator(`[data-open-panel="${name}"]`), info); }
/** Close only the upper drawer, preserving selected detail. */
async function close(page, info) { if (await page.locator('#workbench').isVisible()) await activate(page.locator('#close-workbench'), info); }
/** Snapshot real controls/state/requests and source file identities for the usability walkthrough. */
async function record(page, info, name, observations) {
    const manifest = await (await page.request.get('/fixture/manifest')).json();
    const state = await page.evaluate(() => ({ url: location.href, count: currentLogs.length, pages: logPages.length, followingLatest, showDiagnosticLogs,
        source: document.querySelector('#search-source').value, scope: document.querySelector('#filter-summary').textContent,
        evidence: document.querySelector('#page-coverage').textContent, inventory: document.querySelector('#source-summary').textContent,
        anchor: captureAnchor(), latest: document.querySelector('#source-latest-check').textContent, selectedId, selectedRaw: selectedResult?.raw }));
    const filename = info.outputPath(name + '.json'); fs.writeFileSync(filename, JSON.stringify({ manifest, state, observations }, null, 2));
    await info.attach(name, { path: filename, contentType: 'application/json' }); return state;
}
/** Disable clock-driven polls only; manual reads exercise unchanged real API and navigation logic. */
async function deterministic(page) {
    await page.addInitScript(() => { const schedule = window.setInterval.bind(window); window.setInterval = (callback, milliseconds, ...args) => milliseconds === 3000 ? 0 : schedule(callback, milliseconds, ...args); });
}

test('coverage sources, retained evidence, later health and advanced diagnostics are honest', async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await deterministic(page);
    const responses = [], errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => { if (/\/api\/unified-logs\?/.test(response.url())) responses.push(await response.json()); });
    await page.goto('/logs-view?diagnostics=false'); await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(0);
    await page.evaluate(() => { holdReading(); document.querySelector('#log-list').scrollTop = 700; });
    await panel(page, 'coverage', info);
    await expect(page.locator('#source-summary')).toContainText('unavailable / missing');
    await expect(page.locator('#source-list')).toContainText('ho-c-adapter'); await expect(page.locator('#source-list')).toContainText('import-only');
    await expect(page.locator('#page-coverage')).toContainText('does not mean logging was lost');
    await expect(page.locator('#page-coverage')).toContainText('limited to current files and up to five retained rotations');
    await expect(page.locator('#page-coverage')).toContainText('oversized records');
    await expect(page.locator('#page-coverage')).toContainText('ho-c-adapter');
    await expect(page.locator('#journey-summary')).toContainText('loaded page');
    expect(await page.locator('[data-panel="coverage"] #log-status').count()).toBe(0);
    const held = await page.locator('#page-coverage').textContent();
    await page.request.post('/fixture/heal'); await page.evaluate(() => refreshLogs());
    await page.locator('[data-help-key="logs.coverage-health"]').click();
    await expect(page.locator('#source-latest-check')).toContainText('ho-c-adapter: available');
    expect(await page.locator('#page-coverage').textContent()).toBe(held);
    await expect(page.locator('#source-list')).toContainText('error');
    await close(page, info); await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await panel(page, 'coverage', info);
    const source = page.locator('[data-coverage-filter="source"][data-value="ho-a-adapter"]'); await source.focus();
    await expect(page.getByRole('tooltip')).toContainText('exact registered source');
    if (await page.getByRole('button', { name: 'Dismiss explanation' }).isVisible()) await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await close(page, info); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck(); await panel(page, 'coverage', info);
    const axe = await new AxeBuilder({ page }).include('#workbench').analyze(); expect(axe.violations).toEqual([]);
    await panel(page, 'tools', info); await activate(page.locator('#viewer-diagnostics > summary'), info);
    await expect(page.locator('#viewer-budgets')).toContainText('600 summaries'); await expect(page.locator('#log-status')).toBeVisible();
    await expect(page.locator('#viewer-diagnostics')).toContainText('separately from the Diagnostics');
    await panel(page, 'coverage', info); await close(page, info);
    // Scroll real adjacent byte pages until their actual loaded-window scope appears.
    await page.evaluate(() => { holdReading(); document.querySelector('#log-list').scrollTop = document.querySelector('#log-list').scrollHeight; setHistoryDirection('older'); scheduleHistoryRead(0); });
    await expect.poll(() => page.evaluate(() => logPages.length)).toBeGreaterThan(1);
    await panel(page, 'coverage', info); await expect(page.locator('#journey-summary')).toContainText('loaded window');
    await expect(page.locator('#page-coverage')).toContainText('captured snapshot');
    await record(page, info, 'source-health-and-continuation', responses.map(result => ({ rows: result.entries?.length, bytes: result.bytesRead, reasons: result.coverage?.reasons })));
    expect(responses.every(result => result.bytesRead <= 1048576 && result.entries.length <= 200)).toBe(true);
    expect(await page.evaluate(() => currentLogs.length)).toBeLessThanOrEqual(600); expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('coverage.png') });
});

test('coverage exact source role HO actions combine, remove and restore held state through history', async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await deterministic(page);
    const requests = []; page.on('request', request => { if (/\/api\/unified-logs\?/.test(request.url())) requests.push(request.url()); });
    await page.goto('/logs-view?diagnostics=false&level=INFO&method=GET'); await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(0);
    await close(page, info); await activate(page.locator('.log-row').first(), info); await expect(page.locator('.raw-source-text')).toBeAttached();
    await page.evaluate(() => { holdReading(); document.querySelector('#log-list').scrollTop = 650; });
    const original = await record(page, info, 'before-source-action', requests);
    await panel(page, 'coverage', info); await activate(page.locator('[data-coverage-filter="source"][data-value="ho-a-adapter"]'), info);
    await expect.poll(() => page.evaluate(() => currentResult?.sources?.[0]?.componentId)).toBe('ho-a-adapter');
    await expect(page.locator('#search-source')).toHaveValue('ho-a-adapter'); // attached hidden control remains synchronized
    expect(new URL(page.url()).searchParams.get('source')).toBe('ho-a-adapter');
    expect(await page.evaluate(() => currentLogs.every(row => row.event.source.componentId === 'ho-a-adapter'))).toBe(true);
    await page.goBack(); await expect(page.locator('#search-source')).toHaveValue('');
    const restored = await record(page, info, 'source-back-original', requests);
    expect(restored.anchor.id).toBe(original.anchor.id); expect(Math.abs(restored.anchor.offset - original.anchor.offset)).toBeLessThanOrEqual(2);
    expect(restored.selectedRaw).toBe(original.selectedRaw); expect(restored.followingLatest).toBe(false);
    await page.goForward(); await expect(page.locator('#search-source')).toHaveValue('ho-a-adapter');

    for (const [field, value] of [['role', 'adapter'], ['healthOrganizationId', 'ho-a']]) {
        await activate(page.locator(`[data-coverage-filter="${field}"][data-value="${value}"]`), info);
        await expect.poll(() => page.evaluate(() => document.querySelector('#log-list').getAttribute('aria-busy'))).toBe('false');
        expect(new URL(page.url()).searchParams.get(field)).toBe(value);
    }
    const filtered = await record(page, info, 'exact-combined-filters', requests);
    expect(filtered.followingLatest).toBe(false); expect(filtered.showDiagnosticLogs).toBe(false);
    expect(filtered.selectedId).toBe(original.selectedId); expect(filtered.selectedRaw).toBe(original.selectedRaw);
    for (const field of ['level', 'method']) expect(new URL(page.url()).searchParams.get(field)).toBe(field === 'level' ? 'INFO' : 'GET');
    await activate(page.getByRole('button', { name: 'Remove source=ho-a-adapter', exact: true }), info);
    await expect.poll(() => page.evaluate(() => currentResult?.sources?.length)).toBe(1); // role+HO still select exactly the one adapter
    expect(new URL(page.url()).searchParams.has('source')).toBe(false);
    await page.goBack(); await expect(page.locator('#search-source')).toHaveValue('ho-a-adapter');
    expect(await page.evaluate(() => selectedResult.raw)).toBe(original.selectedRaw);
    await page.goForward(); await expect(page.locator('#search-source')).toHaveValue('');
    // Add an incompatible ordinary filter without dropping source identity or Diagnostics.
    await panel(page, 'filters', info); await page.locator('#filter-level').selectOption('ERROR');
    await activate(page.getByRole('button', { name: 'Apply filters', exact: true }), info);
    await expect.poll(() => page.evaluate(() => currentResult?.entries?.length)).toBe(0);
    await panel(page, 'coverage', info); await expect(page.locator('#page-coverage')).toContainText('No matching evidence');
    await expect(page.locator('#page-coverage')).toContainText('never-recorded events cannot be recovered');
    await activate(page.locator('[data-coverage-filter="source"][data-value="ho-a-adapter"]'), info);
    expect(new URL(page.url()).searchParams.get('level')).toBe('ERROR');
    await record(page, info, 'empty-combined-source', requests);
    const invalid = await page.request.get('/api/unified-logs?page=true&source=unknown-coverage-source'); expect(invalid.status()).toBe(409);
    const invalidSearch = await page.request.post('/api/unified-logs/search', { data: { source: 'unknown-coverage-source' } }); expect(invalidSearch.status()).toBe(400);
    await page.goto('/logs-view?source=unknown-coverage-source&diagnostics=false'); await expect(page.locator('#log-table-body')).toContainText('could not be loaded');
    await panel(page, 'coverage', info); await expect(page.locator('#source-summary')).toContainText('unavailable');
});

for (const diagnostics of [false, true]) test(`coverage recorded ID links reuse exact across-role search and Return diagnostics=${diagnostics}`, async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await deterministic(page);
    const queries = []; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/unified-logs/search')) queries.push(request.postDataJSON()); });
    await page.goto(`/logs-view?source=ho-a-adapter&role=adapter&healthOrganizationId=ho-a&level=INFO&diagnostics=${diagnostics}`);
    await expect(page.locator('.log-row')).toHaveCount(2); await close(page, info);
    await activate(page.locator('.log-row').first(), info); await expect(page.locator('.raw-source-text')).toBeAttached();
    await page.evaluate(() => { holdReading(); });
    const before = await record(page, info, 'before-investigation', []);
    for (const field of ['flowId', 'traceId', 'correlationId']) {
        await panel(page, 'coverage', info); const summary = page.locator('#journey-summary'); if (!(await summary.evaluate(node => node.parentElement.open))) await activate(summary, info);
        const link = page.locator(`[data-coverage-journey="${field}"]`).first();
        const exact = await link.getAttribute('data-value'); const href = new URL(await link.getAttribute('href'), page.url());
        expect(href.searchParams.get(field)).toBe(exact); expect(href.searchParams.has('source')).toBe(false);
        await activate(link, info);
        await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('partial');
        await expect(page.locator('#search-progress')).toContainText('ho-c-adapter');
        expect(queries.at(-1)).toEqual({ [field]: exact, diagnostics: String(diagnostics) });
        await expect(page.locator('#investigation-description')).toContainText('other filters set aside');
        await expect(page.locator('#investigation-observed')).toContainText('gateway');
        expect(await page.evaluate(() => currentLogs.every(row => ({ flowId: getFlowId, traceId: getTraceId, correlationId: getCorrelationId })[investigation.field](row) === investigation.value))).toBe(true);
        await panel(page, 'coverage', info); await expect(page.locator('#journey-summary')).toContainText('loaded search result page');
        await close(page, info); await activate(page.locator('#return-to-results'), info);
        await expect(page.locator('#search-source')).toHaveValue('ho-a-adapter');
        const returned = await record(page, info, 'returned-' + field, queries);
        expect(returned.selectedRaw).toBe(before.selectedRaw); expect(returned.followingLatest).toBe(false);
        expect(returned.showDiagnosticLogs).toBe(diagnostics); expect(returned.url).toBe(before.url);
        await page.goBack(); await expect.poll(() => page.evaluate(() => Boolean(investigation))).toBe(true);
        await page.goBack(); await expect(page.locator('#search-source')).toHaveValue('ho-a-adapter');
        await page.goForward(); await expect.poll(() => page.evaluate(() => Boolean(investigation))).toBe(true);
        await page.goForward(); await expect(page.locator('#search-source')).toHaveValue('ho-a-adapter');
    }
});

test('coverage unknown inventory and unavailable source remain usable without implied evidence recovery', async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await deterministic(page);
    // Delivery-only scenario: the real API currently emits available/error/missing; future unknown states must stay honest.
    await page.route('**/api/unified-logs?**', async route => { const response = await route.fetch(); const result = await response.json();
        result.sources = [{ componentId: 'pcm-core', label: 'Synthetic unknown availability', role: 'pcm', state: 'unknown' }]; await route.fulfill({ response, json: result }); });
    await page.goto('/logs-view?source=ho-c-adapter&diagnostics=false'); await expect.poll(() => page.evaluate(() => currentResult !== null)).toBe(true);
    await panel(page, 'coverage', info); await expect(page.locator('#source-summary')).toContainText('1 unknown');
    await expect(page.locator('#page-coverage')).toContainText('ho-c-adapter'); await expect(page.locator('#page-coverage')).toContainText('No matching evidence');
    await record(page, info, 'synthetic-unknown-health', []);
    await page.unroute('**/api/unified-logs?**');
    await page.goto('/logs-view?source=ho-c-adapter&diagnostics=false'); await expect.poll(() => page.evaluate(() => currentResult !== null)).toBe(true);
    await panel(page, 'coverage', info); await expect(page.locator('#source-list')).toContainText('error');
    await activate(page.locator('[data-coverage-filter="source"][data-value="ho-c-adapter"]'), info);
    await expect(page.locator('#page-coverage')).toContainText('No matching evidence'); expect(await page.evaluate(() => showDiagnosticLogs)).toBe(false);
    await page.route('**/api/unified-logs?**', async route => { const response = await route.fetch(); const result = await response.json(); delete result.sources; await route.fulfill({ response, json: result }); });
    await page.evaluate(() => refreshLogs(true)); await expect(page.locator('#source-summary')).toContainText('inventory unknown');
    await expect(page.locator('#source-list')).toContainText('no source action is inferred'); expect(await page.locator('#source-list button').count()).toBe(0);
    await record(page, info, 'inventory-absent', []);
});


test('coverage exact actions preserve live following and accept a later bounded append', async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await deterministic(page);
    await page.goto('/logs-view?source=ho-a-adapter&diagnostics=false'); await expect(page.locator('.log-row')).toHaveCount(2);
    expect(await page.evaluate(() => followingLatest)).toBe(true);
    await panel(page, 'coverage', info); await activate(page.locator('[data-coverage-filter="role"][data-value="adapter"]'), info);
    await expect.poll(() => page.evaluate(() => currentResult?.entries?.length)).toBe(2);
    expect(await page.evaluate(() => followingLatest)).toBe(true);
    await close(page, info); await page.request.post('/fixture/append'); await page.evaluate(() => catchUpLive());
    await expect.poll(() => page.evaluate(() => currentLogs.length)).toBe(3);
    const newestId = await page.evaluate(() => currentLogs.reduce((latest, row) => row.timestamp > latest.timestamp ? row : latest).id);
    await activate(page.locator(`[data-log-id="${newestId}"]`), info);
    await expect.poll(() => page.evaluate(() => selectedResult?.raw || '')).toContain('Coverage live append');
    expect(await page.evaluate(() => currentLogs.length)).toBeLessThanOrEqual(600);
    expect(await page.evaluate(() => showDiagnosticLogs)).toBe(false);
    await record(page, info, 'following-and-live-append', []);
});
