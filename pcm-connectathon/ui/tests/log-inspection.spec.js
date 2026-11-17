'use strict';
/** Real retained-job investigations over an owned corpus; only delivery faults are intercepted. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { TRACE } = require('../../../test-support/log-search-corpus');

/** Activate with native touch on mobile and keyboard on desktop. */
async function activate(locator, testInfo) {
    if (testInfo.project.name === 'chromium-mobile') await locator.tap();
    else { await locator.focus(); await locator.press('Enter'); }
}
/** Wait for the real service to finish and retain source-bound UI/network measurements. */
async function terminal(page, testInfo, name) {
    await expect.poll(() => page.evaluate(() => searchSession?.state)).not.toBe('starting');
    await expect.poll(() => page.evaluate(() => searchSession?.state)).not.toBe('running');
    const timing = await page.evaluate(() => window.logSearchTimings);
    const manifest = await (await page.request.get('/fixture/manifest')).json();
    const filename = testInfo.outputPath(`${name}-timings.json`);
    fs.writeFileSync(filename, JSON.stringify({ project: testInfo.project.name, name, corpusBytes: manifest.bytes,
        files: manifest.files, timing }, null, 2));
    await testInfo.attach(name, { path: filename, contentType: 'application/json' });
    expect(timing.state).toBe('complete');
    if (manifest.bytes > 700 * 1048576) {
        if (timing.progress.matched) expect(timing.firstRenderedMilliseconds).toBeLessThanOrEqual(3000);
        expect(timing.terminalRenderedMilliseconds).toBeLessThanOrEqual(8000);
    }
    return timing;
}
/** Dismiss actual explanation popups and close the upper sidebar without closing detail. */
async function dismiss(page) {
    const button = page.getByRole('button', { name: 'Dismiss explanation' });
    if (await button.isVisible()) await button.click();
}

