'use strict';
/** Qualify the direct Apply UI using local assets and a mock command, without application mutation. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
test('source command enables only changed selections and applies directly @smoke', async ({ page }) => {
    const commands = [];
    await page.route('https://source-form.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/command') {
            commands.push(route.request().postDataJSON());
            // Authentication failure avoids a reload, so the submitted body can be inspected.
            return route.fulfill({ status: 401, json: { error: 'Login required' } });
        }
        if (['/connectathon.css', '/source-change.js'].includes(url.pathname)) return route.fulfill({ body: fs.readFileSync(path.join(process.env.PCM_HELP_ASSETS || '/ui-assets', url.pathname.slice(1))), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Source command</title><link rel="stylesheet" href="/connectathon.css"><script defer src="/source-change.js"></script></head><body><main><h1>Source command</h1><form data-source-change action="/command"><input type="hidden" name="expectedVersion" value="2"><input type="hidden" name="csrf" value="fixture"><label><input type="checkbox" name="sourceIds" value="A" checked>Source A</label><label><input type="checkbox" name="sourceIds" value="B">Source B</label><label><input type="checkbox" name="sourceIds" value="C" disabled>Unavailable source</label><p data-source-result role="status"></p><button class="btn btn-primary" type="submit" data-source-apply disabled>Save source changes</button><button class="btn btn-secondary" type="button" data-source-cancel>Discard unsaved changes</button></form></main></body></html>` });
    });
    await page.goto('https://source-form.test/');
    const apply = page.getByRole('button', { name: 'Save source changes' });
    const cancel = page.getByRole('button', { name: 'Discard unsaved changes' });
    await expect(apply).toBeVisible(); await expect(apply).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await expect(apply).toHaveCSS('opacity', '0.45');
    await expect(cancel).toHaveCSS('cursor', 'not-allowed');
    await expect(page.getByRole('button', { name: /Simulate|Preview/ })).toHaveCount(0);
    const b = page.getByRole('checkbox', { name: 'Source B' });
    await b.check(); await expect(apply).toBeEnabled(); await expect(cancel).toBeEnabled();
    await expect(apply).toHaveCSS('opacity', '1');
    await expect(apply).toHaveCSS('cursor', 'pointer');
    await b.uncheck(); await expect(apply).toBeDisabled(); await expect(cancel).toBeDisabled();
    await b.check(); await page.getByRole('button', { name: 'Discard unsaved changes' }).click();
    await expect(apply).toBeDisabled(); await expect(cancel).toBeDisabled(); await expect(b).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Source A' }).uncheck();
    await apply.click();
    await expect(page.locator('[data-source-result]')).toContainText('Admin login is required');
    expect(commands).toEqual([{ action: 'apply', sourceIds: [], expectedVersion: '2', csrf: 'fixture' }]);
    await expect(page.getByRole('checkbox', { name: 'Unavailable source' })).toBeDisabled();
});
