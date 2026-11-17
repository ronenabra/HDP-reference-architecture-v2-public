'use strict';
/** Actual Filters geometry and native keyboard/touch against an owned Logs listener. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const baseline = process.env.PCM_FILTER_BASELINE === 'true';
const fields = ['filter-role', 'filter-healthOrganizationId', 'filter-level', 'filter-method', 'filter-correlationId', 'filter-flowId', 'filter-traceId', 'filter-path', 'filter-status', 'search-text', 'search-source', 'search-since', 'search-until'];
/** Use the browser's ordinary input activation paths. */
async function activate(node, info) { if (info.project.name.endsWith('mobile')) await node.tap(); else { await node.focus(); await node.press(await node.evaluate(element => element.matches('input[type=checkbox]')) ? 'Space' : 'Enter'); } }
/** Open the existing drawer/sidebar via its real command. */
async function open(page, info) { if (!await page.locator('[data-panel="filters"]').isVisible()) await activate(page.locator('[data-open-panel="filters"]'), info); }
/** Record scroll-independent content rectangles and actual overflow for every field/action. */
async function measure(page) {
    return page.evaluate(() => {
        const panel = document.querySelector('[data-panel="filters"]'), form = panel.querySelector('form');
        const box = node => { const r = node.getBoundingClientRect(); const p = panel.getBoundingClientRect(); return { x: r.x - p.x, y: r.y - p.y, width: r.width, height: r.height, right: r.right - p.x, bottom: r.bottom - p.y }; };
        return { viewport: { width: innerWidth, height: innerHeight }, sidebar: document.querySelector('#workbench').getBoundingClientRect().width,
            panel: { width: panel.clientWidth, scrollWidth: panel.scrollWidth }, form: box(form),
            controls: [...form.querySelectorAll('input,select,button')].map(node => ({ id: node.id || node.textContent.trim(), ...box(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, font: getComputedStyle(node).fontSize })),
            labels: [...panel.querySelectorAll('label')].map(node => ({ text: node.textContent.trim(), ...box(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, whiteSpace: getComputedStyle(node).whiteSpace })),
            diagnostics: box(document.querySelector('#diagnosticsSwitch').closest('label')) };
    });
}
/** Prove usable widths, readable labels, distinct action rows and unclipped controls. */
function assertGeometry(result) {
    expect(result.panel.scrollWidth).toBeLessThanOrEqual(result.panel.width + 1);
    for (const control of result.controls) {
        expect(control.x).toBeGreaterThanOrEqual(0); expect(control.right).toBeLessThanOrEqual(result.panel.width + 1);
        expect(control.height).toBeGreaterThanOrEqual(44); expect(control.width).toBeGreaterThanOrEqual(130);
    }
    for (const label of result.labels) { expect(label.right).toBeLessThanOrEqual(result.panel.width + 1); expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1); }
    for (let index = 0; index < result.controls.length; index++) for (const other of result.controls.slice(index + 1)) {
        const control = result.controls[index];
        const overlap = Math.min(control.right, other.right) - Math.max(control.x, other.x) > 1 && Math.min(control.bottom, other.bottom) - Math.max(control.y, other.y) > 1;
        expect(overlap, `${control.id} overlaps ${other.id}`).toBe(false);
    }
    const apply = result.controls.find(node => node.id === 'Apply filters'), reset = result.controls.find(node => node.id === 'Reset filters'), search = result.controls.find(node => node.id === 'search-start');
    const inputs = result.controls.filter(node => !['Apply filters', 'Reset filters', 'search-start'].includes(node.id));
    expect(apply.y).toBeGreaterThanOrEqual(Math.max(...inputs.map(node => node.bottom)) + 15);
    expect(search.y).toBeGreaterThanOrEqual(Math.max(apply.bottom, reset.bottom) + 15);
    expect(result.diagnostics.y).toBeGreaterThanOrEqual(search.bottom + 15);
}

test('responsive Filters geometry with long values, labels and Explain', async ({ page }, info) => {
    await page.goto('/logs-view'); await expect(page.locator('.log-row').first()).toBeVisible(); await open(page, info);
    const scenarios = info.project.name.endsWith('mobile') ? [{ name: 'mobile', width: 390, height: 844 }, { name: 'narrow-mobile', width: 320, height: 740 }, { name: 'mobile-text-150', width: 390, height: 844, text: 24 }]
        : [{ name: 'desktop', width: 1440, height: 900 }, { name: 'resized-desktop', width: 1100, height: 900 }, { name: 'zoom-200-reflow', width: 720, height: 450 }, { name: 'desktop-text-200', width: 1440, height: 900, text: 32 }];
    const measurements = [];
    for (const scenario of scenarios) {
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        await page.evaluate(size => { document.documentElement.style.fontSize = size + 'px'; }, scenario.text || 16);
        await open(page, info);
        await page.locator('#filter-correlationId').fill('full-long-שלום-<&>-' + 'x'.repeat(240));
        await page.locator('#search-source').fill('extensions/long-synthetic-source-' + 's'.repeat(150));
        // Widen one authored label to verify wrapping under translated/enlarged copy.
        await page.locator('label[for="filter-healthOrganizationId"]').evaluate(node => { node.textContent = 'Organization identifier (exact recorded value)'; });
        for (const explain of [false, true]) {
            // The header control stays behind the mobile drawer; set it via its existing shared controller state.
            await page.evaluate(on => { const input = document.querySelector('.explain-toggle input'); input.checked = on; input.dispatchEvent(new Event('change', { bubbles: true })); }, explain);
            await page.locator('#workbench-body').evaluate(node => { node.scrollTop = 0; });
            const result = { scenario: scenario.name, explain, ...await measure(page) }; measurements.push(result);
            if (!baseline) assertGeometry(result);
            if (!explain) {
                await page.screenshot({ path: info.outputPath(`${baseline ? 'before' : 'after'}-${scenario.name}.png`) });
                await page.locator('#diagnosticsSwitch').scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath(`${baseline ? 'before' : 'after'}-${scenario.name}-actions.png`) });
            }
        }
        if (!baseline) {
            await page.locator('#filter-flowId').focus(); await expect(page.getByRole('tooltip')).toContainText('Flow ID');
            const popup = await page.getByRole('tooltip').boundingBox(); expect(popup.x).toBeGreaterThanOrEqual(0); expect(popup.x + popup.width).toBeLessThanOrEqual(scenario.width + 1);
            await activate(page.getByRole('button', { name: 'Dismiss explanation' }), info); await expect(page.getByRole('tooltip')).not.toBeVisible();
        }
    }
    fs.writeFileSync(info.outputPath('geometry.json'), JSON.stringify(measurements, null, 2));
});

