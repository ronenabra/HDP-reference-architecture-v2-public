'use strict';

/** Browser regressions for the bounded live-reading workbench. All records below
 * are controlled synthetic responses; real-fixture budgets remain in ui-ops-rem.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installWorkbenchFixture } = require('./logs-workbench-fixture');
const base = process.env.PCM_OPS_FIXTURE_URL;
test.beforeEach(() => test.skip(!base, 'requires the owned operator fixture'));

/** Drive one actual client polling cycle without relying on wall-clock timing. */
async function poll(page) { await page.evaluate(() => refreshLogs()); }
async function closeWorkbench(page) {
    const close = page.locator('#close-workbench');
    if (await close.isVisible()) await close.click();
}
async function selection(page, index = 15) {
    await closeWorkbench(page);
    const row = page.locator('.log-row').nth(index);
    await row.click();
    await page.locator('#tab-raw').click();
    await expect(page.locator('#details-pane pre.raw-source-text')).toBeVisible();
    return decodeURIComponent(await row.getAttribute('data-log-id'));
}
async function snapshot(page) {
    return page.evaluate(() => {
        const list = document.getElementById('log-list');
        const rect = list.getBoundingClientRect();
        const visible = [...document.querySelectorAll('.log-row')].find(row => row.getBoundingClientRect().bottom > rect.top + 35);
        return { scrollTop: list.scrollTop, visibleId: visible?.dataset.logId,
            offset: visible ? visible.getBoundingClientRect().top - rect.top : null,
            selected: document.querySelector('.log-row.selected')?.dataset.logId,
            raw: document.querySelector('#details-pane pre.raw-source-text')?.textContent,
            detailScroll: document.querySelector('#details-pane')?.scrollTop,
            detailHeight: document.querySelector('#resizer')?.getAttribute('aria-valuenow'),
            activeTab: document.querySelector('[role=tab][aria-selected=true]')?.id,
            structuredScroll: document.querySelector('#panel-json pre[data-help-key="logs.payload"]')?.scrollTop,
            rawScroll: document.querySelector('#details-pane pre.raw-source-text')?.scrollTop,
            focused: document.activeElement?.id || document.activeElement?.className };
    });
}

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) {
    test(`Logs reading holds row, pixels, focus and source text during ${order}/${tail} live eviction @smoke`, async ({ page }, testInfo) => {
        const fixture = await installWorkbenchFixture(page);
        await page.addInitScript(({ order, tail }) => {
            localStorage.setItem('unifiedLogOrderMode', order);
            localStorage.setItem('unifiedLogTailPosition', tail);
        }, { order, tail });
        await page.goto(`${base}/logs-view?diagnostics=false`);
        await expect(page.locator('.log-row')).toHaveCount(200);
        const id = await selection(page, 25);
        await page.evaluate(() => { toggleSelectedSpacer('before'); toggleSelectedSpacer('after'); });
        await expect(page.locator('.spacer-row')).toHaveCount(2);
        const raw = page.locator('#details-pane pre.raw-source-text');
        await raw.focus();
        await expect(raw).toBeFocused();
        await raw.evaluate(node => { node.scrollTop = 180; });
        expect(await raw.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        const before = await snapshot(page);
        const detailsReads = fixture.details.length;
        fixture.append(750);
        await poll(page);
        await poll(page);
        const held = await snapshot(page);
        expect(held.selected).toBe(encodeURIComponent(id));
        expect(held.visibleId).toBe(before.visibleId);
        expect(Math.abs(held.offset - before.offset)).toBeLessThanOrEqual(1);
        expect(held.scrollTop).toBe(before.scrollTop);
        expect(held.raw).toBe(before.raw);
        expect(held.detailScroll).toBe(before.detailScroll);
        expect(held.rawScroll).toBe(before.rawScroll);
        expect(held.focused).toBe(before.focused);
        expect(fixture.details.length).toBe(detailsReads);
        await expect(page.locator('.log-row')).toHaveCount(200);
        await closeWorkbench(page);
        await page.locator('#follow-latest').click();
        await expect(page.locator('.log-row.selected')).toHaveCount(0);
        if (!await page.locator('#event-detail').isVisible()) await page.locator('#toggle-event-detail').click();
        await expect(page.locator('#selection-state')).toBeVisible();
        // Applying the new bounded page must not discard the previously loaded immutable detail.
        expect(await page.locator('#details-pane pre.raw-source-text').textContent()).toBe(before.raw);
        await expect(page.locator('#selection-state')).toContainText(/outside.*page/i);
        expect(await page.locator('.log-row').count()).toBeLessThanOrEqual(600);
        await testInfo.attach('retained-reading-evidence', { body: JSON.stringify({ order, tail, before, held, id, detailReads: detailsReads }), contentType: 'application/json' });
    });
}

test('Logs investigation preserves exact IDs and nested return, browser history and prior reading state @smoke', async ({ page }, testInfo) => {
    await installWorkbenchFixture(page);
    await page.addInitScript(() => { localStorage.setItem('unifiedLogOrderMode', 'timeline'); localStorage.setItem('unifiedLogTailPosition', 'bottom'); });
    await page.goto(`${base}/logs-view?role=doctor&method=GET&diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(100);
    await page.evaluate(() => holdReading());
    const selectedId = await selection(page, 18);
    await page.locator('#resizer').focus();
    await page.keyboard.press('End');
    await page.locator('#tab-json').click();
    await page.locator('#panel-json pre[data-help-key="logs.payload"]').evaluate(node => { node.scrollTop = 70; });
    const originalStructuredScroll = await page.locator('#panel-json pre[data-help-key="logs.payload"]').evaluate(node => node.scrollTop);
    expect(originalStructuredScroll).toBeGreaterThan(0);
    await page.locator('#tab-raw').click();
    await page.locator('#details-pane pre.raw-source-text').evaluate(node => { node.scrollTop = 160; });
    const original = await snapshot(page);
    expect(original.rawScroll).toBeGreaterThan(0);
    if (page.viewportSize().width >= 768) await page.locator('[data-open-panel="filters"]').click();
    const sidebarOpen = await page.locator('#workbench').isVisible();
    const flow = page.getByRole('link', { name: /^Inspect this flow across roles/ });
    const flowId = new URL(await flow.getAttribute('href'), base).searchParams.get('flowId');
    await flow.click();
    await expect(page.locator('#investigation-banner')).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('flowId')).toBe(flowId);
    expect(new URL(page.url()).searchParams.has('role')).toBe(false);
    expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('false');
    await expect(page.locator('.log-row')).toHaveCount(24);
    await selection(page, 2);
    await page.locator('#resizer').focus();
    await page.keyboard.press('Home');
    const trace = page.getByRole('link', { name: /^Inspect this trace across roles/ });
    const traceId = new URL(await trace.getAttribute('href'), base).searchParams.get('traceId');
    await trace.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('traceId')).toBe(traceId);
    await expect(page.locator('.log-row')).toHaveCount(8);
    await page.locator('#return-to-results').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('flowId')).toBe(flowId);
    await expect(page.locator('.log-row')).toHaveCount(24);
    await closeWorkbench(page);
    await page.locator('#return-to-results').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('role')).toBe('doctor');
    await expect(page.locator('.log-row')).toHaveCount(100);
    await expect(page.locator('.log-row.selected')).toHaveAttribute('data-log-id', encodeURIComponent(selectedId));
    const returned = await snapshot(page);
    expect(returned.raw).toBe(original.raw);
    expect(returned.rawScroll).toBe(original.rawScroll);
    await page.locator('#tab-json').click();
    expect(await page.locator('#panel-json pre[data-help-key="logs.payload"]').evaluate(node => node.scrollTop)).toBe(originalStructuredScroll);
    await page.locator('#tab-raw').click();
    expect(await page.locator('#panel-raw pre').evaluate(node => node.scrollTop)).toBe(original.rawScroll);
    expect(returned.activeTab).toBe(original.activeTab);
    expect(returned.detailHeight).toBe(original.detailHeight);
    if (sidebarOpen) await expect(page.locator('#workbench')).toBeVisible();
    else await expect(page.locator('#workbench')).toBeHidden();
    await expect(page.locator('#view-state')).toContainText('Position held');
    await expect(page.locator('[data-log-order-mode="timeline"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-log-tail-position="bottom"]')).toHaveAttribute('aria-pressed', 'true');
    expect(Math.abs(returned.scrollTop - original.scrollTop)).toBeLessThanOrEqual(1);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('flowId')).toBe(flowId);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('traceId')).toBe(traceId);
    await page.goForward();
    await expect.poll(() => new URL(page.url()).searchParams.get('flowId')).toBe(flowId);
    await page.screenshot({ path: testInfo.outputPath('workbench-investigation.png'), fullPage: true });
});

test('Logs direct deep link has a visible all-logs exit and refresh retains scope @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    const flowId = fixture.entries[220].details.flowId;
    await page.goto(`${base}/logs-view?flowId=${encodeURIComponent(flowId)}&inspection=flowId&diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(24);
    await expect(page.locator('#investigation-banner')).toBeVisible();
    await page.reload();
    await expect(page.locator('.log-row')).toHaveCount(24);
    expect(new URL(page.url()).searchParams.get('flowId')).toBe(flowId);
    const exit = page.getByRole('button', { name: /All logs/i });
    await expect(exit).toBeVisible();
    await exit.click();
    await expect(page.locator('.log-row')).toHaveCount(200);
    expect(new URL(page.url()).searchParams.has('flowId')).toBe(false);
    expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('false');
});

test('Logs failed poll preserves held rows while later checks buffer updates and Jump resumes @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await selection(page);
    const before = await snapshot(page);
    fixture.failure = { status: 503, message: 'Synthetic source unavailable' };
    await poll(page);
    await expect(page.locator('#log-status')).toContainText('Synthetic source unavailable');
    expect((await snapshot(page)).raw).toBe(before.raw);
    expect((await snapshot(page)).selected).toBe(before.selected);
    fixture.failure = null;
    await page.evaluate(() => holdReading());
    const readCount = fixture.reads.length;
    fixture.append(20);
    await poll(page);
    expect(fixture.reads.length).toBeGreaterThan(readCount);
    expect((await snapshot(page)).raw).toBe(before.raw);
    await page.evaluate(() => followLatest());
    await expect.poll(() => fixture.reads.length).toBeGreaterThan(readCount);
    expect((await snapshot(page)).selected).toBe(before.selected);
});

test('Logs synchronous fetch initiation failure keeps reading and permits a subsequent poll @smoke', async ({ page }, testInfo) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await selection(page);
    const raw = page.locator('#details-pane pre.raw-source-text');
    await raw.focus(); await raw.evaluate(node => { node.scrollTop = 150; });
    const before = await snapshot(page);
    // Explicit fault injection proves the synchronous initiation boundary.
    // It does not assert that it caused the separately observed WebKit reload error.
    const escaped = await page.evaluate(async () => {
        const original = window.fetch;
        window.fetch = () => { throw new TypeError('Synthetic synchronous fetch initiation failure'); };
        try { await refreshLogs(); return null; }
        catch (error) { return error.message; }
        finally { window.fetch = original; }
    });
    expect(escaped).toBeNull();
    await expect(page.locator('#log-status')).toContainText('Synthetic synchronous fetch initiation failure');
    await expect(page.locator('#log-list')).toHaveAttribute('aria-busy', 'false');
    expect(await snapshot(page)).toEqual(before);
    const reads = fixture.reads.length;
    await poll(page);
    expect(fixture.reads.length).toBeGreaterThan(reads);
    await expect(page.locator('#log-status')).toContainText('latest check succeeded');
    expect(await snapshot(page)).toEqual(before);
    await testInfo.attach('synchronous-fetch-fault-scope', { body: 'Test-only window.fetch throws synchronously; demonstrates containment and retry. Independent of native WebKit reload causality.', contentType: 'text/plain' });
});

