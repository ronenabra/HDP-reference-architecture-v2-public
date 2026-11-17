'use strict';

/** Actual browser interaction coverage for the independently collapsible bottom
 * Event pane. All injected records are synthetic; the view/assets are real.
 */
const { test, expect } = require('@playwright/test');
const { installWorkbenchFixture, event } = require('./logs-workbench-fixture');
const { installPointerRecorder, checkpointPointer, attachPointerEvidence } = require('./logs-pointer-recorder');
const base = process.env.PCM_OPS_FIXTURE_URL;
test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!base, 'requires the owned operator fixture');
    if (/splitter/.test(testInfo.title)) await installPointerRecorder(page);
});
test.afterEach(async ({ page }, testInfo) => {
    if (/splitter/.test(testInfo.title) && !page.isClosed()) await attachPointerEvidence(page, testInfo);
});

async function openEvent(page, index = 20) {
    await page.locator('.log-row').nth(index).click();
    await expect(page.locator('#event-detail')).toBeVisible();
    await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
}
async function boot(page) {
    const fixture = await installWorkbenchFixture(page);
    await page.goto(`${base}/logs-view?diagnostics=false`);
    await expect(page.locator('.log-row')).toHaveCount(200);
    await openEvent(page);
    return fixture;
}
async function geometry(page) {
    return page.evaluate(() => {
        const rect = id => { const { x, y, width, height } = document.getElementById(id).getBoundingClientRect(); return { x, y, width, height }; };
        const list = document.getElementById('log-list');
        return { list: rect('log-list'), detail: rect('event-detail'), splitter: rect('resizer'), metadata: rect('event-metadata'),
            sidebar: rect('workbench'), percentage: Number(document.getElementById('resizer').getAttribute('aria-valuenow')),
            scroll: list.scrollTop, selected: document.querySelector('.log-row.selected')?.dataset.logId,
            focused: document.activeElement?.id || document.activeElement?.className };
    });
}
async function mouseDrag(page, deltaY) {
    await checkpointPointer(page, `drag ${deltaY}: before move`);
    const rect = await page.locator('#resizer').boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await checkpointPointer(page, `drag ${deltaY}: reentered`);
    await page.mouse.down();
    await checkpointPointer(page, `drag ${deltaY}: down`);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2 + deltaY, { steps: 8 });
    await checkpointPointer(page, `drag ${deltaY}: moved`);
    await page.mouse.up();
    await checkpointPointer(page, `drag ${deltaY}: released`);
}

