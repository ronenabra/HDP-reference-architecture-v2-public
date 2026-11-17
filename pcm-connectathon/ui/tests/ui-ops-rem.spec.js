'use strict';
/** Operator remediation against disposable real HTTP routes and controlled response races. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.PCM_OPS_FIXTURE_URL;
test.beforeEach(() => { test.skip(!base, 'operator fixture is qualified in its separate pinned Docker matrix'); });

/** Capture reviewable responsive evidence outside runtime state. */
async function screenshot(page, testInfo, name) {
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

/** Shared tooltip host remains semantically valid on each consuming page. */
async function auditHelpRoles(page, testInfo, name) {
    await expect(page.getByRole('tooltip')).toHaveJSProperty('tagName', 'DIV');
    const result = await new AxeBuilder({ page }).withRules(['aria-allowed-role']).analyze();
    await testInfo.attach(name, { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
    expect(result.violations).toEqual([]);
}

/** Measure actual input and acknowledgment; browser automation actionability is separate. */
async function installClearTimingProbe(page) {
    // Measure the browser response to actual input, separately from Playwright's
    // pre-click actionability wait (WebKit can throttle its stable-frame probe).
    await page.evaluate(() => {
        window.clearTiming = { inputAt: null, acknowledgedAt: null };
        document.querySelector('[data-help-key="logs.clear"]').addEventListener('click', () => {
            window.clearTiming.inputAt = performance.now();
        }, { capture: true, once: true });
        const status = document.getElementById('log-status');
        const observer = new MutationObserver(() => {
            if (window.clearTiming.inputAt !== null && status.textContent.includes('logs cleared')) {
                window.clearTiming.acknowledgedAt = performance.now(); observer.disconnect();
            }
        });
        observer.observe(status, { childList: true, subtree: true, characterData: true });
    });
}
/** Keep the existing one-second acknowledgment requirement, including missing timestamps. */
function assertClearTiming(timing) {
    expect(timing.inputAt).not.toBeNull(); expect(timing.acknowledgedAt).not.toBeNull();
    const elapsed = timing.acknowledgedAt - timing.inputAt;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(1000);
    return elapsed;
}

test('UI OPS bounded real logs are usable within two seconds, page and retain full details @smoke', async ({ page }, testInfo) => {
    const timings = [];
    const phases = [];
    for (let run = 0; run < 3; run++) {
        const started = Date.now();
        const responsePromise = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/unified-logs' && !url.searchParams.has('cursor'); });
        await page.goto(`${base}/logs-view?diagnostics=true`);
        await expect(page.locator('.log-row').first()).toBeVisible();
        timings.push(Date.now() - started);
        expect(timings.at(-1)).toBeLessThan(2000);
        expect(await page.locator('.log-row').count()).toBeLessThanOrEqual(200);
        const response = await responsePromise;
        expect(response.ok()).toBe(true);
        const result = await response.json();
        expect(result.entries.length).toBeLessThanOrEqual(200);
        expect(result.bytesRead).toBeGreaterThan(0);
        expect(result.bytesRead).toBeLessThanOrEqual(1048576);
        expect(result.entries.every(entry => entry.details?.payload === undefined)).toBe(true);
        await expect(page.locator('[data-details]')).toHaveCount(0);
        await expect(page.locator('#details-pane pre')).toHaveCount(0);
        phases.push(await page.evaluate(() => window.logPageTimings));
    }
    const resultRowCount = await page.locator('.log-row').count();
    const first = await page.locator('.log-row').first().getAttribute('data-log-id');
    await page.locator('.log-row').first().click();
    const payload = page.locator('#details-pane pre[data-help-key="logs.payload"]');
    const rawSource = page.locator('#details-pane pre.raw-source-text');
    await expect(payload).toContainText('Fabricated Patient/000000018');
    await expect(rawSource).toContainText('Fabricated Patient/000000018');
    const expectedPayload = 'Fabricated Patient/000000018 non-AWS token <script>literal</script> '.repeat(55);
    expect(JSON.parse(await payload.textContent()).details.payload).toBe(expectedPayload);
    expect(JSON.parse(await rawSource.textContent()).details.payload).toBe(expectedPayload);
    await page.locator('#tab-raw').click();
    await expect(rawSource).toBeVisible();
    await expect(page.locator('#panel-raw')).toContainText('Exact raw source text');
    await expect(page.locator('#details-pane script')).toHaveCount(0);
    await page.locator('#close-event-detail').click();
    const olderRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/unified-logs' && new URL(response.url()).searchParams.has('cursor'));
    await page.locator('#log-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await olderRead;
    await expect.poll(() => page.locator('.log-row').count()).toBeGreaterThan(resultRowCount);
    await expect(page.locator('.log-row').first()).toHaveAttribute('data-log-id', first);
    await page.locator('#follow-latest').click();
    await expect(page.locator('.log-row').first()).toHaveAttribute('data-log-id', first);
    await expect(page.locator('#log-status')).toContainText('rows');
    await expect(page.locator('#view-state')).toContainText('Following latest');
    await screenshot(page, testInfo, 'logs-neutral');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const cell = page.locator('[data-help-key="logs.role-doctor"]').first();
    await cell.focus();
    await expect(page.getByRole('tooltip')).toContainText('requesting Service Provider');
    await screenshot(page, testInfo, 'logs-help');
    for (const [key, text] of [['logs.level-info', 'informational event'], ['logs.level-warn', 'WARN'],
        ['logs.level-error', 'ERROR'], ['logs.class-uncategorized', 'not itself an error']]) {
        if (key === 'logs.class-uncategorized' && page.viewportSize().width < 768) {
            await page.keyboard.press('Escape');
            await page.locator(`.log-row:has([data-help-key="${key}"])`).first().click();
            await expect(page.locator(`#event-metadata [data-help-key="${key}"]`)).toBeVisible();
            await page.locator(`#event-metadata [data-help-key="${key}"]`).focus();
        } else await page.locator(`[data-help-key="${key}"]`).first().focus();
        await expect(page.getByRole('tooltip')).toContainText(text);
    }
    await screenshot(page, testInfo, 'logs-value-help');
    await testInfo.attach('timings', { body: JSON.stringify({ timings, phases, maxRows: 200, maxReadBytes: 1048576 }), contentType: 'application/json' });
});

test('UI OPS Diagnostics is off by default and stays off across reload and paging @smoke', async ({ page }) => {
    const responsePromise = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/unified-logs' && !url.searchParams.has('cursor'); });
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row').first()).toBeVisible();
    const response = await responsePromise;
    expect(new URL(response.url()).searchParams.get('diagnostics')).toBe('false');
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.every(entry => entry.details?.visibility !== 'diagnostic')).toBe(true);
    await expect(page.locator('#diagnosticsSwitch')).not.toBeChecked();
    await expect(page.locator('#diagnostic-visibility')).toContainText('Diagnostics hidden');
    await expect(page.locator('.log-row[data-log-class$="/diagnostic"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.log-row').first()).toBeVisible();
    await expect(page.locator('#diagnosticsSwitch')).not.toBeChecked();
    const olderResponsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/unified-logs'
        && new URL(response.url()).searchParams.has('cursor'));
    await page.locator('#log-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const olderResponse = await olderResponsePromise;
    expect(new URL(olderResponse.url()).searchParams.get('diagnostics')).toBe('false');
    await expect(page.locator('#view-state')).toContainText('Position held');
    await expect(page.locator('#diagnostic-visibility')).toContainText('Diagnostics hidden');
    await expect(page.locator('.log-row[data-log-class$="/diagnostic"]')).toHaveCount(0);
});

test('UI OPS clear invalidates delayed reads and payloads while held; partial failures stay honest @smoke', async ({ page }, testInfo) => {
    await page.goto(`${base}/logs-view?diagnostics=true`);
    await expect(page.locator('.log-row').first()).toBeVisible();
    await page.locator('.log-row').first().click();
    await expect(page.locator('#details-pane pre[data-help-key="logs.payload"]')).toBeVisible();
    await page.evaluate(() => markSelectedLog('yellow'));
    let release;
    let signalReadStarted;
    let signalDetailStarted;
    const readStarted = new Promise(resolve => { signalReadStarted = resolve; });
    const detailStarted = new Promise(resolve => { signalDetailStarted = resolve; });
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/api/unified-logs/detail?**', async route => {
        signalDetailStarted();
        await delayed;
        try { await route.fulfill({ json: { details: { message: 'OLD PAYLOAD' } } }); } catch (_) { /* cancellation is expected */ }
    });
    await page.locator('#close-event-detail').click();
    await page.locator('.log-row').nth(1).click();
    await detailStarted;
    await expect(page.locator('#details-pane')).toContainText('Loading selected');
    await page.route('**/api/unified-logs?**', async route => {
        signalReadStarted();
        await delayed;
        try { await route.fulfill({ json: { entries: [{ id: 'pre-clear', timestamp: '2026-10-04', message: 'OLD RESPONSE', details: {} }] } }); } catch (_) { /* cancellation is expected */ }
    });
    // Do not await the response that this test intentionally holds until after clear.
    await page.evaluate(() => { void refreshLogs(true); });
    await readStarted;
    await page.locator('#close-event-detail').click();
    await page.evaluate(() => holdReading());
    await page.locator('[data-open-panel="tools"]').click();
    await page.route('**/api/unified-logs/clear', route => route.fulfill({ json: { status: 'cleared', results: [
        { component: 'pcm-core', status: 'cleared' },
        { component: 'extensions/operator-app', status: 'retained', reason: 'operator-owned read-only source' }
    ] } }));
    page.once('dialog', async dialog => {
        expect(dialog.message()).toContain('Read-only extension logs are retained');
        await dialog.accept();
    });
    await installClearTimingProbe(page);
    const clickStarted = Date.now();
    await page.getByRole('button', { name: 'Clear built-in logs', exact: true }).click();
    await expect(page.locator('#log-status')).toContainText('logs cleared');
    const clickWallMs = Date.now() - clickStarted;
    const timing = await page.evaluate(() => window.clearTiming);
    const acknowledgementMs = timing.acknowledgedAt - timing.inputAt;
    await testInfo.attach('clear-ui-timing', { body: JSON.stringify({ acknowledgementMs, clickWallMs, ...timing }), contentType: 'application/json' });
    assertClearTiming(timing);
    await expect(page.locator('#log-status')).toContainText('read-only extension source(s) retained: extensions/operator-app');
    await expect(page.locator('#details-pane')).toContainText('Retained extension events may reappear on the next page');
    await expect(page.locator('#page-coverage')).toContainText('No page loaded after clear');
    await expect(page.locator('#view-state')).toContainText('Position held');
    await expect(page.locator('#older-logs')).toHaveCount(0);
    release();
    await expect(page.locator('.log-row')).toHaveCount(0);
    await expect(page.locator('#details-pane pre[data-help-key="logs.payload"]')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('markedUnifiedLogs'))).toBe('{}');
    await page.waitForTimeout(250);
    await expect(page.locator('#log-table-body')).not.toContainText('OLD RESPONSE');
    await expect(page.locator('#details-pane')).not.toContainText('OLD PAYLOAD');
    await page.unroute('**/api/unified-logs?**');
    await page.unroute('**/api/unified-logs/detail?**');
    await page.locator('#close-workbench').click();
    await page.locator('#follow-latest').click();
    await expect(page.locator('.log-row').first()).toBeVisible();
    await page.locator('[data-open-panel="tools"]').click();
    await page.route('**/api/unified-logs/clear', route => route.fulfill({ status: 207, json: {
        status: 'partial', results: [{ component: 'ho-a-hapi', status: 'failed', error: 'fixture permission failure' }] } }));
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear built-in logs', exact: true }).click();
    await expect(page.locator('#log-status')).toContainText('Clear incomplete: ho-a-hapi: fixture permission failure');
    await expect(page.locator('#log-status')).not.toContainText('logs cleared');
    await expect(page.locator('#page-coverage')).toContainText('Clear failed or was partial. Use Jump to latest');
    await expect(page.locator('.log-row')).toHaveCount(0);
    await expect(page.locator('#details-pane pre')).toHaveCount(0);
    await expect(page.locator('#older-logs')).toHaveCount(0);
    await screenshot(page, testInfo, 'clear-partial');
    // A partial clear invalidates the old snapshot. Only an explicit fresh read may repopulate it.
    await page.locator('#close-workbench').click();
    await page.locator('#follow-latest').click();
    await expect(page.locator('.log-row').first()).toBeVisible();
    await expect(page.locator('#log-status')).toContainText('rows');
    await expect(page.locator('#view-state')).toContainText('Following latest');
    await screenshot(page, testInfo, 'clear-partial-reloaded');
});

