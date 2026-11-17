'use strict';
/** Real browser clipboard readback; no clipboard API mocks in success/restricted cases. */
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
/** Keyboard activation on desktop and native touch events on the mobile profile. */
async function activate(locator, info) { if (info.project.name.endsWith('mobile')) await locator.tap(); else { await locator.focus(); await locator.press('Enter'); } }
/** Load a real selected API record with its full normalized JSON and supplied source. */
async function select(page, info, order, origin = '') {
    await page.addInitScript(order => {
        localStorage.setItem('unifiedLogOrderMode', order); localStorage.setItem('unifiedLogTailPosition', 'top');
        if (window.copyActivations) return;
        window.copyActivations = [];
        document.addEventListener('click', event => {
            if (!event.target.closest('#copy-detail, [data-help-key="logs.copy-value"]')) return;
            window.copyActivations.push({ trusted: event.isTrusted, focused: document.hasFocus(), active: navigator.userActivation.isActive });
        }, true);
    }, order);
    await page.goto(origin + '/logs-view?diagnostics=true');
    if (await page.locator('#close-workbench').isVisible()) await activate(page.locator('#close-workbench'), info);
    const id = await page.evaluate(() => currentLogs.find(row => row.message === 'Opaque issuance fixture').id);
    await activate(page.locator(`[data-log-id="${id}"]`), info);
    await activate(page.locator('#tab-structured'), info);
    await expect(page.locator('#record-explorer-host')).toContainText('Issuance-time server record');
    return page.evaluate(() => ({ json: JSON.stringify(selectedResult.entry, null, 2), raw: selectedResult.raw, value: selectedResult.entry.details.access_token, lines: selectedResult.entry.details.issuanceRecord.lineEndings }));
}
/** A separate focused secure document reads the native clipboard, including HTTP fallback output. */
async function readClipboard(reader) { await reader.bringToFront(); return reader.evaluate(() => navigator.clipboard.readText()); }
for (const order of ['timeline', 'flow']) test(`native and insecure HTTP legacy clipboard ${order}`, async ({ page, context }, info) => {
    await page.request.post('/fixture/reset');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:43188' });
    const reader = await context.newPage(); await reader.goto('/healthz');
    const capabilities = [];
    for (const origin of ['http://127.0.0.1:43188', 'http://logs-copy.invalid:43188']) {
        const values = await select(page, info, order, origin);
        capabilities.push(await page.evaluate(async () => ({ origin: location.origin, secure: isSecureContext, api: !!navigator.clipboard,
            focused: document.hasFocus(), permission: await navigator.permissions.query({ name: 'clipboard-write' }).then(p => p.state).catch(e => e.name) })));
        if (origin.includes('invalid')) {
            expect(capabilities.at(-1)).toMatchObject({ secure: false, api: false });
            const baseline = await page.evaluate(async () => {
                const results = [];
                for (const text of [JSON.stringify(selectedResult.entry, null, 2), selectedResult.raw]) {
                    try { await navigator.clipboard.writeText(text); results.push('accepted'); }
                    catch (error) { results.push(error.name); }
                }
                return results;
            });
            expect(baseline).toEqual(['TypeError', 'TypeError']); capabilities.at(-1).originalDirectCall = baseline;
        }
        for (const tab of ['structured', 'raw']) {
            await page.bringToFront(); await activate(page.locator('#tab-' + tab), info);
            const before = await page.evaluate(() => ({ id: selectedId, tab: activeDetailTab, pane: document.querySelector('#details-pane').scrollTop, list: document.querySelector('#log-list').scrollTop }));
            await activate(page.locator('#copy-detail'), info);
            await expect(page.locator('#detail-status')).toContainText('copied');
            expect(await readClipboard(reader)).toBe(tab === 'raw' ? values.raw : values.json);
            expect(await page.evaluate(() => ({ id: selectedId, tab: activeDetailTab, pane: document.querySelector('#details-pane').scrollTop, list: document.querySelector('#log-list').scrollTop }))).toEqual(before);
            await expect(page.locator('#copy-detail')).toBeFocused();
        }
        await page.bringToFront(); await activate(page.locator('#tab-structured'), info);
        await page.getByRole('searchbox', { name: 'Search field names or values' }).fill('access_token');
        await activate(page.getByRole('button', { name: 'Search fields', exact: true }), info);
        const match = page.locator('.field-match').filter({ hasText: '$["details"]["access_token"]' }).first();
        await activate(match.getByRole('button', { name: 'Copy match value' }), info);
        await expect(page.locator('#detail-status')).toContainText('copied'); expect(await readClipboard(reader)).toBe(values.value);
        await page.bringToFront();
        await page.getByRole('searchbox', { name: 'Search field names or values' }).fill('lineEndings');
        await activate(page.getByRole('button', { name: 'Search fields', exact: true }), info);
        await activate(page.locator('.field-match').filter({ hasText: '$["details"]["issuanceRecord"]["lineEndings"]' }).getByRole('button', { name: 'Copy match value' }), info);
        await expect(page.locator('#detail-status')).toContainText('copied'); expect(await readClipboard(reader)).toBe(values.lines);
        // Real history rebuilding and retained selection after append/rotation.
        await page.bringToFront(); await activate(page.locator('[data-inspect-field="flowId"]'), info);
        await expect.poll(() => page.evaluate(() => searchSession?.state)).toBe('complete');
        await activate(page.locator('#return-to-results'), info);
        await page.request.post('/fixture/append'); await page.evaluate(() => refreshLogs());
        await page.request.post('/fixture/rotate');
        await activate(page.locator('#copy-detail'), info); await expect(page.locator('#detail-status')).toContainText('copied'); expect(await readClipboard(reader)).toBe(values.json);
        await page.bringToFront();
        await page.request.post('/fixture/aws-raw');
        await page.evaluate(() => refreshLogs(true));
        const awsId = await page.evaluate(() => currentLogs.find(row => row.message === 'AWS raw projection fixture').id);
        await activate(page.locator(`[data-log-id="${awsId}"]`), info);
        await expect(page.locator('#record-explorer-host')).toBeVisible();
        await activate(page.locator('#tab-raw'), info);
        await expect(page.locator('#panel-raw')).toContainText('AWS-safe source projection');
        const awsRaw = await page.evaluate(() => selectedResult.raw);
        await activate(page.locator('#copy-detail'), info); await expect(page.locator('#detail-status')).toContainText('AWS-safe source projection copied');
        expect(await readClipboard(reader)).toBe(awsRaw); expect(awsRaw).not.toContain('owned-synthetic-aws-secret');
        await page.bringToFront(); await activate(page.locator('#tab-structured'), info);
        const unknownId = await page.evaluate(() => currentLogs.find(row => row.message === 'Unknown field fixture').id);
        await activate(page.locator(`[data-log-id="${unknownId}"]`), info);
        await expect(page.locator('#record-explorer-host')).toContainText('No specialized view');
        await page.getByRole('searchbox', { name: 'Search field names or values' }).fill('a.b');
        await activate(page.getByRole('button', { name: 'Search fields', exact: true }), info);
        await activate(page.locator('.field-match').filter({ hasText: '$["details"][""]["a.b"]' }).getByRole('button', { name: 'Explore match' }), info);
        await activate(page.locator('.explorer-tree summary'), info);
        const childRows = page.locator('.explorer-children > .explorer-row');
        for (const [index, expected] of ['null', 'false', '0', '', '{}', '[]'].entries()) {
            await page.bringToFront(); await activate(childRows.nth(index).getByRole('button', { name: 'Copy value', exact: true }).first(), info);
            await expect(page.locator('#detail-status')).toContainText('copied'); expect(await readClipboard(reader)).toBe(expected);
        }
        await page.bringToFront(); page.once('dialog', dialog => dialog.accept()); await page.evaluate(() => clearLogs());
        await expect(page.locator('#copy-detail')).toBeDisabled(); await expect(page.locator('#manual-copy')).toBeHidden();
        const activations = await page.evaluate(() => copyActivations);
        expect(activations.length).toBeGreaterThan(10);
        expect(activations.every(item => item.trusted && item.focused && item.active)).toBe(true);
        capabilities.at(-1).activations = activations;
        // Disabled copy still exposes the authored explanation through its proxy.
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const copyHelp = page.getByRole('button', { name: 'Explain Copy selected format', exact: true });
        // Disabled-control proxies are intentionally keyboard-only affordances.
        await copyHelp.focus();
        await expect(page.getByRole('tooltip')).toContainText('Select copy text');
        const dismiss = page.getByRole('button', { name: 'Dismiss explanation' }); if (await dismiss.isVisible()) await dismiss.click();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.request.post('/fixture/reset');
    }
    fs.writeFileSync(info.outputPath('capabilities.json'), JSON.stringify({ project: info.project.name, order, capabilities, newline: 'Native readText matched exact supplied raw text, and CR/LF-bearing field values exactly; no conversion observed on Linux Chromium.' }, null, 2));
});