test('Logs bottom Event and upper sidebar close independently with metadata alignment and focus @smoke', async ({ page }, testInfo) => {
    await boot(page);
    await expect(page.locator('#workbench')).toBeHidden();
    const selected = page.locator('.log-row.selected');
    const selectedId = await selected.getAttribute('data-log-id');
    const filter = page.locator('[data-open-panel="filters"]');
    await filter.click();
    await expect(page.locator('#workbench')).toBeVisible();
    await expect(page.locator('#event-detail')).toBeVisible();
    if (page.viewportSize().width >= 768) {
        const layout = await geometry(page);
        expect(Math.abs(layout.sidebar.x - layout.metadata.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.sidebar.width - layout.metadata.width)).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#workbench')).toBeHidden();
    await expect(filter).toBeFocused();
    await expect(page.locator('#event-metadata')).toBeVisible();
    await expect(page.locator('#event-metadata')).toContainText(decodeURIComponent(selectedId));
    await filter.click();
    // Closing Event must not implicitly close an explicitly opened tools sidebar.
    if (page.viewportSize().width >= 768) await page.locator('#close-event-detail').click();
    else {
        // The narrow sidebar is modal, so dismiss it before reaching Event.
        await page.locator('#close-workbench').click();
        await page.locator('#close-event-detail').click();
        await filter.click();
    }
    await expect(page.locator('#event-detail')).toBeHidden();
    await expect(page.locator('#workbench')).toBeVisible();
    await page.locator('#close-workbench').click();
    await page.locator('#toggle-event-detail').click();
    await expect(page.locator('#event-detail')).toBeVisible();
    await page.locator('#tab-json').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#event-detail')).toBeHidden();
    await expect(page.locator('#toggle-event-detail')).toBeFocused();
    await selected.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute('data-log-id', selectedId);
    await testInfo.attach('independent-pane-geometry', { body: JSON.stringify(await geometry(page)), contentType: 'application/json' });
});

test('Logs horizontal Event splitter supports pointer and keyboard bounds without losing held reading @smoke', async ({ page }, testInfo) => {
    const fixture = await boot(page);
    const split = page.locator('#resizer');
    await expect(split).toHaveAttribute('aria-orientation', 'horizontal');
    const minimum = Number(await split.getAttribute('aria-valuemin'));
    expect(minimum).toBeGreaterThanOrEqual(25);
    expect(minimum).toBeLessThan(70);
    await expect(split).toHaveAttribute('aria-valuemax', '70');
    await split.focus();
    for (const [key, value] of [['Home', String(minimum)], ['ArrowUp', String(minimum + 5)], ['ArrowDown', String(minimum)], ['End', '70'], ['ArrowUp', '70']]) {
        await page.keyboard.press(key);
        await expect(split).toHaveAttribute('aria-valuenow', value);
        await expect(split).toBeFocused();
    }
    await page.keyboard.press('Home');
    await page.locator('#log-list').evaluate(node => { node.scrollTop = 500; });
    const initial = await geometry(page);
    await mouseDrag(page, -70);
    const grown = await geometry(page);
    expect(grown.detail.height).toBeGreaterThan(initial.detail.height + 20);
    expect(grown.percentage).toBeGreaterThan(initial.percentage);
    expect(grown.scroll).toBe(initial.scroll);
    expect(grown.selected).toBe(initial.selected);
    await mouseDrag(page, 50);
    const shrunk = await geometry(page);
    expect(shrunk.detail.height).toBeLessThan(grown.detail.height);
    await mouseDrag(page, -2000);
    await expect(split).toHaveAttribute('aria-valuenow', '70');
    await mouseDrag(page, 2000);
    await expect(split).toHaveAttribute('aria-valuenow', String(minimum));
    await expect(split).not.toHaveClass(/resizing/);
    await split.focus();
    const beforePoll = await geometry(page);
    fixture.append(240);
    await page.evaluate(() => refreshLogs());
    const afterPoll = await geometry(page);
    expect(afterPoll).toEqual(beforePoll);
    await testInfo.attach('splitter-pointer-geometry', { body: JSON.stringify({ initial, grown, shrunk, beforePoll, afterPoll }), contentType: 'application/json' });
});

test('Logs splitter native in-viewport bounds and off-viewport release reentry remain separate @smoke', async ({ page }, testInfo) => {
    await boot(page);
    const split = page.locator('#resizer');
    const minimum = await split.getAttribute('aria-valuemin');
    // These two native gestures stay within the viewport; they do not rely on
    // an automation engine delivering release coordinates outside its surface.
    let rect = await split.boundingBox();
    await mouseDrag(page, 12 - (rect.y + rect.height / 2));
    await expect(split).toHaveAttribute('aria-valuenow', '70');
    expect(await checkpointPointer(page, 'in-viewport upper bound released')).toMatchObject({ resizing: false, hasPointerCapture: false, controllerPointerId: null });
    rect = await split.boundingBox();
    await mouseDrag(page, page.viewportSize().height - 12 - (rect.y + rect.height / 2));
    await expect(split).toHaveAttribute('aria-valuenow', minimum);
    expect(await checkpointPointer(page, 'in-viewport lower bound released')).toMatchObject({ resizing: false, hasPointerCapture: false, controllerPointerId: null });
    // Retain explicit outside-surface release checks, independently of the
    // original regression above. Re-entry with no buttons must not resize.
    for (const [delta, expected] of [[-2000, '70'], [2000, minimum]]) {
        await mouseDrag(page, delta);
        await expect(split).toHaveAttribute('aria-valuenow', expected);
        expect(await checkpointPointer(page, `off-viewport ${delta} release terminal`)).toMatchObject({ resizing: false, hasPointerCapture: false, controllerPointerId: null });
        const before = await geometry(page);
        rect = await split.boundingBox();
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        expect(await geometry(page)).toEqual(before);
        expect(await checkpointPointer(page, `off-viewport ${delta} reentry terminal`)).toMatchObject({ resizing: false, hasPointerCapture: false, controllerPointerId: null });
    }
    await testInfo.attach('input-scope', { body: 'Native Playwright mouse input; original extreme-drag regression retained without changed coordinates or assertions.', contentType: 'text/plain' });
});

test('Logs splitter recovers deliberately dropped release on native buttons-zero reentry and synthetic blur @smoke', async ({ page }, testInfo) => {
    // Fault injection deliberately withholds two terminal DOM notifications.
    // This is resilience coverage, not evidence of Firefox event delivery.
    await page.addInitScript(() => {
        for (const type of ['pointerup', 'lostpointercapture']) window.addEventListener(type, event => {
            if (window.qaDropTerminalPointerEvents) event.stopImmediatePropagation();
        }, true);
    });
    await boot(page);
    const split = page.locator('#resizer');
    await split.focus(); await page.keyboard.press('Home');
    let rect = await split.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2, rect.y - 65, { steps: 4 });
    await page.evaluate(() => { window.qaDropTerminalPointerEvents = true; });
    await page.mouse.up();
    const stale = await checkpointPointer(page, 'deliberately suppressed terminal delivery');
    expect(stale.resizing).toBe(true);
    expect(stale.controllerPointerId).not.toBeNull();
    await page.evaluate(() => { window.qaDropTerminalPointerEvents = false; });
    const beforeReentry = await geometry(page);
    // Native motion carries buttons=0 after the real mouse release. Recovery
    // must happen before any resize, even when its target is outside divider.
    await page.mouse.move(20, 20);
    const recovered = await checkpointPointer(page, 'native buttons-zero recovery');
    expect(recovered).toMatchObject({ resizing: false, hasPointerCapture: false, controllerPointerId: null });
    expect(await geometry(page)).toEqual(beforeReentry);
    rect = await split.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    const starting = await geometry(page);
    await page.mouse.move(rect.x + rect.width / 2, rect.y - 55, { steps: 4 });
    expect((await geometry(page)).percentage).toBeGreaterThan(starting.percentage);
    // A dispatched blur tests the DOM cancellation handler only, not native
    // window-manager focus behavior. Its untrusted flag is recorded in trace.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await checkpointPointer(page, 'synthetic window blur cancellation')).toMatchObject({ resizing: false, hasPointerCapture: false, controllerPointerId: null });
    expect((await geometry(page)).percentage).toBe(starting.percentage);
    await page.mouse.up();
    await testInfo.attach('fault-injection-scope', { body: 'Dropped pointerup/lostpointercapture via test-only event interception; real mouse reentry. Blur is synthetic DOM dispatch. No Firefox delivery inference.', contentType: 'text/plain' });
});