test('Logs held reading still discloses new source failures without a row change @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await selection(page);
    const before = await snapshot(page);
    fixture.sourceFailures = [{ component: 'ho-a-gateway', error: 'Synthetic unavailable stream' }];
    await poll(page);
    await expect(page.locator('#log-status')).toContainText('ho-a-gateway');
    await expect(page.locator('#log-status')).toContainText(/unavailable|failed/i);
    const after = await snapshot(page);
    expect(after.selected).toBe(before.selected);
    expect(after.raw).toBe(before.raw);
    expect(after.scrollTop).toBe(before.scrollTop);
});

test('Logs failed detail and delayed A to B to A never replace the latest selection @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    let delayedReference = null;
    fixture.detailResponder = async (route, reference) => {
        if (!delayedReference) { delayedReference = reference; await hold; try { await route.fulfill({ json: { raw: 'STALE DETAIL', details: { message: 'STALE DETAIL' } } }); } catch (_) {} return true; }
        return false;
    };
    await page.locator('.log-row').nth(2).click();
    await expect(page.locator('#details-pane')).toContainText('Loading selected');
    await closeWorkbench(page);
    await selection(page, 3);
    await closeWorkbench(page);
    await selection(page, 2);
    const current = await page.locator('#details-pane pre.raw-source-text').textContent();
    release();
    await page.waitForTimeout(100);
    expect(await page.locator('#details-pane pre.raw-source-text').textContent()).toBe(current);
    await expect(page.locator('#details-pane')).not.toContainText('STALE DETAIL');
    fixture.detailResponder = async route => { await route.fulfill({ status: 409, json: { error: 'Synthetic stale reference; source rotated' } }); return true; };
    await closeWorkbench(page);
    await page.locator('.log-row').nth(4).click();
    await expect(page.locator('#details-pane')).toContainText('Synthetic stale reference; source rotated');
    await expect(page.locator('.log-row')).toHaveCount(200);
});