test('permission rejection and restricted manual copy remain truthful and selectable', async ({ page, context }, info) => {
    await page.request.post('/fixture/reset');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:43188' });
    const reader = await context.newPage(); await reader.goto('/healthz');
    // Real browser Permissions Policy blocks async Clipboard API in this document.
    await page.route('**/logs-view?**', async route => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'permissions-policy': 'clipboard-write=()' } }); });
    const values = await select(page, info, 'timeline');
    const restriction = await page.evaluate(async () => {
        let rejection;
        try { await navigator.clipboard.writeText('policy-probe'); rejection = 'accepted'; } catch (error) { rejection = error.name; }
        return { origin: location.origin, secure: isSecureContext, api: !!navigator.clipboard, focused: document.hasFocus(), rejection };
    });
    expect(restriction.rejection).toBe('NotAllowedError');
    for (const [tab, value] of [['structured', values.json], ['raw', values.raw]]) {
        await page.bringToFront(); await activate(page.locator('#tab-' + tab), info); await activate(page.locator('#copy-detail'), info);
        // execCommand remains supported in Chromium even when async API is denied.
        await expect(page.locator('#detail-status')).toContainText('copied'); expect(await readClipboard(reader)).toBe(value);
    }
    // Force only the legacy command boundary to reject: actual manual keyboard/touch
    // selection + browser Copy event still writes to the native clipboard.
    await page.evaluate(() => { document.execCommand = () => false; });
    for (const [tab, value] of [['structured', values.json], ['raw', values.raw]]) {
        await page.bringToFront(); await activate(page.locator('#tab-' + tab), info); await activate(page.locator('#copy-detail'), info);
        await expect(page.locator('#manual-copy')).toBeVisible(); await expect(page.locator('#detail-status')).toContainText('blocked');
        await expect(page.locator('#manual-copy-text')).toHaveValue(value.replace(/\r\n?/g, '\n'));
        await activate(page.getByRole('button', { name: 'Select copy text', exact: true }), info);
        expect(await page.locator('#manual-copy-text').evaluate(el => el.selectionEnd - el.selectionStart)).toBe(value.replace(/\r\n?/g, '\n').length);
        await page.keyboard.press('Control+c');
        expect(await readClipboard(reader)).toBe(value.replace(/\r\n?/g, '\n'));
        await expect(page.locator('#detail-status')).toContainText('not been confirmed');
    }
    await page.bringToFront();
    fs.writeFileSync(info.outputPath('restriction.json'), JSON.stringify({ project: info.project.name, restriction,
        manual: 'Real native clipboard readback after touch/keyboard Select copy text and Control+C; only legacy failure was injected. No Android/iOS OS menu is emulated.',
        newline: 'Manual textarea normalizes CR/LF to LF. Programmatic CR/LF values are independently read back exactly.' }, null, 2));
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const manualHelp = page.locator('[data-help-key="logs.copy-manual"]').first();
    if (info.project.name.endsWith('mobile')) await manualHelp.tap(); else await page.locator('#manual-copy-text').focus();
    await expect(page.getByRole('tooltip')).toContainText('Selection alone does not confirm');
    const dismiss = page.getByRole('button', { name: 'Dismiss explanation' }); if (await dismiss.isVisible()) await dismiss.click();
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await activate(page.locator('#tab-structured'), info); await expect(page.locator('#manual-copy')).toBeHidden();
});

