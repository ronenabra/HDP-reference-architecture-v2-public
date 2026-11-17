'use strict';

/** Focused scroll, bounded-cache and sparse-filter regressions for the Logs page. */
const { test, expect } = require('@playwright/test');
const { event, installWorkbenchFixture } = require('./logs-workbench-fixture');
const base = process.env.PCM_OPS_FIXTURE_URL;
test.beforeEach(() => test.skip(!base, 'requires the owned operator fixture'));

/** Read the same visible-row anchor as the viewer, including sticky-header clearance. */
async function anchor(page) {
    return page.evaluate(() => {
        const list = document.getElementById('log-list');
        const bounds = list.getBoundingClientRect();
        const row = [...list.querySelectorAll('.log-row')].find(node => node.getBoundingClientRect().bottom > bounds.top + 36);
        return { id: row?.dataset.logId, offset: row?.getBoundingClientRect().top - bounds.top };
    });
}

/** Scroll toward history in the selected display direction, using real scroll events. */
async function scrollOlder(page, tail, distance = 0) {
    await page.locator('#log-list').evaluate((list, { tail, distance }) => {
        list.scrollTop = tail === 'bottom' ? distance : list.scrollHeight - list.clientHeight - distance;
    }, { tail, distance });
}

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) {
    test(`Logs bidirectional history reloads evicted pages and follows the latest edge in ${order}/${tail} @smoke`, async ({ page }, testInfo) => {
        const fixture = await installWorkbenchFixture(page, { count: 1600 });
        fixture.pageResponder = async (_route, params) => {
            if (params.has('cursor')) await new Promise(resolve => setTimeout(resolve, 80));
            return false;
        };
        await page.addInitScript(({ order, tail }) => {
            localStorage.setItem('unifiedLogOrderMode', order);
            localStorage.setItem('unifiedLogTailPosition', tail);
        }, { order, tail });
        await page.goto(`${base}/logs-view?diagnostics=false`);
        await expect(page.locator('.log-row')).toHaveCount(200);
        await expect(page.locator('#footer-hint')).toHaveCount(0);
        await expect(page.locator('#older-status')).toHaveCount(0);
        const samples = [];
        /** Exercise an edge through actual scroll events and compare its visible anchor. */
        async function move(direction, expectedMaximum) {
            const started = Date.now();
            await scrollOlder(page, direction === 'older' ? tail : tail === 'top' ? 'bottom' : 'top');
            const before = await anchor(page);
            await expect.poll(() => page.evaluate(() => Math.max(...currentLogs.map(row => Number(row.id.replace('fabricated-event-', ''))))))
                .toBe(expectedMaximum);
            await expect.poll(() => page.evaluate(() => historyRead === null)).toBe(true);
            const after = await anchor(page);
            expect(after.id).toBe(before.id);
            expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
            const timing = await page.evaluate(() => ({ ...window.logPageTimings, pages: logPages.length,
                prefetchedRows: prefetchedPage?.result.entries.length || 0, hasNewer: Boolean(previousCursor) }));
            expect(timing.rows).toBeLessThanOrEqual(600);
            expect(timing.pages).toBeLessThanOrEqual(3);
            expect(timing.prefetchedRows).toBeLessThanOrEqual(200);
            expect(timing.renderMilliseconds).toBeLessThan(2000);
            const updateMilliseconds = Date.now() - started;
            expect(updateMilliseconds).toBeLessThan(2000);
            samples.push({ direction, ...timing, updateMilliseconds });
        }
        // First fill then repeatedly evict the newer end of the fixed-size window.
        for (let pageIndex = 1; pageIndex <= 6; pageIndex++) {
            const expectedMaximum = 1599 - Math.max(0, pageIndex - 2) * 200;
            await scrollOlder(page, tail);
            const before = await anchor(page);
            await expect.poll(() => page.evaluate(() => pageCursor)).toContain(`:${pageIndex * 200}`);
            const after = await anchor(page);
            expect(after.id).toBe(before.id);
            expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
            expect(await page.evaluate(() => Math.max(...currentLogs.map(row => Number(row.id.replace('fabricated-event-', '')))))).toBe(expectedMaximum);
            expect(await page.locator('.log-row').count()).toBeLessThanOrEqual(600);
        }
        // Keep a loaded selection while scrolling; reaching latest must follow
        // even with Event detail still open, without discarding its exact payload.
        const selected = await anchor(page);
        await page.locator(`[data-log-id="${selected.id}"]`).click();
        await page.locator('#tab-raw').click();
        const raw = await page.locator('#details-pane pre.raw-source-text').textContent();
        fixture.append(25); await page.evaluate(() => refreshLogs());
        // Restoring intermediate pages must not jump straight to the new live head.
        for (let pageIndex = 3; pageIndex >= 0; pageIndex--) await move('newer', 1599 - pageIndex * 200);
        expect(await page.evaluate(() => followingLatest)).toBe(false);
        // Reverse again: pages evicted from the older end must reload as well.
        await move('older', 1399); await move('older', 1199);
        await move('newer', 1399); await move('newer', 1599);
        await scrollOlder(page, tail === 'top' ? 'bottom' : 'top');
        await expect(page.locator('#view-state')).toContainText('Following latest');
        await expect(page.locator('[data-log-id="fabricated-event-1624"]')).toHaveCount(1);
        expect(await page.locator('#details-pane pre.raw-source-text').textContent()).toBe(raw);
        fixture.append(10); await page.evaluate(() => refreshLogs());
        await expect(page.locator('[data-log-id="fabricated-event-1634"]')).toHaveCount(1);
        await expect(page.locator('#view-state')).toContainText('Following latest');
        expect(fixture.reads.filter(read => read.cursor).length).toBeGreaterThanOrEqual(14);
        await testInfo.attach('scroll-latency-and-bounds', { body: JSON.stringify({ order, tail, samples }), contentType: 'application/json' });
    });
}

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) {
    test(`Logs real byte cursors reload both edges without moving the visible anchor in ${order}/${tail} @smoke`, async ({ page }, testInfo) => {
        // This uses the owned HTTP fixture's actual JSONL files and reader. No
        // route interception substitutes the bidirectional cursor implementation.
        await page.addInitScript(({ order, tail }) => {
            localStorage.setItem('unifiedLogOrderMode', order);
            localStorage.setItem('unifiedLogTailPosition', tail);
        }, { order, tail });
        await page.goto(`${base}/logs-view?diagnostics=true`);
        await expect(page.locator('.log-row').first()).toBeVisible();
        await page.evaluate(() => holdReading());
        const samples = [];
        /** A continuation changes the bound at the requested logical edge. */
        async function load(direction) {
            const bound = await page.evaluate(direction => direction === 'older' ? nextCursor : previousCursor, direction);
            expect(bound).toBeTruthy();
            await scrollOlder(page, direction === 'older' ? tail : tail === 'top' ? 'bottom' : 'top');
            const before = await anchor(page);
            const started = Date.now();
            await expect.poll(() => page.evaluate(direction => direction === 'older' ? nextCursor : previousCursor, direction)).not.toBe(bound);
            const after = await anchor(page);
            expect(after.id).toBe(before.id);
            expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
            const elapsed = Date.now() - started;
            expect(elapsed).toBeLessThan(2000);
            const state = await page.evaluate(() => ({ rows: currentLogs.length, pages: logPages.length, responseBytes: window.logPageTimings.responseBytes }));
            expect(state.rows).toBeLessThanOrEqual(600); expect(state.pages).toBeLessThanOrEqual(3);
            samples.push({ direction, elapsed, ...state });
        }
        for (let index = 0; index < 5; index++) await load('older');
        expect(await page.evaluate(() => Boolean(previousCursor))).toBe(true);
        for (let index = 0; index < 2; index++) await load('newer');
        await load('older'); await load('newer');
        // The forward reader can fill a different byte-bounded page from the
        // reverse reader. Follow its actual boundary, rather than assuming counts.
        let scans = 0;
        while (await page.evaluate(() => Boolean(previousCursor))) {
            await load('newer');
            expect(++scans).toBeLessThan(20);
        }
        await scrollOlder(page, tail === 'top' ? 'bottom' : 'top');
        await expect.poll(() => page.evaluate(() => followingLatest)).toBe(true);
        await expect(page.locator('#view-state')).toContainText('Following latest');
        await page.locator('#follow-latest').click();
        await expect(page.locator('#view-state')).toContainText('Following latest');
        await expect(page.locator('#footer-hint')).toHaveCount(0);
        await testInfo.attach('real-bidirectional-byte-pages', { body: JSON.stringify({ order, tail, samples }), contentType: 'application/json' });
    });
}