test('UI OPS counts and delete panels isolate two targets and reset checkbox acknowledgement @smoke', async ({ page }, testInfo) => {
    await page.route('**/admin/api/fhir-servers/*/data', route => {
        const id = new URL(route.request().url()).pathname.split('/')[4];
        if (route.request().method() === 'DELETE') {
            expect(route.request().postDataJSON().confirmation).toContain(id);
            return route.fulfill({ status: 202, json: { id: 'delete-demo', kind: 'reset', serverId: id, phase: 'failed', status: 'failed', currentStage: 'failed', diagnostics: ['fixture deletion failed'] } });
        }
        return route.fulfill({ json: { state: 'populated', actualResourceCount: id === 'ho-a' ? 12 : 24,
            hasHistory: true, actualCounts: { Patient: id === 'ho-a' ? 12 : 24 } } });
    });
    await page.route('**/admin/api/data-operations/delete-demo', route => route.fulfill({ json: { id: 'delete-demo', kind: 'reset', serverId: 'ho-a', phase: 'failed', status: 'failed' } }));
    await page.goto(`${base}/admin`);
    for (const [id, count] of [['ho-a', 12], ['ho-b', 24]]) {
        const target = page.locator(`[data-managed-fhir-server="${id}"]`);
        await target.locator('[data-target-counts]').click();
        await expect(target.locator('[data-target-count-output]')).toContainText(`${count} current resources`);
        await expect(target.locator('[data-target-count-output] td').last()).toHaveText(String(count));
    }
    await screenshot(page, testInfo, 'target-counts');
    const target = page.locator('[data-managed-fhir-server="ho-a"]');
    const remove = target.getByRole('button', { name: 'Delete all data', exact: true });
    await expect(remove).toBeDisabled();
    await target.locator('[data-delete-acknowledgement]').check();
    await expect(remove).toBeEnabled();
    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect(target.locator('#data-delete-ho-a')).toContainText('Delete all data');
    await expect(target.locator('[data-delete-acknowledgement]')).not.toBeChecked();
    await expect(remove).toBeDisabled();
    await expect(target.locator('#data-operation-ho-a')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Logs', exact: true })).toHaveAttribute('href', '/logs-view');
    await screenshot(page, testInfo, 'action-panels');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; document.querySelector('.admin-content').scrollTop = 900; });
    const toggle = page.locator('.explain-toggle');
    const bounds = await toggle.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
    await screenshot(page, testInfo, 'admin-zoom-help');
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
    await page.getByText('Advanced: deployment URLs and ports', { exact: true }).click();
    await page.locator('a[data-help-key="admin.endpoint-doctor"]').first().focus();
    await expect(page.getByRole('tooltip')).toContainText('Service Provider demonstration app');
    await expect(page.getByRole('tooltip')).toContainText('Separate diagnostic/application link');
    await screenshot(page, testInfo, 'deployment-doctor-help');
    await page.locator('a[data-help-key="admin.endpoint-pcm-api"]').first().focus();
    await expect(page.getByRole('tooltip')).toContainText('capability link describes supported FHIR');
    await expect(page.getByRole('tooltip')).toContainText('/r4/metadata');
    await screenshot(page, testInfo, 'deployment-capability-help');
    await auditHelpRoles(page, testInfo, 'axe-admin-explain-role');
});