test('manual field newline conversion with native clipboard readback', async ({ page, context }, info) => {
    await page.request.post('/fixture/reset');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:43188' });
    const reader = await context.newPage(); await reader.goto('/healthz');
    await page.route('**/logs-view?**', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, headers: { ...response.headers(), 'permissions-policy': 'clipboard-write=()' } });
    });
    const values = await select(page, info, 'timeline');
    await page.evaluate(() => { document.execCommand = () => false; });
    await page.bringToFront();
    await page.getByRole('searchbox', { name: 'Search field names or values' }).fill('lineEndings');
    await activate(page.getByRole('button', { name: 'Search fields', exact: true }), info);
    await activate(page.locator('.field-match').filter({ hasText: '$["details"]["issuanceRecord"]["lineEndings"]' }).getByRole('button', { name: 'Copy match value' }), info);
    await expect(page.locator('#manual-copy')).toBeVisible();
    const expected = values.lines.replace(/\r\n?/g, '\n');
    await expect(page.locator('#manual-copy-text')).toHaveValue(expected);
    await activate(page.getByRole('button', { name: 'Select copy text', exact: true }), info);
    await page.keyboard.press('Control+c'); expect(await readClipboard(reader)).toBe(expected);
    await expect(page.locator('#detail-status')).toContainText('not been confirmed');
    fs.writeFileSync(info.outputPath('manual-newlines.json'), JSON.stringify({ project: info.project.name,
        original: values.lines, pasted: expected, conversion: 'CRLF and lone CR normalize to LF in manual textarea copy; native clipboard readback verified.' }, null, 2));
});