test('Logs clear during an investigation cannot resurrect old selection through Back or Forward @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view?role=doctor&diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(100);
    const clearedSelection = await selection(page, 18);
    await page.getByRole('link', { name: /^Inspect this flow across roles/ }).click();
    await expect(page.locator('.log-row')).toHaveCount(24);
    await page.locator('[data-open-panel="tools"]').click();
    await page.route('**/api/unified-logs/clear', route => {
        fixture.entries = [];
        return route.fulfill({ json: { status: 'cleared', results: [{ component: 'pcm-core', status: 'cleared' }] } });
    });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear built-in logs', exact: true }).click();
    await expect(page.locator('.log-row')).toHaveCount(0);
    await expect(page.locator('#details-pane pre')).toHaveCount(0);
    await expect(page.locator('#event-metadata')).not.toContainText(clearedSelection);
    await closeWorkbench(page);
    await page.goBack();
    await expect(page.locator('#log-table-body')).toContainText('No matching evidence');
    await expect(page.locator('.log-row')).toHaveCount(0);
    await expect(page.locator('#details-pane pre')).toHaveCount(0);
    await expect(page.locator('#event-metadata')).not.toContainText(clearedSelection);
    await page.goForward();
    await expect(page.locator('.log-row')).toHaveCount(0);
    await expect(page.locator('#details-pane pre')).toHaveCount(0);
    await expect(page.locator('#event-metadata')).not.toContainText(clearedSelection);
});