test('Apply, Enter, Reset, Diagnostics and retained query preserve their contracts', async ({ page }, info) => {
    test.skip(baseline, 'Before evidence captures geometry only.');
    const errors = [], reads = [], queries = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/unified-logs?')) reads.push(new URL(request.url()).searchParams.toString()); if (request.method() === 'POST' && request.url().endsWith('/api/unified-logs/search')) queries.push(request.postDataJSON()); });
    await page.request.post('/fixture/reset'); await page.request.post('/fixture/columns');
    await page.goto('/logs-view'); await expect(page.locator('.log-row').first()).toBeVisible(); await open(page, info);
    // Native tab order follows fields, browse actions, search, Diagnostics with no hidden button detours.
    await page.locator('#filter-role').focus();
    const focus = [];
    for (const id of fields.slice(1)) {
        await page.keyboard.press('Tab'); await expect(page.locator('#' + id)).toBeFocused();
        const outline = await page.locator('#' + id).evaluate(node => ({ id: node.id, width: getComputedStyle(node).outlineWidth, style: getComputedStyle(node).outlineStyle }));
        expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2); expect(outline.style).not.toBe('none'); focus.push(outline);
    }
    for (const name of ['Apply filters', 'Reset filters', 'Search retained files']) { await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name, exact: true })).toBeFocused(); }
    await page.keyboard.press('Tab'); await expect(page.locator('#diagnosticsSwitch')).toBeFocused();
    await page.locator('#filter-role').selectOption('pcm'); await page.locator('#filter-level').selectOption('INFO');
    await page.locator('#filter-method').selectOption('GET'); await page.locator('#filter-status').fill('200');
    await page.locator('#filter-healthOrganizationId').fill('ho-a'); await page.locator('#filter-path').fill('/fhir/Observation');
    for (const [id, value] of [['filter-correlationId', 'literal+request/&?='], ['filter-flowId', 'literal+flow/&?='], ['filter-traceId', 'literal+trace/&?='], ['search-source', 'pcm-core']]) await page.locator('#' + id).fill(value);
    const before = reads.length; await page.locator('#filter-status').press('Enter'); await expect.poll(() => reads.length).toBeGreaterThan(before);
    const params = new URL(page.url()).searchParams;
    for (const [name, value] of Object.entries({ role: 'pcm', level: 'INFO', method: 'GET', status: '200', healthOrganizationId: 'ho-a', path: '/fhir/Observation', correlationId: 'literal+request/&?=', flowId: 'literal+flow/&?=', traceId: 'literal+trace/&?=', source: 'pcm-core' })) expect(params.get(name)).toBe(value);
    await open(page, info); await activate(page.getByRole('button', { name: 'Reset filters', exact: true }), info);
    await expect.poll(() => new URL(page.url()).searchParams.has('role')).toBe(false);
    await open(page, info); for (const id of fields) expect(await page.locator('#' + id).inputValue()).toBe('');
    await activate(page.locator('#diagnosticsSwitch'), info); expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('true');
    await page.locator('#filter-level').selectOption('INFO'); await activate(page.getByRole('button', { name: 'Apply filters', exact: true }), info);
    expect(new URL(page.url()).searchParams.get('level')).toBe('INFO'); expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('true');
    await open(page, info); await activate(page.getByRole('button', { name: 'Reset filters', exact: true }), info); await open(page, info);
    expect(await page.locator('#diagnosticsSwitch').isChecked()).toBe(true);
    await activate(page.locator('#diagnosticsSwitch'), info); expect(await page.locator('#diagnosticsSwitch').isChecked()).toBe(false);
    await page.locator('#search-source').fill('pcm-core'); await page.locator('#search-text').fill('columns exact id fixture');
    await page.locator('#search-since').fill('2026-01-01T00:00:00Z'); await page.locator('#search-until').fill('2027-01-01T00:00:00Z');
    await activate(page.locator('#search-start'), info); await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await expect(page.locator('.log-row')).toHaveCount(1); await expect(page.locator('#search-progress')).toContainText('1 matches');
    expect(queries.at(-1)).toMatchObject({ source: 'pcm-core', text: 'columns exact id fixture', since: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z', diagnostics: 'false' });
    await activate(page.locator('#search-return'), info); await expect(page.locator('#search-banner')).toBeHidden();
    await open(page, info); await activate(page.getByRole('button', { name: 'Reset filters', exact: true }), info); await open(page, info);
    for (const id of fields) expect(await page.locator('#' + id).inputValue()).toBe('');
    for (const panel of ['columns', 'coverage']) { await activate(page.locator(`[data-panel-tab="${panel}"]`), info); await expect(page.locator(`[data-panel="${panel}"]`)).toBeVisible(); }
    await activate(page.locator('[data-panel-tab="filters"]'), info);
    // Every affected initial field/action keeps its authored popup reachable, including
    // controls near the scroll boundary; activating a popup must retain field values.
    await activate(page.locator('#close-workbench'), info);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await open(page, info);
    const popupChecks = [];
    for (const locator of [...fields.map(id => page.locator('#' + id)), page.getByRole('button', { name: 'Apply filters', exact: true }), page.getByRole('button', { name: 'Reset filters', exact: true }), page.locator('#search-start'), page.locator('#diagnosticsSwitch')]) {
        if (info.project.name.endsWith('mobile') && await locator.evaluate(node => node.matches('input:not([type=checkbox])'))) await locator.tap(); else await locator.focus();
        await expect(page.getByRole('tooltip')).toBeVisible();
        const text = await page.getByRole('tooltip').innerText(), rect = await page.getByRole('tooltip').boundingBox();
        expect(text.length).toBeGreaterThan(30); expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
        popupChecks.push(text.split('\n')[0]); await activate(page.getByRole('button', { name: 'Dismiss explanation' }), info);
    }
    // Explicitly retain OFF before final accessibility checks.
    if (await page.locator('#diagnosticsSwitch').isChecked()) await activate(page.locator('#diagnosticsSwitch'), info);
    if (await page.getByRole('button', { name: 'Dismiss explanation' }).isVisible()) await activate(page.getByRole('button', { name: 'Dismiss explanation' }), info);
    await activate(page.locator('#close-workbench'), info); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck(); await open(page, info);
    const axe = await new AxeBuilder({ page }).include('[data-panel="filters"]').analyze(); expect(axe.violations).toEqual([]); expect(errors).toEqual([]);
    fs.writeFileSync(info.outputPath('interactions.json'), JSON.stringify({ reads, queries, focus, popupChecks, errors, axe: axe.violations }, null, 2));
});