test('Logs horizontal Event splitter accepts native Chromium touch drag and cancellation @smoke', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Native touch input qualification uses Chromium CDP; other profiles retain real mouse coverage');
    await boot(page);
    const session = await page.context().newCDPSession(page);
    const touch = async (type, x, y) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 7, radiusX: 4, radiusY: 4, force: 1 }] });
    const split = page.locator('#resizer');
    await split.focus();
    await page.keyboard.press('Home');
    const initial = await geometry(page);
    let rect = await split.boundingBox();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await touch('touchStart', x, y);
    await touch('touchMove', x, y - 70);
    await touch('touchEnd');
    const grown = await geometry(page);
    expect(grown.detail.height).toBeGreaterThan(initial.detail.height + 20);
    expect(grown.selected).toBe(initial.selected);
    await expect(split).not.toHaveClass(/resizing/);
    rect = await split.boundingBox();
    await touch('touchStart', x, rect.y + rect.height / 2);
    await touch('touchMove', x, rect.y + rect.height / 2 + 30);
    await touch('touchCancel');
    await expect(split).not.toHaveClass(/resizing/);
    const cancelled = await geometry(page);
    expect(cancelled.percentage).toBe(grown.percentage);
    await page.mouse.move(10, 10);
    expect((await geometry(page)).percentage).toBe(cancelled.percentage);
    await session.detach();
    await testInfo.attach('splitter-native-touch', { body: JSON.stringify({ initial, grown, cancelled }), contentType: 'application/json' });
});