test('Logs exact filters reject a delayed old response and Reset filters restores scope @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view?role=unknown-fabricated-role&diagnostics=false`);
    await expect(page.locator('#log-table-body')).toContainText('No matching evidence');
    expect(fixture.reads.at(-1).role).toBe('unknown-fabricated-role');
    await page.locator('[data-open-panel="filters"]').click();
    await expect(page.locator('#filter-role')).toHaveValue('unknown-fabricated-role');
    let release;
    fixture.responseGate = new Promise(resolve => { release = resolve; });
    await page.locator('#filter-role').selectOption('doctor');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect.poll(() => fixture.reads.at(-1).role).toBe('doctor');
    fixture.responseGate = null;
    await page.locator('#filter-role').selectOption('gateway');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.locator('.log-row')).toHaveCount(100);
    expect(new URL(page.url()).searchParams.get('role')).toBe('gateway');
    release();
    await page.waitForTimeout(100);
    await expect(page.locator('.log-row')).toHaveCount(100);
    expect(await page.locator('.log-row td:nth-child(2)').allTextContents()).toEqual(Array(100).fill('GatewayHO-A'));
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    await expect(page.locator('.log-row')).toHaveCount(200);
    expect(new URL(page.url()).searchParams.has('role')).toBe(false);
    expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('false');
});