test('UI OPS Doctor select explains all configured identities and displays exact test exception @smoke', async ({ page }, testInfo) => {
    await page.goto(`${base}/fixture/doctor`);
    await expect(page.locator('[data-help-key="consent.test-exception"]')).toContainText('HTEST 1 and 2');
    await expect(page.locator('[data-help-key="consent.test-approved"]')).toHaveCount(1);
    await expect(page.locator('[data-help-key="consent.relaxed-access"]')).toContainText('even when consent has not been approved');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#doctor-identity').focus();
    const help = page.getByRole('tooltip');
    for (const text of ['primary SP', 'secondary SP', 'Untrusted transport', 'Unregistered assertion key']) {
        await expect(help).toContainText(text);
    }
    await screenshot(page, testInfo, 'doctor-approval-help');
    await auditHelpRoles(page, testInfo, 'axe-doctor-explain-role');
});

test('UI OPS bounded Admin import diagnostics remain readable and fast @smoke', async ({ page }, testInfo) => {
    const timings = [];
    for (let run = 0; run < 3; run++) {
        const started = Date.now();
        await page.goto(`${base}/admin/logs/view`);
        await expect(page.locator('tbody tr').first()).toBeVisible();
        timings.push(Date.now() - started);
        expect(timings.at(-1)).toBeLessThan(2000);
        expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(50);
    }
    await page.locator('tbody summary').first().click();
    await expect(page.locator('tbody pre').first()).toContainText('Fabricated Patient/000000018');
    const raw = page.locator('tbody pre').first();
    await raw.focus();
    expect((await raw.boundingBox()).height).toBeLessThanOrEqual(385);
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    if (page.viewportSize().width < 768) {
        expect(await page.locator('.table-responsive').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    }
    await screenshot(page, testInfo, 'admin-import-logs');
    await testInfo.attach('admin-log-timings', { body: JSON.stringify({ timings, rows: 50, maxReadBytes: 1048576 }), contentType: 'application/json' });
});

test('UI OPS acknowledgment timing detects a true delayed response beyond one second @smoke', async ({ page }, info) => {
    await page.goto(`${base}/logs-view`);
    await expect(page.locator('.log-row').first()).toBeVisible();
    await page.evaluate(() => holdReading());
    await page.locator('[data-open-panel="tools"]').click();
    await page.route('**/api/unified-logs/clear', async route => {
        // Deliberately slow only this controlled fixture response, never product deadlines.
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.fulfill({ json: { status: 'cleared', results: [] } });
    });
    await installClearTimingProbe(page);
    page.once('dialog', dialog => dialog.accept());
    const started = Date.now();
    await page.getByRole('button', { name: 'Clear built-in logs', exact: true }).click();
    await expect(page.locator('#log-status')).toContainText('logs cleared');
    const timing = await page.evaluate(() => window.clearTiming);
    const acknowledgementMs = timing.acknowledgedAt - timing.inputAt;
    await info.attach('controlled-delayed-ack', { body: JSON.stringify({ ...timing, acknowledgementMs, clickWallMs: Date.now() - started, injectedDelayMs: 1200, expectedBudgetVerdict: 'rejected' }), contentType: 'application/json' });
    expect(acknowledgementMs).toBeGreaterThanOrEqual(1000);
    expect(() => assertClearTiming(timing)).toThrow();
});