test('Logs prefetch stays bounded, leaves rows steady, and can retry a failed history request @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page, { count: 1000 });
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await scrollOlder(page, 'top', 600);
    const before = await anchor(page);
    await expect.poll(() => page.evaluate(() => Boolean(prefetchedPage))).toBe(true);
    await expect(page.locator('.log-row')).toHaveCount(200);
    expect(await anchor(page)).toEqual(before);
    const count = fixture.reads.length;
    await page.waitForTimeout(450);
    expect(fixture.reads.length).toBe(count);
    await scrollOlder(page, 'top');
    await expect(page.locator('.log-row')).toHaveCount(400);
    let failures = 0;
    fixture.pageResponder = async (route, params) => {
        if (!params.has('cursor') || failures++) return false;
        await route.fulfill({ status: 503, json: { error: 'Synthetic continuation failure' } });
        return true;
    };
    // Leave one pixel of travel toward the failed older boundary for the retry.
    await scrollOlder(page, 'top', 1);
    await expect(page.locator('#log-status')).toContainText('Scroll to retry');
    const held = await anchor(page);
    const failedCount = fixture.reads.length;
    await page.waitForTimeout(450);
    expect(fixture.reads.length).toBe(failedCount);
    // A real downward movement retries the older cursor. Moving up would instead
    // reverse direction; input at the exact bottom would produce no scroll.
    await page.locator('#log-list').hover();
    await page.mouse.wheel(0, 1);
    await expect(page.locator('.log-row')).toHaveCount(600);
    const recovered = await anchor(page);
    expect(recovered.id).toBe(held.id);
    expect(Math.abs(recovered.offset - held.offset)).toBeLessThanOrEqual(1);
});