for (const order of ['timeline', 'flow']) for (const diagnostics of [false, true]) {
    test(`exact actions preserve context, explicit correlation and history ${order} diagnostics ${diagnostics}`, async ({ page }, testInfo) => {
        const traffic = [], requests = new WeakMap();
        page.on('request', request => {
            if (!request.url().includes('/api/unified-logs')) return;
            const record = { method: request.method(), url: request.url(), timing: null };
            traffic.push(record); requests.set(request, record);
        });
        page.on('requestfinished', request => { if (requests.has(request)) requests.get(request).timing = request.timing(); });
        await page.addInitScript(order => {
            localStorage.setItem('unifiedLogOrderMode', order);
            localStorage.setItem('unifiedLogTailPosition', order === 'flow' ? 'bottom' : 'top');
            const interval = window.setInterval.bind(window);
            window.setInterval = (fn, ms, ...args) => ms === 3000 ? 0 : interval(fn, ms, ...args);
        }, order);
        await page.goto(`/logs-view?role=doctor&traceId=${TRACE}&method=GET&diagnostics=${diagnostics}`);
        await expect(page.locator('.log-row').first()).toBeVisible();
        if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
        const id = await page.evaluate(() => currentLogs.find(row => getCorrelationId(row) === 'late-match').id);
        const row = page.locator(`[data-log-id="${id}"]`);
        await activate(row, testInfo); await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
        const raw = await page.evaluate(() => selectedResult.raw);
        await page.locator('#tab-raw').click();
        const originalUrl = page.url(); const before = traffic.length;
        await activate(page.locator('[data-inspect-field="traceId"]'), testInfo);
        await expect(page.locator('.log-row.selected')).toHaveAttribute('data-log-id', id);
        expect(await page.evaluate(() => selectedResult.raw)).toBe(raw);
        await terminal(page, testInfo, 'trace-first');
        await expect(page.locator('#investigation-title')).toContainText(TRACE);
        await expect(page.locator('#investigation-description')).toContainText('correlation-only events are excluded');
        await expect(page.locator('#investigation-description')).toContainText('all configured roles and organizations');
        await expect(page.locator('#investigation-observed')).toContainText('roles doctor');
        await expect(page.locator('.log-row')).toHaveCount(diagnostics ? 5 : 4);
        const ids = await page.locator('.log-row').evaluateAll(rows => rows.map(row => row.dataset.logId));
        expect(new Set(ids).size).toBe(ids.length);
        expect(new URL(page.url()).searchParams.has('role')).toBe(false);
        expect(await page.evaluate(() => showDiagnosticLogs)).toBe(diagnostics);
        await expect(page.locator('#panel-raw')).toBeVisible();
        // Exact trace stays one-role; related correlation is a separate explicit action.
        await activate(page.locator('[data-inspect-field="correlationId"]'), testInfo);
        await terminal(page, testInfo, 'correlation');
        await expect(page.locator('#investigation-title')).toContainText('Correlation · late-match');
        const roles = await page.evaluate(() => searchSession.observedRoles);
        expect(roles.slice().sort()).toEqual(['adapter', 'doctor', 'gateway']);
        await expect(page.locator('#investigation-description')).toContainText('trace IDs differ');
        await activate(page.locator('#return-to-results'), testInfo);
        await expect(page.locator('#investigation-title')).toContainText('Trace');
        await page.goBack(); await expect(page.locator('#investigation-title')).toContainText('Correlation');
        await page.goForward(); await expect(page.locator('#investigation-title')).toContainText('Trace');
        // Repeated lookup uses a fresh bounded job, never a browser history rescan.
        await activate(page.locator('[data-inspect-field="traceId"]'), testInfo);
        await terminal(page, testInfo, 'trace-repeat');
        await activate(page.locator('[data-inspect-field="flowId"]'), testInfo);
        await terminal(page, testInfo, 'flow');
        expect((await page.evaluate(() => searchSession.observedRoles)).slice().sort()).toEqual(['adapter', 'doctor', 'gateway']);
        await expect(page.locator('#investigation-description')).toContainText('may span several requests/traces');
        const actionTraffic = traffic.slice(before);
        // Focusing the metadata action can finish a legitimate browse scroll
        // before Enter. Query ownership begins at its actual admission request.
        const scopedTraffic = actionTraffic.slice(actionTraffic.findIndex(request => request.method === 'POST'));
        expect(scopedTraffic.filter(request => /\/api\/unified-logs\?/.test(request.url))).toEqual([]);
        expect(scopedTraffic.filter(request => request.method === 'POST')).toHaveLength(4);
        fs.writeFileSync(testInfo.outputPath('network.json'), JSON.stringify(scopedTraffic, null, 2));
        // Actual authored/generated explanations support both keyboard and touch.
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        for (const [field, phrase] of [['flowId', 'workflow ID'], ['traceId', 'propagated trace ID'], ['correlationId', 'auth and proxy']]) {
            const control = page.locator(`[data-inspect-field="${field}"]`);
            if (testInfo.project.name === 'chromium-mobile') await control.tap(); else await control.focus();
            await expect(page.getByRole('tooltip')).toContainText(phrase);
            await dismiss(page);
            if (testInfo.project.name === 'chromium-mobile') {
                // A native tap also activates the real link. Finish and unwind
                // that explicit investigation before checking the next control.
                await expect.poll(() => page.evaluate(() => searchSession.state)).toBe('complete');
                await page.evaluate(() => returnToResults()); await dismiss(page);
            }
        }
        await page.locator('#search-retry').focus(); await expect(page.getByRole('tooltip')).toContainText('Unapplied filter edits'); await dismiss(page);
        await page.locator('#investigation-title').focus(); await expect(page.getByRole('tooltip')).toContainText('Missing propagation'); await dismiss(page);
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await expect(page.locator('#event-metadata-body .explain-target')).toHaveCount(0);
        const accessibility = await new AxeBuilder({ page }).include('#investigation-banner').include('#search-banner').analyze();
        expect(accessibility.violations).toEqual([]);
        const bounds = await page.locator('#investigation-banner').boundingBox();
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
        if (order === 'timeline' && !diagnostics) await page.screenshot({ path: testInfo.outputPath('inspection.png'), fullPage: true });
        // Three explicit Returns unwind flow -> repeated trace -> first trace -> held browse.
        await activate(page.locator('#return-to-results'), testInfo);
        await activate(page.locator('#return-to-results'), testInfo);
        await activate(page.locator('#return-to-results'), testInfo);
        await expect(page).toHaveURL(originalUrl);
        await expect(page.locator('.log-row.selected')).toHaveAttribute('data-log-id', id);
        expect(await page.evaluate(() => selectedResult.raw)).toBe(raw);
        await expect(page.locator('#panel-raw')).toBeVisible();
    });
}