test('Logs Structured and Raw tabs preserve independent scroll and exact safe source text @smoke', async ({ page }, testInfo) => {
    // Qualify button behavior with a controlled clipboard response, without granting
    // clipboard permissions or claiming native OS clipboard integration.
    await page.addInitScript(() => {
        window.qaCopies = [];
        const command = document.execCommand.bind(document);
        document.execCommand = (...args) => window.qaCopyFails && args[0] === 'copy' ? false : command(...args);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
            if (window.qaCopyFails) throw new Error('Synthetic clipboard denial');
            window.qaCopies.push(text);
        } } });
    });
    await boot(page);
    const structuredTab = page.locator('#tab-json'), rawTab = page.locator('#tab-raw');
    const structured = page.locator('#panel-json pre[data-help-key="logs.payload"]'), raw = page.locator('#panel-raw pre.raw-source-text');
    const selectedId = decodeURIComponent(await page.locator('.log-row.selected').getAttribute('data-log-id'));
    const index = Number(selectedId.replace('fabricated-event-', ''));
    await expect(structuredTab).toHaveAttribute('aria-selected', 'true');
    await expect(rawTab).toHaveAttribute('tabindex', '-1');
    const payload = JSON.parse(await structured.textContent());
    expect(payload.details.payload).toBe('Fabricated safe payload <script>never run</script>\r\n'.repeat(90));
    await structured.evaluate(node => { node.scrollTop = 180; node.scrollLeft = 110; });
    const structuredScroll = await structured.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }));
    expect(structuredScroll.top + structuredScroll.left).toBeGreaterThan(0);
    await structuredTab.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(rawTab).toBeFocused();
    await expect(rawTab).toHaveAttribute('aria-selected', 'true');
    await expect(structured).toBeHidden();
    await expect(raw).toBeVisible();
    const exactRaw = `Fabricated exact source ${index}\r\n` + 'raw text stays stable\t<>&\r\n'.repeat(100);
    expect(await raw.textContent()).toBe(exactRaw);
    await raw.evaluate(node => { node.scrollTop = 240; });
    const rawScroll = await raw.evaluate(node => node.scrollTop);
    expect(rawScroll).toBeGreaterThan(0);
    await page.locator('#tab-raw').focus();
    await page.keyboard.press('Home');
    await expect(structuredTab).toBeFocused();
    expect(await structured.evaluate(node => ({ top: node.scrollTop, left: node.scrollLeft }))).toEqual(structuredScroll);
    await page.keyboard.press('End');
    await expect(rawTab).toBeFocused();
    expect(await raw.evaluate(node => node.scrollTop)).toBe(rawScroll);
    await page.keyboard.press('Home');
    await expect(structuredTab).toBeFocused();
    await expect(page.locator('#details-pane script')).toHaveCount(0);
    await expect(page.locator('#event-metadata')).toContainText(selectedId);
    await page.locator('#copy-detail').click();
    expect(await page.evaluate(() => window.qaCopies.at(-1))).toBe(await structured.textContent());
    await rawTab.click();
    await page.locator('#copy-detail').click();
    expect(await page.evaluate(() => window.qaCopies.at(-1))).toBe(exactRaw);
    const beforeWrap = await raw.evaluate(node => getComputedStyle(node).whiteSpace);
    await page.locator('#wrap-detail').click();
    expect(await raw.evaluate(node => getComputedStyle(node).whiteSpace)).not.toBe(beforeWrap);
    expect(await raw.textContent()).toBe(exactRaw);
    await page.locator('#wrap-detail').click();
    expect(await raw.evaluate(node => getComputedStyle(node).whiteSpace)).toBe(beforeWrap);
    await page.evaluate(() => { window.qaCopyFails = true; });
    await page.locator('#copy-detail').click();
    await expect(page.locator('#detail-status')).toContainText('Automatic copy was blocked');
    await expect(page.locator('#manual-copy-text')).toHaveValue(exactRaw.replace(/\r\n?/g, '\n')); // Native textarea newline normalization.
    await expect(page.locator('#manual-copy')).toBeVisible();
    expect(await raw.textContent()).toBe(exactRaw);
    await testInfo.attach('independent-tab-scroll', { body: JSON.stringify({ structuredScroll, rawScroll, exactRawCharacters: exactRaw.length }), contentType: 'application/json' });
});

