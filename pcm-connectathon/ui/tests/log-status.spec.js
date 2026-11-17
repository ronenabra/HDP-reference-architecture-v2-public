'use strict';
/** Actual authored controls and state transitions; only synthetic read delivery is intercepted. */
const { test, expect } = require('@playwright/test');
const { installWorkbenchFixture } = require('./logs-workbench-fixture');
const base = 'http://127.0.0.1:43180';
/** Native input keeps keyboard and touch Explain behavior covered. */
async function activate(locator, info) { if (info.project.name.endsWith('mobile')) await locator.tap(); else { await locator.focus(); await locator.press('Enter'); } }
/** Close the responsive upper drawer before interacting with the list/status. */
async function close(page) { if (await page.locator('#workbench').isVisible()) await page.locator('#close-workbench').click(); }

for (const mode of ['flow', 'timeline']) for (const tail of ['top', 'bottom']) test(`status indicator is independent of Jump styling and truthful through hold catch-up failure retry ${mode}/${tail}`, async ({ page }, info) => {
    const fixture = await installWorkbenchFixture(page);
    await page.addInitScript(({ mode, tail }) => { localStorage.setItem('unifiedLogOrderMode', mode); localStorage.setItem('unifiedLogTailPosition', tail); }, { mode, tail });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/logs-view?diagnostics=false`); await expect(page.locator('#view-state')).toHaveText('Following latest');
    await expect(page.getByRole('button', { name: 'Group related events', exact: true })).toHaveAttribute('aria-pressed', String(mode === 'flow'));
    await expect(page.locator('#pauseSwitch')).toHaveCount(0); await close(page);
    const jump = page.locator('#follow-latest');
    await jump.hover(); await expect(page.locator('#view-state')).toHaveText('Following latest');
    await page.mouse.move(0, 0); await jump.focus(); await expect(page.locator('#state-cue')).toHaveText('▶');
    expect(await jump.getAttribute('aria-pressed')).toBeNull();
    const line = await page.locator('#scope-strip').evaluate(node => ['reader-indicator', 'filter-summary', 'diagnostic-visibility'].map(id => Math.round(document.getElementById(id).getBoundingClientRect().top)));
    if (!info.project.name.endsWith('mobile')) expect(Math.max(...line) - Math.min(...line)).toBeLessThan(5);
    await page.locator('.log-row').nth(12).click(); await expect(page.locator('#view-state')).toHaveText('Position held');
    await page.locator('#tab-raw').click(); const raw = await page.locator('.raw-source-text').textContent();
    await page.evaluate(tail => { const list = document.querySelector('#log-list'); list.scrollTop = tail === 'top' ? 400 : list.scrollHeight - list.clientHeight - 400; holdReading(); }, tail);
    const before = await page.evaluate(() => ({ id: selectedId, anchor: captureAnchor() }));
    fixture.append(650); await page.evaluate(() => refreshLogs());
    await expect(jump).toContainText('new on page'); await expect(page.locator('#view-state')).toHaveText('Position held');
    expect(await page.evaluate(() => captureAnchor())).toEqual(before.anchor);
    expect(await page.locator('.raw-source-text').textContent()).toBe(raw);
    await jump.hover(); await page.mouse.move(0, 0); await jump.focus(); await expect(page.locator('#state-cue')).toHaveText('Ⅱ');
    let release; fixture.responseGate = new Promise(resolve => { release = resolve; });
    await jump.click(); await expect(page.locator('#view-state')).toHaveText('Loading updates'); await expect(page.locator('#state-cue')).toHaveText('↻');
    fixture.failure = { status: 503, message: 'STATUS synthetic source unavailable' }; fixture.responseGate = null; release();
    await expect(page.locator('#view-state')).toContainText('Updates unavailable'); await expect(page.locator('#state-cue')).toHaveText('!');
    await expect(page.locator('#monitor-status')).toBeVisible(); await jump.hover(); await page.mouse.move(0, 0);
    await expect(page.locator('#view-state')).not.toContainText('Following');
    fixture.failure = null;
    await jump.click(); await expect(page.locator('[data-log-id="fabricated-event-1049"]')).toHaveCount(1);
    await expect(page.locator('#view-state')).toHaveText('Following latest');
    expect(await page.evaluate(() => selectedId)).toBe(before.id); expect(await page.locator('.raw-source-text').textContent()).toBe(raw);
    // User scroll away holds; returning to the true head resumes only after accepted catch-up.
    await page.evaluate(tail => { const list = document.querySelector('#log-list'); list.scrollTop = tail === 'top' ? 250 : list.scrollHeight - list.clientHeight - 250; list.dispatchEvent(new Event('scroll')); }, tail);
    await expect(page.locator('#view-state')).toHaveText('Position held');
    await page.evaluate(tail => { const list = document.querySelector('#log-list'); list.scrollTop = tail === 'top' ? 0 : list.scrollHeight; list.dispatchEvent(new Event('scroll')); }, tail);
    await expect(page.locator('#view-state')).toHaveText('Following latest');
    expect(errors).toEqual([]); await page.screenshot({ path: info.outputPath(`status-${mode}-${tail}.png`) });
});

test('status exact scope and Explain are keyboard-touch accessible with readable narrow enlarged critical notices', async ({ page }, info) => {
    const fixture = await installWorkbenchFixture(page);
    const id = 'exact+/&?=scope-' + 'long-id-'.repeat(30);
    await page.goto(`${base}/logs-view?${new URLSearchParams({ role: 'doctor', correlationId: id, method: 'GET', status: '200' })}`);
    await expect(page.locator('#view-state')).toHaveText('Following latest'); await close(page);
    await expect(page.locator('#filter-summary')).toContainText('+2 filters');
    await activate(page.locator('#filter-overflow summary'), info); await expect(page.locator('#filter-full')).toBeVisible();
    await expect(page.locator('#filter-full')).toContainText(id); await activate(page.locator('#filter-overflow summary'), info);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    for (const [selector, text] of [['#reader-indicator', 'Position held'], ['#filter-summary', 'full value'], ['#diagnostic-visibility', 'real call-flow'], ['[data-log-order-mode="flow"]', 'heuristics']]) {
        if (info.project.name.endsWith('mobile')) await page.locator(selector).tap(); else await page.locator(selector).focus();
        await expect(page.getByRole('tooltip')).toContainText(text);
        if (await page.getByRole('button', { name: 'Dismiss explanation' }).isVisible()) await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        await page.mouse.move(0, 0);
    }
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await page.locator('[data-open-panel="filters"]').click(); await page.locator('#diagnosticsSwitch').check();
    await expect(page.locator('#diagnostic-visibility')).toHaveText('Diagnostics shown');
    await page.locator('#diagnosticsSwitch').uncheck(); await close(page); await expect(page.locator('#diagnostic-visibility')).toHaveText('Diagnostics hidden');
    // Critical summary uses the actual notice controller, with labelled synthetic observed evidence.
    await page.evaluate(() => { criticalDiagnostic = { id: 'status-critical', reference: 'status-reference', message: 'Synthetic diagnostic error', component: 'PCM', timestamp: new Date().toISOString() }; updateCriticalNotice(); });
    await expect(page.locator('#critical-diagnostic-notice')).toBeVisible();
    await page.addStyleTag({ content: '.scope-strip { font-size: 24px; } .scope-strip .btn { font-size: 24px; }' });
    if (!await page.locator('.scope-details').evaluate(node => node.open)) await activate(page.locator('#filter-overflow summary'), info);
    await expect(page.locator('#filter-full')).toBeVisible();
    const bounds = await page.locator('#scope-strip').evaluate(node => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        children: [...node.querySelectorAll('#reader-indicator,#filter-summary,#filter-full,#diagnostic-visibility,#critical-diagnostic-notice')].map(child => { const b = child.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, scroll: child.scrollWidth, client: child.clientWidth }; }) }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    const noticeBounds = await page.locator('#critical-diagnostic-notice').evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, viewport: innerHeight }));
    expect(noticeBounds.bottom).toBeLessThanOrEqual(noticeBounds.viewport);
    await page.locator('#filter-full').focus(); await page.locator('#filter-full').press('End');
    await expect(page.locator('#filter-full')).toContainText('Status: 200');
    expect(bounds.children.every(b => b.left >= 0 && b.right <= bounds.width + 1 && b.scroll <= b.client + 1)).toBe(true);
    expect(fixture.reads.length).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath('status-enlarged-exact-scope.png') });
});
