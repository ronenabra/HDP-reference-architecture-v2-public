'use strict';
/** Real API, bounded notice and reversible source navigation with keyboard/native touch. */
const { test, expect } = require('@playwright/test');
const { FLOW } = require('../../../test-support/log-classification-corpus');
/** Use native touch on mobile; focus/Enter on desktop. */
async function activate(locator, info) { if (info.project.name.includes('mobile')) await locator.tap(); else { await locator.focus(); await locator.press('Enter'); } }
/** Diagnostics is a Filters checkbox, retained even when its panel is collapsed. */
async function checked(page) { return page.locator('#diagnosticsSwitch').isChecked(); }

for (const order of ['flow', 'timeline']) test(`same journey, notice, filters, inspection, export and live ${order}`, async ({ page }, info) => {
    await page.request.post('/fixture/reset');
    const selection = await page.request.post('/selection');
    expect(selection.status()).toBe(200); expect(selection.headers()['x-flow-id']).toBeUndefined();
    await page.addInitScript(order => localStorage.setItem('unifiedLogOrderMode', order), order);
    await page.goto('/logs-view?diagnostics=false');
    await expect(page.locator('#critical-diagnostic-notice')).toBeVisible();
    await expect(page.locator('#critical-diagnostic-notice')).toHaveCount(1);
    expect(await page.evaluate(() => currentLogs.some(row => row.details.visibility === 'diagnostic'))).toBe(false);
    const off = await (await page.request.get('/api/unified-logs?page=true&diagnostics=false')).json();
    for (const type of ['TOKEN_ISSUED', 'DS_LOCAL_TOKEN_MINTED', 'INTROSPECTION_DECISION', 'LOCAL_JWT_VERIFIED', 'LOCAL_JWT_METADATA_CACHE_HIT']) expect(off.entries.some(row => row.details.type === type), type).toBe(true);
    for (const url of ['/', '/favicon.ico', '/auth', '/arbitrary-wrong-path']) expect(off.entries.some(row => row.details.type === 'GATEWAY_ERROR' && row.details.url === url), url).toBe(true);
    expect(off.entries.some(row => row.details.stage === 'config')).toBe(false);
    const target = off.criticalDiagnostic; expect(target.reference).toBeTruthy(); expect(target.details.payload).toBeUndefined();
    expect(target.details.type).toBe('PROCESS_RELOAD_FAILED'); expect(target.event.source.componentId).toBe('ds-fhir-server');
    expect(off.entries.some(row => row.id === target.id)).toBe(false);
    expect(off.entries.some(row => row.message.startsWith('DS FHIR server reload failed:'))).toBe(true);
    // Explain focus shows the popup without activating the real action.
    await page.getByRole('checkbox', { name: 'Explain this page' }).click();
    await page.locator('#critical-diagnostic-notice').focus();
    await expect(page.locator('#pcm-help-tooltip')).toContainText('observed');
    expect(await checked(page)).toBe(false);
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await page.getByRole('checkbox', { name: 'Explain this page' }).click();
    // Hold an observed notice while applying excluding filters and while its target is offscreen.
    await page.evaluate(() => { document.getElementById('filter-role').value = 'gateway'; document.getElementById('filter-level').value = 'INFO'; applyFilters(null); });
    await expect.poll(() => page.evaluate(() => currentLogs.every(row => row.details.role === 'gateway' && row.level === 'INFO'))).toBe(true);
    const returnUrl = page.url();
    await activate(page.locator('#critical-diagnostic-notice'), info);
    await expect(page.locator('#critical-diagnostic-status')).toContainText('Exact observed diagnostic error selected');
    expect(await checked(page)).toBe(true); expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('true');
    expect(new URL(page.url()).searchParams.has('role')).toBe(false);
    await expect(page.locator('.log-row.selected')).toHaveCount(1);
    const selected = await page.evaluate(() => ({ id: selectedId, source: selectedResult.source.componentId, raw: selectedResult.raw }));
    expect(selected.id).toBe(target.id); expect(selected.source).toBe(target.event.source.componentId);
    // The actual ID action reuses accepted retained search, preserving Diagnostics ON.
    await activate(page.locator('[data-inspect-field="flowId"]'), info);
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    await expect(page.locator('#investigation-title')).toContainText(FLOW);
    expect(await checked(page)).toBe(true);
    await activate(page.locator('#return-to-results'), info);
    await expect(page.locator('#critical-diagnostic-view')).toBeVisible();
    await activate(page.locator('#critical-diagnostic-view button'), info);
    await expect(page).toHaveURL(returnUrl); expect(await checked(page)).toBe(false);
    await page.goBack(); await expect(page.locator('#critical-diagnostic-view')).toBeVisible();
    await page.goForward(); await expect(page).toHaveURL(returnUrl);
    // ON uses retained search for the same exact flow, with legacy correction and raw retention.
    await page.goto(`/logs-view?diagnostics=true&flowId=${FLOW}`);
    await page.evaluate(() => startSearch({ filters: { flowId: 'classification-journey', diagnostics: 'true' } }));
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    expect(await page.evaluate(() => currentLogs.some(row => row.details.url === '/selection' && row.details.visibility === 'diagnostic' && row.details.causesSystemFlow === false))).toBe(true);
    expect(await page.evaluate(() => currentLogs.some(row => row.message === 'DS FHIR config reload rejected'))).toBe(true);
    await expect(page.locator('#critical-diagnostic-notice')).toBeHidden();
    await activate(page.locator('[data-open-panel="filters"]'), info);
    if (info.project.name.includes('mobile')) await page.locator('#diagnosticsSwitch').tap(); else { await page.locator('#diagnosticsSwitch').focus(); await page.locator('#diagnosticsSwitch').press('Space'); }
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    expect(await checked(page)).toBe(false); expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('false');
    expect(await page.evaluate(() => currentLogs.some(row => row.details.visibility === 'diagnostic'))).toBe(false);
    await activate(page.locator('[data-open-panel="filters"]'), info);
    if (info.project.name.includes('mobile')) await page.locator('#diagnosticsSwitch').tap(); else { await page.locator('#diagnosticsSwitch').focus(); await page.locator('#diagnosticsSwitch').press('Space'); }
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    expect(await checked(page)).toBe(true); expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('true');
    // Full export remains an independent all-evidence contract.
    const exported = await page.request.get('/admin/logs/download');
    expect(exported.ok()).toBe(true); expect(await exported.text()).toContain('DS FHIR config reload rejected');
    await page.goto('/logs-view?diagnostics=false');
    await page.request.post('/fixture/append');
    await page.locator('#follow-latest').click();
    await expect.poll(() => page.evaluate(() => currentLogs.some(row => row.details.url === '/live-wrong-path'))).toBe(true);
    await page.screenshot({ path: info.outputPath(`${order}.png`) });
});

