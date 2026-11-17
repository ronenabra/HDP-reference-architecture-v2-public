'use strict';
/** One selected-evidence journey, served by the real central Logs template/controllers. */
const { test, expect } = require('@playwright/test');
const { installWorkbenchFixture } = require('./logs-workbench-fixture');

test('FHIR selected evidence stays local, safe, copyable and restorable', async ({ page }, info) => {
    const network = [], errors = [];
    page.on('request', request => network.push(new URL(request.url()).pathname));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.copied = []; window.rejectCopy = false;
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
            if (window.rejectCopy) throw new Error('denied');
            window.copied.push(text);
        } } });
    });
    const fixture = await installWorkbenchFixture(page, { count: 3 });
    const url = '/fhir/Observation/_search?code=a%7Cb&code=&empty';
    const body = 'code=a%7Cb&code=&name=one+two';
    const outcome = { resourceType: 'OperationOutcome', issue: Array.from({ length: 40 }, (_, i) => ({
        severity: 'error', code: 'forbidden', diagnostics: `${i} <img src=x onerror="window.UNTRUSTED=true">`
    })) };
    const records = fixture.entries.map(row => structuredClone(row));
    records[0].details = { ...records[0].details, type: 'OUTGOING_ERROR', method: 'POST', url,
        requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' }, requestBody: body, status: 403,
        responseHeaders: { 'content-type': 'application/fhir+json' }, responseBody: JSON.stringify(outcome), responseBodyTruncated: true };
    records[1].details = { ...records[1].details, type: 'TOKEN_ISSUED', savedConsent: { resourceType: 'Consent' } };
    records[2].details = { type: 'SYSTEM_WORKFLOW_RESPONSE', body: { resourceType: 'Bundle', entry: [] }, data: outcome };
    fixture.detailResponder = async (route, reference) => {
        const index = Number(reference.replace('fabricated-reference-', ''));
        await route.fulfill({ json: { entry: records[index], raw: 'synthetic original\r\n', source: { componentId: 'pcm-core' } } });
        return true;
    };
    await page.goto('/logs-view');
    await expect(page.locator('.log-row')).toHaveCount(3);
    if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
    const select = index => page.locator(`[data-log-id="fabricated-event-${index}"]`).click();
    const tab = page.locator('#tab-fhir'), host = page.locator('#fhir-exchange-host');
    await expect(tab).toBeHidden();
    await select(0); await expect(tab).toBeVisible();
    await expect(host).toBeEmpty();
    const readsBefore = fixture.details.length;
    await page.locator('#tab-structured').click(); await page.keyboard.press('ArrowRight');
    await expect(tab).toBeFocused(); await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(host.getByLabel('Request query parameters')).toBeHidden();
    await expect(host.getByLabel('Decoded form parameters', { exact: true })).toBeHidden();
    await host.getByText('Query parameters · 3', { exact: true }).click();
    await expect(host.getByLabel('Request query parameters')).toHaveText('code = a|b\ncode = \nempty = ');
    await expect(host.getByLabel('Request', { exact: true })).toContainText('POST ' + url);
    await expect(host.getByLabel('Request', { exact: true })).toContainText('Content-Type: application/x-www-form-urlencoded');
    await host.getByText('Decoded form parameters · 3', { exact: true }).click();
    await expect(host.getByLabel('Decoded form parameters', { exact: true })).toContainText('code = a|b');
    await expect(host.getByLabel('Response body')).toHaveText(JSON.stringify(outcome, null, 2));
    expect(await host.textContent()).not.toMatch(/Source:|\$\[|Selected event only|Recorded fields|evidence 1|responseBodyTruncated/);
    await host.getByRole('button', { name: 'Copy request', exact: true }).click();
    expect(await page.evaluate(() => copied.at(-1))).toBe(`POST ${url}\nContent-Type: application/x-www-form-urlencoded\n\n${body}`);
    await expect(host).toContainText('Capture truncated.');
    await expect(page.locator('#copy-detail')).toBeHidden();
    await host.getByRole('button', { name: 'Copy request URL', exact: true }).click();
    expect(await page.evaluate(() => copied.at(-1))).toBe(url);
    await host.getByRole('button', { name: 'Copy request body', exact: true }).click();
    expect(await page.evaluate(() => copied.at(-1))).toBe(body);
    await host.getByRole('button', { name: 'Copy JSON', exact: true }).click();
    expect(await page.evaluate(() => copied.at(-1))).toBe(JSON.stringify(outcome));
    await page.evaluate(() => { rejectCopy = true; document.execCommand = () => false; });
    await host.getByRole('button', { name: 'Copy JSON', exact: true }).click();
    await expect(page.locator('#manual-copy-text')).toHaveValue(JSON.stringify(outcome));
    await page.locator('#wrap-detail').click(); await expect(page.locator('#details-pane')).toHaveClass(/no-wrap/);
    const offset = await host.evaluate(element => { element.scrollTop = 240; return element.scrollTop; });
    expect(offset).toBeGreaterThan(0);
    await page.locator('#tab-json').click(); await expect(host).toBeEmpty();
    await tab.click(); expect(await host.evaluate(element => element.scrollTop)).toBe(offset);
    // Existing retained inspection and Return must rebind the lazy copy controls.
    await page.locator('[data-inspect-field="flowId"]').click();
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await page.locator('#return-to-results').click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await host.evaluate(element => element.scrollTop)).toBe(offset);
    await page.evaluate(() => { rejectCopy = false; });
    await host.getByRole('button', { name: 'Copy JSON', exact: true }).click();
    expect(await page.evaluate(() => copied.at(-1))).toBe(JSON.stringify(outcome));
    // Readability capture uses wrapped lines, with all controls contained by the viewport.
    await page.locator('#wrap-detail').click();
    await page.evaluate(() => resizeEventPane(70, false));
    await host.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: info.outputPath('fhir-exchange.png'), fullPage: true });
    await host.getByRole('heading', { name: 'Response', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('fhir-response.png'), fullPage: true });
    const box = await host.boundingBox(); expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
    expect(await page.evaluate(() => window.UNTRUSTED)).toBeUndefined();
    expect(await host.locator('img, script, a').count()).toBe(0);
    expect(fixture.details.length).toBe(readsBefore);
    await select(2); await tab.click();
    await expect(host).toContainText('Not recorded in this event');
    await expect(host.getByLabel('Response body')).toHaveCount(2);
    await expect(host.getByRole('heading', { name: 'Response 1', exact: true })).toBeVisible();
    await expect(host.getByRole('heading', { name: 'Response 2', exact: true })).toBeVisible();
    await expect(host.getByLabel('Response body').nth(1)).toContainText('Bundle');
    records[0].details = { type: 'OUTGOING_REQUEST', method: 'GET', url: '/fhir/Observation?_count=10' };
    await select(0); await tab.click();
    await host.getByRole('button', { name: 'Copy request', exact: true }).click();
    expect(await page.evaluate(() => copied.at(-1))).toBe('GET /fhir/Observation?_count=10');
    await expect(host.getByLabel('Request', { exact: true })).toHaveText('GET /fhir/Observation?_count=10');
    await expect(host).not.toContainText('Request body not recorded.');
    await select(1); await expect(tab).toBeHidden();
    await expect(page.locator('#tab-json')).toHaveAttribute('aria-selected', 'true');
    // Rapid selection uses the existing request revision fence, including fetch failure.
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    fixture.detailResponder = async (route, reference) => {
        if (reference.endsWith('-0')) { await blocked; await route.fulfill({ json: { entry: records[0], raw: '' } }); return true; }
        await route.fulfill({ status: 409, json: { error: 'Synthetic detail unavailable' } }); return true;
    };
    await select(0); await expect.poll(() => fixture.details.at(-1)).toBe('fabricated-reference-0');
    await select(1); release();
    await expect(page.locator('#detail-status')).toContainText('Synthetic detail unavailable');
    await expect(tab).toBeHidden();
    const storage = await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage }));
    expect(storage).not.toContain(body); expect(storage).not.toContain('OperationOutcome');
    expect(network.filter(path => /\/fhir|\/token|\/introspect|export/.test(path))).toEqual([]);
    expect(errors).toEqual([]);
});