test('empty, diagnostic-only, cancel, failed query, retry and stale responses remain explicit', async ({ page }, testInfo) => {
    await page.goto('/logs-view?inspection=traceId&traceId=absent-inspection&diagnostics=false');
    await terminal(page, testInfo, 'empty');
    await expect(page.locator('#log-table-body')).toContainText('No matches within');
    await page.evaluate(() => inspectJourney(null, 'traceId', 'diagnostic-only-id'));
    await terminal(page, testInfo, 'diagnostics-hidden');
    await expect(page.locator('.log-row')).toHaveCount(0);
    await page.evaluate(() => setDiagnosticVisibility(true));
    await terminal(page, testInfo, 'diagnostics-shown');
    await expect(page.locator('.log-row')).toHaveCount(1);
    // A rejected configured source is partial coverage, even when healthy roles match.
    expect((await page.request.post('/fixture/inspection-source/fail')).ok()).toBe(true);
    try {
        await page.evaluate(trace => { inspectJourney(null, 'traceId', trace); }, TRACE);
        await expect.poll(() => page.evaluate(() => searchSession.state)).toBe('partial');
        await expect(page.locator('#search-progress')).toContainText('unavailable sources: ho-b-adapter');
        await expect(page.locator('.log-row')).toHaveCount(5);
    } finally { expect((await page.request.post('/fixture/inspection-source/restore')).ok()).toBe(true); }
    // Hold delivery of a real server admission, then cancel before its ID arrives.
    let release, admitted;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/unified-logs/search', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch(); admitted = (await response.json()).id;
        await held; await route.fulfill({ response });
    });
    await page.evaluate(trace => { inspectJourney(null, 'traceId', trace); }, TRACE);
    await expect.poll(() => admitted).toBeTruthy();
    await activate(page.locator('#search-cancel'), testInfo);
    await expect(page.locator('#search-progress')).toContainText('Cancellation requested');
    const cancellationStarted = Date.now();
    // The tiny real scan may finish while its admission response is held. Require
    // DELETE of that exact job and mirror its truthful terminal acknowledgement;
    // completed evidence must not be relabelled cancelled by the UI.
    const deletion = page.waitForResponse(response => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === '/api/unified-logs/search/' + admitted);
    release(); const acknowledgement = await deletion;
    expect(acknowledgement.ok()).toBe(true);
    const acknowledged = await acknowledgement.json();
    expect(acknowledged.state).toMatch(/^(complete|cancelled)$/);
    await expect.poll(() => page.evaluate(() => searchSession.state), { intervals: [25, 50] }).toBe(acknowledged.state);
    expect((await (await page.request.get('/api/unified-logs/search/' + admitted)).json()).state).toBe(acknowledged.state);
    const cancellationMilliseconds = Date.now() - cancellationStarted;
    fs.writeFileSync(testInfo.outputPath('cancellation.json'), JSON.stringify({ admitted, cancellationMilliseconds, state: acknowledged.state, scope: 'DELETE of exact admitted job plus truthful terminal UI state; tiny job may already be complete' }, null, 2));
    expect(cancellationMilliseconds).toBeLessThanOrEqual(500);
    await page.unroute('**/api/unified-logs/search');
    // Rotation invalidates the exact captured source, and retry starts a fresh job.
    await page.evaluate(trace => { inspectJourney(null, 'traceId', trace); }, TRACE);
    await terminal(page, testInfo, 'before-rotation');
    await page.request.post('/fixture/inspection-rotate');
    await page.evaluate(() => readSearchPage(0));
    await expect(page.locator('#search-progress')).toContainText('Search failed');
    await activate(page.locator('#search-retry'), testInfo); await terminal(page, testInfo, 'after-rotation');
    // A late real result from an abandoned query cannot replace the restored view.
    let releaseResult, captured = false;
    const heldResult = new Promise(resolve => { releaseResult = resolve; });
    await page.route('**/api/unified-logs/search/*?**', async route => {
        const response = await route.fetch(); captured = true; await heldResult;
        // The real AbortController may already have cancelled this abandoned
        // browser route. That acknowledgement is the expected stale-read fence.
        try { await route.fulfill({ response }); }
        catch (error) { if (!error.message.includes('Route is already handled')) throw error; }
    });
    await page.evaluate(() => { inspectJourney(null, 'flowId', 'shared-flow'); });
    await expect.poll(() => captured).toBe(true);
    await activate(page.locator('#return-to-results'), testInfo);
    releaseResult(); await page.unroute('**/api/unified-logs/search/*?**');
    await expect(page.locator('#investigation-title')).toContainText('Trace');
    expect(await page.evaluate(() => searchSession.filters.traceId)).toBe(TRACE);
});

test('Coverage and Tools explain loaded evidence and retained job budgets', async ({ page }, testInfo) => {
    await page.goto(`/logs-view?inspection=traceId&traceId=${TRACE}&diagnostics=false`);
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await page.locator('[data-open-panel="tools"]').click();
    await page.locator('[data-panel-tab="coverage"]').click();
    await expect(page.locator('[data-panel="coverage"]')).toContainText('Evidence in the loaded search result page: 4 events');
    await expect(page.locator('[data-panel="coverage"]')).toContainText('Filtering cannot add missing instrumentation');
    await page.locator('#close-workbench').click();
    await page.locator('[data-open-panel="tools"]').click();
    await page.locator('#viewer-diagnostics summary').click();
    await expect(page.locator('#viewer-budgets')).toContainText('1 MiB');
    await expect(page.locator('#viewer-budgets')).toContainText('200 events');
    await page.locator('#close-workbench').click();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('[data-open-panel="tools"]').click();
    await page.locator('[data-panel-tab="coverage"]').focus();
    await expect(page.getByRole('tooltip')).toContainText('source availability for the loaded evidence');
    if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Dismiss explanation' }).tap();
    else await dismiss(page);
});