for (const mutation of ['rotate', 'truncate', 'clear']) test(`exact target becomes unavailable after ${mutation}`, async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await page.goto('/logs-view?diagnostics=false');
    await expect(page.locator('#critical-diagnostic-notice')).toBeVisible();
    await page.evaluate(() => { holdReading(); invalidateReads(false); });
    if (mutation === 'clear') await page.request.post('/api/unified-logs/clear'); else await page.request.post(`/fixture/${mutation}`);
    await activate(page.locator('#critical-diagnostic-notice'), info);
    await expect(page.locator('#critical-diagnostic-status')).toContainText('No replacement event was selected');
    expect(await checked(page)).toBe(true); await expect(page.locator('.log-row.selected')).toHaveCount(0);
    expect(await page.evaluate(() => selectedId)).toBeNull();
    await activate(page.locator('#critical-diagnostic-view button'), info);
    expect(await checked(page)).toBe(false);
});

test('a live interval containing only a hidden error still reveals the bounded notice', async ({ page }, info) => {
    await page.request.post('/fixture/routine'); await page.goto('/logs-view?diagnostics=false');
    await expect(page.locator('.log-row')).toHaveCount(1);
    await expect(page.locator('#critical-diagnostic-notice')).toBeHidden();
    const id = await page.evaluate(() => currentLogs[0].id);
    await page.request.post('/fixture/diagnostic-only');
    await activate(page.locator('#follow-latest'), info);
    await expect(page.locator('#critical-diagnostic-notice')).toBeVisible();
    expect(await page.evaluate(() => currentLogs.map(row => row.id))).toEqual([id]);
    await activate(page.locator('#critical-diagnostic-notice'), info);
    await expect(page.locator('#critical-diagnostic-status')).toContainText('Exact observed diagnostic error selected');
    expect(await page.evaluate(() => selectedResult.entry.details.stage)).toBe('config');
    await page.screenshot({ path: info.outputPath('critical-notice-selected.png') });
    await activate(page.locator('#follow-latest'), info);
    await expect(page.locator('#critical-diagnostic-view')).toBeHidden();
    await expect.poll(() => page.evaluate(() => currentLogs.length)).toBeGreaterThan(1);
});