test('Logs Event size survives selection, close and reload and clamps across viewport changes @smoke', async ({ page }, testInfo) => {
    await boot(page);
    const originalViewport = page.viewportSize();
    const split = page.locator('#resizer');
    await split.focus();
    await page.keyboard.press('End');
    const selectedSize = await split.getAttribute('aria-valuenow');
    await page.locator('.log-row').nth(23).click();
    await expect(page.locator('#panel-json pre[data-help-key="logs.payload"]')).toBeVisible();
    await expect(split).toHaveAttribute('aria-valuenow', selectedSize);
    await page.locator('#close-event-detail').click();
    await page.locator('#toggle-event-detail').click();
    await expect(split).toHaveAttribute('aria-valuenow', selectedSize);
    const sizes = [];
    for (const viewport of [{ width: 390, height: 600 }, { width: 1024, height: 600 }, { width: 1440, height: 1050 }, originalViewport]) {
        await page.setViewportSize(viewport);
        const size = await geometry(page); sizes.push({ viewport, ...size });
        expect(size.percentage).toBeGreaterThanOrEqual(25);
        expect(size.percentage).toBeLessThanOrEqual(70);
        expect(size.list.height).toBeGreaterThanOrEqual(60);
        expect(size.detail.height).toBeGreaterThanOrEqual(80);
        expect(size.detail.y + size.detail.height).toBeLessThanOrEqual(viewport.height + 1);
        expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
        await expect(page.locator('#close-event-detail')).toBeInViewport();
        await expect(split).toBeInViewport();
    }
    await page.reload();
    await expect(page.locator('.log-row')).toHaveCount(200);
    await expect(page.locator('#event-detail')).toBeHidden();
    await openEvent(page);
    await expect(split).toHaveAttribute('aria-valuenow', selectedSize);
    const preferences = await page.evaluate(() => Object.entries(localStorage));
    expect(JSON.stringify(preferences)).not.toContain('Fabricated safe payload');
    expect(JSON.stringify(preferences)).not.toContain('raw text stays stable');
    await testInfo.attach('viewport-clamping', { body: JSON.stringify(sizes), contentType: 'application/json' });
});

