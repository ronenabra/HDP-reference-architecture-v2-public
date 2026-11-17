'use strict';
/** Actual mounted auxiliary forms and shared Help with synthetic upstream transport only. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.AUXILIARY_ROOT;
if (!root || !fs.existsSync(path.join(root, 'test-support/auxiliary-ui-fixture.js'))) throw new Error('Required current auxiliary fixture is absent');

/** Inspect representative responsive geometry and the actual ordinary Help interaction. */
async function inspect(page, info, name, target, text) {
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) {
        await toggle.uncheck(); await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => { document.body.style.zoom = String(value); }, zoom);
        const geometry = () => target.evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height }; });
        const before = await geometry(); await toggle.check(); expect(await geometry()).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const controls = page.locator('header .sandbox-navigation > a, .explain-bar .explain-toggle');
        expect(await controls.evaluateAll(nodes => nodes.filter(node => node.matches('a,.explain-toggle')).every(node => node.getBoundingClientRect().height >= 43))).toBe(true);
        await page.screenshot({ path: info.outputPath(`${name}-${width}-${zoom}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.body.style.zoom = '1'; }); await page.setViewportSize({ width: 390, height: 1000 });
    await toggle.focus(); await target.focus(); await expect(page.getByRole('tooltip')).toContainText(text);
    await page.keyboard.press('Escape'); await expect(target).toBeFocused(); await expect(page.getByRole('tooltip')).toBeHidden();
    await toggle.focus(); await target.focus(); await expect(page.getByRole('tooltip')).toContainText(text);
    await page.getByRole('button', { name: 'Dismiss explanation' }).tap(); await expect(target).toBeFocused();
    await toggle.uncheck();
}

test('AUX management saves exact payload after native validation recovery and preserves header/context on history', async ({ page }, info) => {
    const f = await require(path.join(root, 'test-support/auxiliary-ui-fixture')).startAuxiliaryFixture();
    const posts = [], errors = []; page.on('request', request => { if (request.method() === 'POST') posts.push({ url: request.url(), body: request.postData() }); }); page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(f.doctor + '/manage?identity=hospital-a');
        const input = page.locator('form[action$="/manage/endpoint"] textarea'), save = page.getByRole('button', { name: 'Update endpoint', exact: true });
        await inspect(page, info, 'manage', save, 'Submit this endpoint');
        const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
        await toggle.check(); await page.locator('[data-help-key="doctor.endpoint-card"] > .card-header .badge').hover();
        await expect(page.getByRole('tooltip')).toContainText('lifecycle state'); await page.keyboard.press('Escape'); await toggle.uncheck();
        expect(posts).toEqual([]); expect(f.calls.filter(row => row.action !== 'read')).toEqual([]);
        const draft = JSON.parse(await input.inputValue()); draft.name = 'Corrected endpoint';
        f.state.unavailable = true;
        await input.fill('{"unfinished":'); await save.tap();
        await expect(page.getByRole('alert')).toContainText('Endpoint update failed'); await expect(input).toHaveValue('{"unfinished":'); await expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(f.calls.filter(row => row.action === 'update')).toEqual([]);
        await page.screenshot({ path: info.outputPath('manage-validation-390.png'), fullPage: true });
        await expect(page.locator('main')).toContainText('The current record is unavailable. This draft was not saved.');
        f.state.unavailable = false;
        await input.fill(JSON.stringify(draft)); await save.tap(); await expect(page.getByRole('status')).toContainText('Endpoint updated.'); await expect(input).not.toHaveAttribute('aria-invalid');
        expect(new URLSearchParams(posts.at(-1).body).get('jsonContent')).toBe(JSON.stringify(draft));
        expect(new URLSearchParams(posts.at(-1).body).get('identity')).toBe('hospital-a'); expect(new URLSearchParams(posts.at(-1).body).get('id')).toBe(f.endpoint.id);
        expect(f.calls.filter(row => row.action === 'update')).toEqual([{ action: 'update', type: 'Endpoint', id: f.endpoint.id, data: draft, identity: 'hospital-a' }]);
        await page.getByRole('link', { name: 'Back to Doctor', exact: true }).tap(); await expect(page).toHaveURL(f.doctor + '/?identity=hospital-a');
        await page.goBack(); await expect(page).toHaveURL(f.doctor + '/manage?identity=hospital-a');
        await page.goForward(); await expect(page.locator('#doctor-identity')).toHaveValue('hospital-a');
        const count = posts.length, tools = page.locator('#doctor-tools-button');
        await tools.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('link', { name: 'Test SMART application launch', exact: true })).toBeFocused();
        await page.keyboard.press('Escape'); await expect(tools).toBeFocused();
        await tools.tap(); await page.getByRole('button', { name: 'Close tools', exact: true }).tap(); await expect(tools).toBeFocused();
        await tools.tap(); await page.getByRole('link', { name: 'Manual request testing', exact: true }).tap();
        await expect(page.locator('#manual-testing')).toHaveAttribute('open', '');
        await inspect(page, info, 'manual', page.locator('#manual-consent-id'), 'PCM consent record');
        await expect(page.locator('#manual-testing')).toContainText('cannot change approved sources, scope or patient authority');
        expect(posts).toHaveLength(count);
        expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => /endpoint|catalog|manage/.test(key)))).toBe(false);
        expect(page.url()).not.toMatch(/jsonContent|access_token|client_assertion|private_key|client_secret/); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('management-wire.json'), JSON.stringify({ posts, calls: f.calls, errors }, null, 2));
    } finally { await f.close(); }
});

test('AUX wrappers retain raw renderer boundaries and SMART success/denied/expired return context', async ({ page, context }, info) => {
    const f = await require(path.join(root, 'test-support/auxiliary-ui-fixture')).startAuxiliaryFixture();
    const errors = [], external = []; page.on('pageerror', error => errors.push(error.message));
    // The vendored renderer's external CDN is intentionally outside this no-network qualification.
    await context.addInitScript(() => { window.Redoc = { init: (spec, options, container) => { container.textContent = 'Generated reference document (renderer excluded from offline shell qualification).'; } }; });
    await context.route('https://cdn.redocly.com/**', route => { external.push(route.request().url()); return route.fulfill({ contentType: 'application/javascript', body: 'window.Redoc={init:function(){}};' }); });
    try {
        for (const reference of ['api', 'admin-api']) {
            await page.goto(f.pcm + '/docs/' + reference);
            await inspect(page, info, reference, page.getByRole('link', { name: 'PCM API', exact: true }), 'API reference');
            await expect(page.locator('iframe')).toHaveAttribute('src', '/pcm/docs/' + reference + '/content');
            expect(await page.locator('iframe').contentFrame().locator('.explain-toggle, .sandbox-header').count()).toBe(0);
            await page.getByRole('link', { name: 'Open reference document', exact: true }).tap(); await expect(page).toHaveURL(f.pcm + '/docs/' + reference + '/content');
            await page.goBack(); await expect(page).toHaveURL(f.pcm + '/docs/' + reference);
        }
        await page.goto(f.doctor + '/missing?client_secret=DO-NOT-ECHO');
        await inspect(page, info, 'missing', page.getByRole('link', { name: 'Back to Doctor', exact: true }), 'Doctor');
        await expect(page.locator('body')).not.toContainText('DO-NOT-ECHO');
        await page.getByRole('link', { name: 'Back to Doctor', exact: true }).tap();
        for (const outcome of ['success', 'denied', 'expired']) {
            f.state.expired = outcome === 'expired';
            const start = await context.request.get(f.doctor + '/smart/start?identity=hospital-a&scope=patient%2FObservation.rs', { maxRedirects: 0 });
            expect(start.status()).toBe(302); const state = new URL(start.headers().location).searchParams.get('state');
            const callback = new URL(f.doctor + '/callback'); callback.searchParams.set('state', state);
            if (outcome === 'denied') { callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('error_description', 'untrusted-instruction-DO-NOT-ECHO'); } else callback.searchParams.set('code', 'synthetic-code');
            await page.goto(callback.toString()); await expect(page).toHaveURL(f.doctor + (outcome === 'expired' ? '/' : '/?identity=hospital-a'));
            await expect(page.locator('[data-smart-message]')).toHaveText(outcome === 'success' ? 'SMART code exchange completed' : outcome === 'denied' ? 'SMART test denied.' : 'SMART request expired or unavailable.');
            await expect(page.locator('body')).not.toContainText('untrusted-instruction-DO-NOT-ECHO');
            expect(page.url()).not.toMatch(/code=|state=|token=|secret=|assertion=/);
            await inspect(page, info, 'smart-' + outcome, page.getByRole('link', { name: 'Start a fresh SMART test', exact: true }), 'fresh');
        }
        expect(f.calls.filter(row => row.action === 'exchange')).toHaveLength(2); expect(f.calls.filter(row => ['update', 'catalog'].includes(row.action))).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('wrapper-smart-receipt.json'), JSON.stringify({ calls: f.calls, externalRendererStubbed: external.length > 0, errors }, null, 2));
    } finally { await f.close(); }
});
