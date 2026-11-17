'use strict';
/** Actual reference renderers exercise the shared disabled-touch repair without writes. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.DOCTOR_UI_ROOT || path.resolve(__dirname, '../../..');
const { startApprovalFixture } = require(path.join(root, 'test-support/approval-scope-fixture'));
const { installWorkbenchFixture } = require(path.join(root, 'pcm-connectathon/ui/tests/logs-workbench-fixture'));
const ejs = require('node:module').createRequire(path.join(root, 'package.json'))('ejs');
let fixture;
test.beforeAll(async () => { fixture = await startApprovalFixture(); });
test.afterAll(async () => { await fixture?.close(); });

/** Form values, selected states and target geometry must survive Help. */
const values = page => page.locator('form [name]').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked, node.disabled]));
for (const consumer of ['Consent', 'Admin', 'Logs']) test(`${consumer}: reference hover/focus, native disabled touch and dynamic cleanup`, async ({ page }, info) => {
    const consent = fixture.create(), writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) {
            writes.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
            return route.abort();
        }
        return route.continue();
    });
    if (consumer === 'Logs') {
        const html = ejs.render(fs.readFileSync(path.join(root, 'src/pcm-core/src/views/logs.ejs'), 'utf8'), { teamId: 'explain-fixture', browserBase: '' });
        await page.route('**/logs-parity', route => route.fulfill({ body: html, contentType: 'text/html' }));
        await installWorkbenchFixture(page, { count: 4 });
    }
    await page.goto(fixture.base + (consumer === 'Consent' ? `/ui/approve/${consent.id}` : consumer === 'Admin' ? '/admin' : '/logs-parity'));
    if (consumer === 'Logs') await expect(page.locator('.log-row')).toHaveCount(4);
    const selector = consumer === 'Consent' ? '[data-help-key="pcm.approve"]' : consumer === 'Admin' ? '[data-help-key="admin.refresh"]' : '#follow-latest';
    const action = page.locator(selector).first(), toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await action.scrollIntoViewIfNeeded();
    const before = await values(page), stored = JSON.stringify(fixture.store.get('Consent', consent.id));
    const originalBox = await action.boundingBox();
    await toggle.check(); await action.scrollIntoViewIfNeeded();
    expect(await action.boundingBox()).toEqual(originalBox);
    await action.focus(); await expect(page.getByRole('tooltip')).toBeVisible();
    await page.getByRole('tooltip').getByRole('button', { name: 'Dismiss explanation' }).focus();
    await page.keyboard.press('Escape'); await expect(action).toBeFocused();
    await expect(page.getByRole('tooltip')).toBeHidden();
    // Real existing controls change disabled state as application results arrive.
    await action.evaluate(node => { node.disabled = true; });
    const key = await action.getAttribute('data-help-key');
    const proxy = page.locator(`[data-help-for="${key}"]`).first();
    await expect(proxy).toHaveCount(1);
    if (info.project.name === 'mobile') {
        await action.scrollIntoViewIfNeeded(); const bounds = await action.boundingBox();
        await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await expect(page.getByRole('tooltip')).toBeVisible();
        // Touch pointer departure must not expire a disabled target's explanation.
        await page.waitForTimeout(350);
        await expect(page.getByRole('tooltip')).toBeVisible();
    } else {
        await action.hover(); await expect(page.getByRole('tooltip')).toBeVisible();
        await proxy.focus();
    }
    await expect(action).toHaveClass(/explain-target/);
    await expect(action).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`${consumer.toLowerCase()}-disabled-help.png`), fullPage: true });
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    if (info.project.name === 'mobile') await expect(toggle).toBeFocused(); else await expect(proxy).toBeFocused();
    await action.evaluate(node => { node.disabled = false; });
    await expect(proxy).toHaveCount(0); await expect(page.getByRole('tooltip')).toBeHidden();
    await toggle.uncheck();
    expect(await values(page)).toEqual(before);
    expect(JSON.stringify(fixture.store.get('Consent', consent.id))).toBe(stored);
    expect(writes).toEqual([]); expect(errors).toEqual([]);
});