test('Logs closed Event retains Raw scroll through filter navigation and Back then reopen @smoke', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-raw').click();
    const raw = page.locator('#panel-raw pre.raw-source-text');
    await raw.evaluate(node => { node.scrollTop = 180; });
    const before = await raw.evaluate(node => ({ text: node.textContent, scroll: node.scrollTop }));
    expect(before.scroll).toBeGreaterThan(0);
    const metadata = page.locator('#event-metadata-body'), eventPane = page.locator('#event-detail');
    await metadata.focus();
    await metadata.evaluate(node => { node.scrollTop = 120; });
    if (page.viewportSize().width < 768) await eventPane.evaluate(node => { node.scrollTop = 300; });
    const savedMetadataScroll = await metadata.evaluate(node => node.scrollTop);
    const savedEventScroll = await eventPane.evaluate(node => node.scrollTop);
    if (page.viewportSize().width < 768) expect(savedEventScroll).toBeGreaterThan(0);
    else expect(savedMetadataScroll).toBeGreaterThan(0);
    // Escape closes the pane from its current reading position; clicking a
    // scrolled-away header would itself scroll back and invalidate this scenario.
    await page.keyboard.press('Escape');
    await expect(eventPane).toBeHidden();
    await page.locator('[data-open-panel="filters"]').click();
    await page.locator('#filter-role').selectOption('doctor');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.locator('.log-row')).toHaveCount(100);
    await page.locator('#close-workbench').click();
    await page.goBack();
    await expect(page.locator('.log-row')).toHaveCount(200);
    await expect(page.locator('#event-detail')).toBeHidden();
    if (await page.locator('#workbench').isVisible()) await page.locator('#close-workbench').click();
    await page.locator('#toggle-event-detail').click();
    await expect(raw).toBeVisible();
    expect(await raw.evaluate(node => ({ text: node.textContent, scroll: node.scrollTop }))).toEqual(before);
    expect(await metadata.evaluate(node => node.scrollTop)).toBe(savedMetadataScroll);
    expect(await eventPane.evaluate(node => node.scrollTop)).toBe(savedEventScroll);
});

test('Logs minimum Event size keeps source text readable in short investigation viewports @smoke', async ({ page }, testInfo) => {
    const fixture = await boot(page);
    await page.getByRole('link', { name: /^Inspect this flow across roles/ }).click();
    await expect(page.locator('.log-row')).toHaveCount(24);
    await openEvent(page, 2);
    const flowId = await page.evaluate(() => new URLSearchParams(location.search).get('flowId'));
    const firstNew = fixture.entries.length;
    for (let index = 0; index < 750; index++) {
        const row = event(firstNew + index);
        row.details.flowId = flowId; row.event.correlation.flowId = flowId;
        fixture.entries.push(row);
    }
    await page.evaluate(() => refreshLogs());
    await page.locator('#follow-latest').click();
    await expect(page.locator('#selection-state')).toContainText(/outside.*page/i);
    await page.locator('#tab-raw').click();
    const sizes = [];
    for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 600 }]) {
        await page.setViewportSize(viewport);
        await page.locator('#resizer').focus();
        await page.keyboard.press('Home');
        // Very short workspaces may scroll within Event; text must still have
        // a usable rendered box and be reachable through native scrolling.
        await page.locator('#panel-raw pre').scrollIntoViewIfNeeded();
        const size = await page.locator('#panel-raw pre').evaluate(node => {
            const rect = node.getBoundingClientRect();
            let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (style.overflowY !== 'visible') { const clip = parent.getBoundingClientRect(); top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
            }
            return { height: rect.height, visibleHeight: Math.max(0, bottom - top), lineHeight: parseFloat(getComputedStyle(node).lineHeight) };
        });
        sizes.push({ viewport, ...size, ...await geometry(page) });
        expect(size.height).toBeGreaterThanOrEqual(size.lineHeight * 2);
        expect(size.visibleHeight).toBeGreaterThanOrEqual(size.lineHeight * 2);
        await page.screenshot({ path: testInfo.outputPath(`minimum-${viewport.width}x${viewport.height}.png`), fullPage: true });
        await page.locator('#close-event-detail').scrollIntoViewIfNeeded();
        await expect(page.locator('#close-event-detail')).toBeInViewport();
        await expect(page.locator('#resizer')).toBeInViewport();
        expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    }
    await testInfo.attach('short-viewport-minimum', { body: JSON.stringify(sizes), contentType: 'application/json' });
});