for (const order of ['flow', 'timeline']) test(`sanity harness summaries use the same exact compact notice ${order}`, async ({ page }, info) => {
    await page.request.post('/fixture/sanity');
    await page.addInitScript(order => localStorage.setItem('unifiedLogOrderMode', order), order);
    await page.goto('/logs-view?diagnostics=false');
    await expect(page.locator('#critical-diagnostic-notice')).toBeVisible();
    await expect(page.locator('#critical-diagnostic-notice')).toHaveCount(1);
    const off = await (await page.request.get('/api/unified-logs?page=true&diagnostics=false')).json();
    expect(off.entries.some(row => row.details.type === 'SANITY_CHECK_FAILED' && row.event.source.componentId === 'pcm-core')).toBe(false);
    expect(off.entries.some(row => row.details.type === 'GATEWAY_ERROR')).toBe(true);
    expect(off.entries.some(row => row.details.type === 'PROCESS_RELOAD_FAILED')).toBe(true);
    expect(off.entries.some(row => row.details.type === 'SANITY_CHECK_FAILED' && row.event.source.componentId === 'ho-b-gateway')).toBe(true);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('#critical-diagnostic-notice').focus();
    await expect(page.locator('#pcm-help-tooltip')).toContainText('harness sanity-check failure summaries');
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    const target = off.criticalDiagnostic;
    expect(target.details.type).toBe('SANITY_CHECK_FAILED'); expect(target.event.source.componentId).toBe('pcm-core');
    await page.evaluate(() => { document.getElementById('filter-role').value = 'gateway'; applyFilters(null); });
    await expect.poll(() => page.evaluate(() => currentLogs.every(row => row.details.role === 'gateway'))).toBe(true);
    const priorUrl = page.url();
    await activate(page.locator('#critical-diagnostic-notice'), info);
    await expect(page.locator('#critical-diagnostic-status')).toContainText('Exact observed diagnostic error selected');
    expect(await checked(page)).toBe(true); expect(new URL(page.url()).searchParams.get('diagnostics')).toBe('true');
    expect(await page.evaluate(() => selectedId)).toBe(target.id);
    expect(await page.evaluate(() => selectedResult.entry.details.causesSystemFlow)).toBe(true);
    expect(await page.evaluate(() => selectedResult.raw)).toContain('"visibility":"default"');
    await page.screenshot({ path: info.outputPath(`sanity-selected-${order}.png`) });
    await activate(page.locator('#critical-diagnostic-view button'), info);
    await expect(page).toHaveURL(priorUrl); expect(await checked(page)).toBe(false);
    await page.request.post('/fixture/rotate');
    await activate(page.locator('#critical-diagnostic-notice'), info);
    await expect(page.locator('#critical-diagnostic-status')).toContainText('No replacement event was selected');
    await expect(page.locator('.log-row.selected')).toHaveCount(0); expect(await checked(page)).toBe(true);
    await page.goto('/logs-view?diagnostics=true');
    await expect.poll(() => page.evaluate(() => currentLogs.filter(row => row.event.source.componentId === 'pcm-core' && row.details.type === 'SANITY_CHECK_FAILED').length)).toBe(5);
    const exported = await page.request.get('/admin/logs/download'); expect(exported.ok()).toBe(true);
    expect(await exported.text()).toContain('SANITY_CHECK_FAILED');
});

test('HMO browser wrappers hide while real authentication and protocol evidence remain searchable', async ({ page }, info) => {
    await page.request.post('/fixture/reset'); await page.goto('/logs-view?diagnostics=false');
    await expect.poll(() => page.evaluate(() => currentLogs.some(row => row.details.type === 'SYSTEM_AUTHENTICATION'))).toBe(true);
    expect(await page.evaluate(() => currentLogs.some(row => row.details.type === 'SYSTEM_BROWSER_ACTION' || row.details.url?.startsWith('/sandbox/authentication/')))).toBe(false);
    await page.evaluate(() => startSearch({ filters: { text: 'SYSTEM_BROWSER_ACTION', diagnostics: 'false' } }));
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete'); expect(await page.evaluate(() => currentLogs.length)).toBe(0);
    await page.evaluate(() => startSearch({ filters: { text: 'SYSTEM_BROWSER_ACTION', diagnostics: 'true' } }));
    await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
    expect(await page.evaluate(() => currentLogs.some(row => row.details.type === 'SYSTEM_BROWSER_ACTION' && row.details.visibility === 'diagnostic'))).toBe(true);
    const exported = await page.request.get('/admin/logs/download'); expect(await exported.text()).toContain('SYSTEM_BROWSER_ACTION');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await activate(page.locator('[data-open-panel="filters"]'), info);
    const before = await page.locator('#diagnosticsSwitch').isChecked();
    const help = page.locator('[data-help-for="logs.diagnostics"]'); if (info.project.name.includes('mobile')) await help.tap(); else await help.focus();
    await expect(page.getByRole('tooltip')).toContainText('Actual HMO authentication'); expect(await page.locator('#diagnosticsSwitch').isChecked()).toBe(before); await page.keyboard.press('Escape');
});