test('Logs scans empty filtered pages automatically, preserves filters, and stops at EOF @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    fixture.pageResponder = async (route, params) => {
        const offset = Number(params.get('cursor')?.replace('sparse-', '') || 0);
        await route.fulfill({ json: { entries: offset === 4 ? [event(3)] : [],
            nextCursor: offset < 4 ? `sparse-${offset + 1}` : null, bytesRead: 1048576,
            coverage: { state: 'partial', rowLimit: 200, reasons: ['filtered-view', 'read-budget'] } } });
        return true;
    };
    await page.goto(`${base}/logs-view?role=doctor&method=GET&status=200&diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(1);
    expect(await page.evaluate(() => nextCursor)).toBe(null);
    expect(fixture.reads).toHaveLength(5);
    for (const read of fixture.reads) {
        expect(read.role).toBe('doctor'); expect(read.method).toBe('GET');
        expect(read.status).toBe('200'); expect(read.diagnostics).toBe('false');
    }
    await page.waitForTimeout(450);
    expect(fixture.reads).toHaveLength(5);
    expect(await page.evaluate(() => logPages.length)).toBeLessThanOrEqual(3);
});

test('Logs filter change and Jump to latest discard delayed continuation responses @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page, { count: 1000 });
    let release;
    fixture.pageResponder = async (route, params) => {
        const cursor = params.get('cursor');
        if (!cursor || cursor.startsWith('live@') || cursor.split(':')[1] === '0') return false;
        await new Promise(resolve => { release = resolve; });
        await route.fulfill({ json: { entries: [event(99999)], nextCursor: null } }).catch(() => {});
        return true;
    };
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await scrollOlder(page, 'top');
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.locator('#follow-latest').click();
    release(); release = null;
    await expect(page.locator('#view-state')).toContainText('Following latest');
    await expect(page.locator('[data-log-id="fabricated-event-99999"]')).toHaveCount(0);
    await scrollOlder(page, 'top');
    await expect.poll(() => Boolean(release)).toBe(true);
    // Use the real filter handler while a continuation is pending.
    await page.evaluate(() => { document.getElementById('filter-role').value = 'doctor'; applyFilters(null); });
    release();
    await expect(page.locator('#filter-summary')).toContainText('Role: doctor');
    await expect(page.locator('.log-row')).toHaveCount(200);
    await expect(page.locator('[data-log-id="fabricated-event-99999"]')).toHaveCount(0);
    expect(await page.evaluate(() => currentLogs.every(row => row.details.role === 'doctor'))).toBe(true);
});

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) for (const entry of ['scroll', 'jump']) {
    test(`Logs continuous catch-up ${entry} covers large bursts and later appends in ${order}/${tail} @smoke`, async ({ page }, testInfo) => {
        const fixture = await installWorkbenchFixture(page, { count: 1200 });
        await page.addInitScript(({ order, tail }) => {
            localStorage.setItem('unifiedLogOrderMode', order);
            localStorage.setItem('unifiedLogTailPosition', tail);
        }, { order, tail });
        let appended = false;
        await page.exposeBinding('appendDuringCatchup', () => { if (!appended) { appended = true; fixture.append(350); } });
        await page.goto(`${base}/logs-view?diagnostics=false`);
        await expect(page.locator('.log-row')).toHaveCount(200);
        await page.locator('.log-row').nth(15).click();
        await page.locator('#tab-raw').click();
        const raw = await page.locator('#details-pane pre.raw-source-text').textContent();
        await page.evaluate(() => {
            window.catchupSamples = [];
            const original = applyHistoryPage;
            applyHistoryPage = function (result, cursor, direction, follow) {
                const accepted = original(result, cursor, direction, follow);
                if (accepted && direction === 'newer') {
                    const numbers = (result.entries || []).map(row => Number(row.id.replace('fabricated-event-', ''))).filter(number => number >= 1200);
                    if (numbers.length) {
                        window.catchupSamples.push({ numbers, rows: currentLogs.length, pages: logPages.length, render: window.logPageTimings.renderMilliseconds });
                        void window.appendDuringCatchup();
                    }
                }
                return accepted;
            };
        });
        await expect.poll(() => page.evaluate(() => activeRead === null && !restoringScroll)).toBe(true);
        await scrollOlder(page, tail === 'top' ? 'bottom' : 'top', 400);
        fixture.append(1300);
        const before = await anchor(page);
        await page.evaluate(() => refreshLogs());
        expect(await anchor(page)).toEqual(before);
        expect(await page.locator('#details-pane pre.raw-source-text').textContent()).toBe(raw);
        if (entry === 'jump') await page.locator('#follow-latest').click();
        else {
            await scrollOlder(page, tail === 'top' ? 'bottom' : 'top');
            await page.locator('#log-list').hover();
            await page.mouse.wheel(0, tail === 'top' ? -20 : 20);
        }
        try { await expect(page.locator('[data-log-id="fabricated-event-2499"]')).toHaveCount(1); }
        catch (error) {
            await testInfo.attach('catchup-failure-state', { body: JSON.stringify(await page.evaluate(() => ({ followingLatest, catchingUp, liveFailure, historyDirection, previousCursor, nextCursor, liveAnchor, active: Boolean(activeRead), history: Boolean(historyRead), prefetchedPage, canEvict: canEvictPage('newer'), top: document.getElementById('log-list').scrollTop, edge: historyEdgeDistance('newer'), focused: document.activeElement?.outerHTML?.slice(0, 300), pages: logPages.map(page => ({ first: page.entries[0]?.id, last: page.entries.at(-1)?.id })), applied: window.catchupSamples.map(sample => sample.numbers.length) }))), contentType: 'application/json' });
            throw error;
        }
        await expect(page.locator('#view-state')).toHaveText('Following latest');
        expect(appended).toBe(true);
        const first = await page.evaluate(() => window.catchupSamples.flatMap(sample => sample.numbers));
        expect(first).toHaveLength(1300);
        expect(new Set(first).size).toBe(1300);
        expect([...first].sort((a, b) => a - b)).toEqual(Array.from({ length: 1300 }, (_, index) => index + 1200));
        // Records appended during the finite first target belong to the next
        // interval, which must also be drained rather than replaced by its head.
        await page.evaluate(() => refreshLogs());
        await expect(page.locator('[data-log-id="fabricated-event-2849"]')).toHaveCount(1);
        await expect(page.locator('#view-state')).toHaveText('Following latest');
        const samples = await page.evaluate(() => window.catchupSamples);
        const all = samples.flatMap(sample => sample.numbers);
        expect(all).toHaveLength(1650); expect(new Set(all).size).toBe(1650);
        expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 1650 }, (_, index) => index + 1200));
        expect(samples.every(sample => sample.rows <= 600 && sample.pages <= 3 && sample.render < 2000)).toBe(true);
        expect(await page.locator('#details-pane pre.raw-source-text').textContent()).toBe(raw);
        await expect(page.locator('#selection-state')).toBeVisible();
        await expect(page.locator('#scope-strip #log-status, #scope-strip #page-coverage')).toHaveCount(0);
        await page.locator('[data-open-panel="tools"]').click();
    await page.locator('[data-panel-tab="coverage"]').click();
        await expect(page.locator('#page-coverage')).toBeVisible();
        await page.locator('#close-workbench').click();
        await page.locator('[data-open-panel="tools"]').click();
        await page.locator('#viewer-diagnostics > summary').click();
        await expect(page.locator('#log-status')).toBeVisible();
        await testInfo.attach('catchup-continuity', { body: JSON.stringify({ order, tail, entry, uniqueNewEvents: new Set(all).size, pages: samples.length, maxRows: Math.max(...samples.map(sample => sample.rows)), maxRender: Math.max(...samples.map(sample => sample.render)) }), contentType: 'application/json' });
    });
}

for (const tail of ['top', 'bottom']) test(`Logs Jump drains a finite interval and automatic following checks the next interval in ${tail} @smoke`, async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.addInitScript(tail => localStorage.setItem('unifiedLogTailPosition', tail), tail);
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await page.evaluate(() => holdReading());
    let appended = false;
    await page.exposeBinding('appendDuringDrain', () => { if (!appended) { appended = true; fixture.append(50); } });
    await page.evaluate(() => {
        window.acceptedIds = [];
        const original = applyHistoryPage;
        applyHistoryPage = function (result, cursor, direction, follow) {
            const accepted = original(result, cursor, direction, follow);
            if (accepted && direction === 'newer') {
                const ids = result.entries.filter(row => Number(row.id.replace('fabricated-event-', '')) >= 400).map(row => row.id);
                if (ids.length) { window.acceptedIds.push(...ids); void window.appendDuringDrain(); }
            }
            return accepted;
        };
    });
    fixture.append(650);
    await page.locator('#follow-latest').click();
    await expect(page.locator('[data-log-id="fabricated-event-1049"]')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => !catchingUp && activeRead === null)).toBe(true);
    await expect(page.locator('#view-state')).toHaveText('Following latest');
    await expect(page.locator('[data-log-id="fabricated-event-1099"]')).toHaveCount(0);
    const reads = fixture.reads.length;
    await page.waitForTimeout(400);
    expect(fixture.reads.length).toBe(reads);
    await page.evaluate(() => refreshLogs());
    await expect(page.locator('[data-log-id="fabricated-event-1099"]')).toHaveCount(1);
    const ids = await page.evaluate(() => window.acceptedIds);
    expect(ids).toHaveLength(700); expect(new Set(ids).size).toBe(700);
});

test('Logs catch-up error retains its checkpoint, warns in the compact bar and retries without skipping @smoke', async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await expect.poll(() => page.evaluate(() => activeRead === null)).toBe(true);
    const before = await page.evaluate(() => ({ anchor: liveAnchor.liveCursor, ids: currentLogs.map(row => row.id) }));
    fixture.append(700); fixture.failure = { status: 503, message: 'Synthetic catch-up source unavailable' };
    await page.evaluate(() => refreshLogs());
    await expect(page.locator('#monitor-status')).toContainText('Catch-up stopped');
    expect(await page.evaluate(() => liveAnchor.liveCursor)).toBe(before.anchor);
    expect(await page.evaluate(() => currentLogs.map(row => row.id))).toEqual(before.ids);
    await expect(page.locator('#log-status')).not.toBeVisible();
    await page.locator('[data-open-panel="tools"]').click();
    await page.locator('[data-panel-tab="coverage"]').click();
    await expect(page.locator('#log-status')).toContainText('Synthetic catch-up source unavailable');
    await page.locator('#close-workbench').click();
    fixture.failure = null;
    await page.locator('#follow-latest').click();
    await expect(page.locator('[data-log-id="fabricated-event-1099"]')).toHaveCount(1);
    await expect(page.locator('#view-state')).toHaveText('Following latest');
    await expect(page.locator('#monitor-status')).not.toBeVisible();
});

for (const order of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) test(`Logs live catch-up keeps a keyboard target when its selected row is evicted in ${order}/${tail} @smoke`, async ({ page }) => {
    const fixture = await installWorkbenchFixture(page);
    await page.addInitScript(({ order, tail }) => {
        localStorage.setItem('unifiedLogOrderMode', order); localStorage.setItem('unifiedLogTailPosition', tail);
    }, { order, tail });
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    const row = page.locator('.log-row').nth(15);
    await row.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
    await page.locator('.log-row.selected').focus();
    fixture.append(900);
    // Native keyboard navigation leaves focus on that row while returning to
    // the live edge. The cache must not stall behind its offscreen focus owner.
    await page.keyboard.press(tail === 'top' ? 'Home' : 'End');
    await expect(page.locator('[data-log-id="fabricated-event-1299"]')).toHaveCount(1);
    await expect(page.locator('#view-state')).toHaveText('Following latest');
    await expect(page.locator('#log-list')).toBeFocused();
    await expect(page.locator('#selection-state')).toBeVisible();
    expect(await page.locator('.log-row').count()).toBeLessThanOrEqual(600);
});