test('Logs reload then Back and Forward never pair a URL with another snapshot scope @smoke', async ({ page }) => {
    await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view?role=doctor&diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(100);
    await selection(page, 18);
    await page.getByRole('link', { name: /^Inspect this flow across roles/ }).click();
    await expect(page.locator('.log-row')).toHaveCount(24);
    const flowId = new URL(page.url()).searchParams.get('flowId');
    await page.reload();
    await expect(page.locator('.log-row')).toHaveCount(24);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('role')).toBe('doctor');
    await expect(page.locator('.log-row')).toHaveCount(100);
    expect(await page.locator('.log-row .role-badge').allTextContents()).toEqual(Array(100).fill('Doctor'));
    await page.goForward();
    await expect.poll(() => new URL(page.url()).searchParams.get('flowId')).toBe(flowId);
    await expect(page.locator('.log-row')).toHaveCount(24);
});

test('Logs history remains bounded when Back traverses more than twenty snapshots @smoke', async ({ page }) => {
    test.setTimeout(90000);
    await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view?diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await page.locator('[data-open-panel="filters"]').click();
    const roles = ['doctor', 'gateway', 'pcm', 'adapter'];
    for (let index = 0; index < 25; index++) {
        await page.locator('#filter-role').selectOption(roles[index % roles.length]);
        await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
        await expect(page.locator('.log-row')).toHaveCount(100);
        expect(await page.evaluate(() => viewSnapshots.size)).toBeLessThanOrEqual(20);
    }
    const historyState = await page.evaluate(() => history.state);
    expect(Object.keys(historyState)).toEqual(['logsView']);
    for (let index = 23; index >= 0; index--) {
        await page.goBack();
        await expect.poll(() => new URL(page.url()).searchParams.get('role')).toBe(roles[index % roles.length]);
        await expect(page.locator('.log-row')).toHaveCount(100);
        expect(await page.evaluate(() => viewSnapshots.size)).toBeLessThanOrEqual(20);
    }
    await page.goBack();
    await expect(page.locator('.log-row')).toHaveCount(200);
    expect(await page.evaluate(() => viewSnapshots.size)).toBeLessThanOrEqual(20);
});

test('Logs Back to an interrupted pending filter snapshot retries its exact scope while held @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view?role=doctor&diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(100);
    await page.evaluate(() => holdReading());
    await page.locator('[data-open-panel="filters"]').click();
    let release;
    fixture.responseGate = new Promise(resolve => { release = resolve; });
    await page.locator('#filter-role').selectOption('gateway');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect.poll(() => fixture.reads.at(-1).role).toBe('gateway');
    fixture.responseGate = null;
    await page.locator('#filter-role').selectOption('adapter');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.locator('.log-row')).toHaveCount(100);
    release();
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('role')).toBe('gateway');
    await expect.poll(() => page.locator('.log-row .role-badge').allTextContents()).toEqual(Array(100).fill('Gateway'));
    await expect(page.locator('#view-state')).toContainText('Following latest');
});

test('Logs workbench is dense, contrast-safe, keyboard closable and responsive @smoke', async ({ page }, testInfo) => {
    await installWorkbenchFixture(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await expect(page.locator('#event-detail')).toBeHidden();
    const list = await page.locator('#log-list').boundingBox();
    expect(list.height).toBeGreaterThan(page.viewportSize().height * 0.55);
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const row = page.locator('.log-row').nth(2);
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#event-detail')).toBeVisible();
    await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#event-detail')).toBeHidden();
    await expect(row).toBeFocused();
    await page.keyboard.press(' ');
    await expect(page.locator('#event-detail')).toBeVisible();
    const audit = await new AxeBuilder({ page }).analyze();
    await testInfo.attach('axe-workbench', { body: JSON.stringify(audit.violations, null, 2), contentType: 'application/json' });
    expect(audit.violations.filter(item => ['landmark-one-main', 'landmark-complementary-is-top-level', 'region', 'color-contrast', 'aria-allowed-role'].includes(item.id) || ['serious', 'critical'].includes(item.impact))).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('workbench-selected.png'), fullPage: true });
});
