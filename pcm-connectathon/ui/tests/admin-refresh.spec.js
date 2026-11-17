'use strict';
/** Navigation coordination with real authored markup and controlled request races. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.env.PCM_ADMIN_REFRESH_FIXTURE;
const assetRoot = process.env.PCM_UI_ASSET_ROOT || '/ui-assets';
test.beforeEach(() => test.skip(!fixture, 'requires empty Admin fixture'));

/** Keep submission acceptance and status polling independently controllable. */
async function load(page, { resumed = false } = {}) {
    let releaseB;
    const waiting = new Promise(resolve => { releaseB = resolve; });
    const state = { posts: [], navigations: [], bStatus: 202, pollingUnavailable: false,
        operations: { a: { id: 'a', serverId: 'ho-a', phase: 'succeeded', kind: 'import' },
            b: { id: 'b', serverId: 'ho-b', phase: 'loading', currentStage: 'transaction-waiting', kind: 'import' } } };
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) state.navigations.push(frame.url()); });
    await page.route('https://admin-refresh.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/assets/')) {
            const name = path.basename(url.pathname);
            return route.fulfill({ body: fs.readFileSync(path.join(assetRoot, name)), contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript' });
        }
        if (url.pathname.endsWith('/imports')) {
            const id = url.pathname.includes('/ho-a/') ? 'a' : 'b';
            state.posts.push(id);
            if (id === 'b') await waiting;
            return route.fulfill({ status: id === 'b' ? state.bStatus : 202,
                json: id === 'b' && state.bStatus !== 202 ? { error: 'Synthetic submission failure' } : state.operations[id] });
        }
        if (url.pathname.startsWith('/admin/api/data-operations/')) {
            if (state.pollingUnavailable) return route.fulfill({ status: 503, json: { error: 'synthetic status interruption' } });
            return route.fulfill({ json: state.operations[url.pathname.split('/').at(-1)] });
        }
        let html = fs.readFileSync(fixture, 'utf8');
        if (resumed) html = html.replace(/(<section id="data-operation-ho-b"[^>]*data-operation-id=")[^"]*/, '$1b');
        return route.fulfill({ body: html, contentType: 'text/html' });
    });
    await page.goto('https://admin-refresh.test/admin');
    return { state, releaseB };
}

/** Select a tiny file locally; only the intercepted browser request receives it. */
async function choose(page, id) {
    await page.locator(`#bundle-ho-${id}`).setInputFiles({ name: `ho-${id}.source.transaction.json`, mimeType: 'application/json', buffer: Buffer.from('{}') });
}
async function submit(page, id) {
    await page.locator(`[data-managed-fhir-server="ho-${id}"] button[data-help-key="admin.data-import"]`).click();
}

test('Admin polling between pointer down and up retains the disclosure activation target @smoke', async ({ page }) => {
    const { state } = await load(page, { resumed: true });
    const output = page.locator('#data-operation-ho-b');
    await expect(output).toContainText('Import in progress');
    const summary = output.locator('summary');
    await summary.scrollIntoViewIfNeeded();
    const control = await summary.elementHandle();
    const box = await summary.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    state.operations.b.progressEvents = [{ event: 'transaction-waiting', at: new Date().toISOString() }];
    await page.evaluate(operation => renderDataOperation(document.querySelector('#data-operation-ho-b'), operation), state.operations.b);
    expect(await control.evaluate(node => node === document.querySelector('#data-operation-ho-b summary'))).toBe(true);
    await page.mouse.up();
    await expect(output.locator('details')).toHaveAttribute('open', '');
    await expect(output.locator('ol')).toBeVisible();
    expect(state.posts).toEqual([]);
});

for (const failed of [false, true]) test(`Admin waits for pending acceptance then retains ${failed ? 'failed feedback' : 'concurrent polling'} @smoke`, async ({ page }) => {
    const { state, releaseB } = await load(page);
    await choose(page, 'b'); await submit(page, 'b');
    await expect.poll(() => state.posts).toEqual(['b']);
    await choose(page, 'a'); await submit(page, 'a');
    await expect(page.locator('#data-operation-ho-a')).toContainText('Import complete');
    await page.waitForTimeout(900);
    expect(state.navigations).toHaveLength(1);
    await expect(page.locator('[data-admin-refresh]')).toBeDisabled();
    if (failed) state.bStatus = 502;
    releaseB();
    if (failed) {
        await expect(page.locator('#data-operation-ho-b > p')).toContainText('request could not be completed');
        await page.waitForTimeout(900);
        expect(state.navigations).toHaveLength(1);
        await expect(page.locator('[data-admin-refresh]')).toBeEnabled();
        await expect(page.locator('[data-admin-refresh-status]')).toContainText('needs attention');
        await page.locator('[data-admin-refresh]').click();
        await expect.poll(() => state.navigations.length).toBe(2);
    } else {
        await expect(page.locator('#data-operation-ho-b')).toContainText('Import in progress');
        await page.waitForTimeout(900);
        expect(state.navigations).toHaveLength(1);
        state.operations.b.phase = 'succeeded';
        await expect.poll(() => state.navigations.length).toBe(2);
    }
});

test('Admin resumed and interrupted polling blocks another server’s success refresh @smoke', async ({ page }) => {
    const { state } = await load(page, { resumed: true });
    await expect(page.locator('#data-operation-ho-b')).toContainText('Import in progress');
    state.pollingUnavailable = true;
    await choose(page, 'a'); await submit(page, 'a');
    await expect(page.locator('#data-operation-ho-b')).toContainText('Status updates were interrupted');
    await page.waitForTimeout(900);
    expect(state.navigations).toHaveLength(1);
    await expect(page.locator('[data-admin-refresh]')).toBeDisabled();
    state.pollingUnavailable = false;
    state.operations.b.phase = 'succeeded';
    await expect.poll(() => state.navigations.length).toBe(2);
});

test('Admin single-import success refreshes normally @smoke', async ({ page }) => {
    const { state } = await load(page);
    await choose(page, 'a'); await submit(page, 'a');
    await expect.poll(() => state.navigations.length).toBe(2);
    expect(state.posts).toEqual(['a']);
});

test('Admin preserves unsent file and config changes with synchronized refresh help @smoke', async ({ page }, info) => {
    const { state } = await load(page);
    await choose(page, 'b');
    const settings = page.locator('input[name="bundleReference"]').first();
    await settings.fill('unsaved/synthetic.source.transaction.json');
    await choose(page, 'a'); await submit(page, 'a');
    await expect(page.locator('#data-operation-ho-a')).toContainText('Import complete');
    await page.waitForTimeout(900);
    expect(state.navigations).toHaveLength(1);
    expect(await page.locator('#bundle-ho-b').evaluate(input => input.files.length)).toBe(1);
    await expect(settings).toHaveValue('unsaved/synthetic.source.transaction.json');
    await expect(page.locator('[data-admin-refresh-status]')).toContainText('Unsaved form changes are kept');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('[data-admin-refresh]').focus();
    await expect(page.getByRole('tooltip')).toContainText('Unsaved file selections and form changes will be discarded');
    await page.screenshot({ path: info.outputPath('unsaved-refresh-help.png'), fullPage: true });
});