/** Reproduce the owner's compact 503 response and verify actual rendered whitespace. */
test('compact 503 OperationOutcome preserves readable JSON and header indentation', async ({ page }, info) => {
    const fixture = await installWorkbenchFixture(page, { count: 1 });
    const url = 'https://ho-a-hapi:8080/fhir/Observation?_count=10';
    const outcome = { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: 'PCM clinical read could not complete' }] };
    const headers = { 'retry-after': '1', 'content-type': 'application/fhir+json' };
    const record = structuredClone(fixture.entries[0]);
    record.details = { type: 'OUTGOING_RESPONSE', url, status: 503, headers, body: JSON.stringify(outcome) };
    fixture.detailResponder = async route => {
        await route.fulfill({ json: { entry: record, raw: JSON.stringify(record) } });
        return true;
    };
    await page.goto('/logs-view');
    if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click();
    await page.locator('[data-log-id="fabricated-event-0"]').click();
    await page.locator('#tab-fhir').click();
    await page.evaluate(() => resizeEventPane(80, false));
    const host = page.locator('#fhir-exchange-host');
    await page.screenshot({ path: info.outputPath('compact-503-request.png'), fullPage: true });
    const response = host.getByLabel('Response body');
    await response.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('compact-503-response.png'), fullPage: true });
    await expect(response).toHaveText(JSON.stringify(outcome, null, 2));
    expect(await host.textContent()).not.toMatch(/Source:|\$\[|Selected event only|Recorded fields|evidence 1|Headers: Not recorded|GET/);
    expect((await host.textContent()).split(url)).toHaveLength(2);
    await expect(host).toContainText('Method not recorded.');
    await expect(host.locator('.fhir-heading').filter({ has: page.getByRole('heading', { name: 'Response', exact: true }) })).toContainText('503');
    const headerDetails = host.locator('details').filter({ has: page.getByText('Response headers · 2', { exact: true }) });
    await expect(headerDetails).not.toHaveAttribute('open', '');
    const responseHeaders = host.getByLabel('Response headers', { exact: true });
    await expect(responseHeaders).toBeHidden();
    await headerDetails.locator('summary').click();
    await expect(responseHeaders).toHaveText('retry-after: 1\ncontent-type: application/fhir+json');
    const layout = await response.evaluate(element => {
        const rangeFor = text => {
            const offset = element.textContent.indexOf(text), range = document.createRange();
            range.setStart(element.firstChild, offset); range.setEnd(element.firstChild, offset + text.length);
            const box = range.getBoundingClientRect(); return { x: box.x, y: box.y };
        };
        return { whiteSpace: getComputedStyle(element).whiteSpace, first: rangeFor('{'), indented: rangeFor('"'),
            fontSize: parseFloat(getComputedStyle(element).fontSize) };
    });
    expect(layout.whiteSpace).toBe('pre-wrap');
    expect(layout.indented.y - layout.first.y).toBeGreaterThan(layout.fontSize);
    expect(layout.indented.x - layout.first.x).toBeGreaterThan(8);
    expect(await responseHeaders.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('pre-wrap');
    await responseHeaders.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('compact-503-headers.png'), fullPage: true });
});
