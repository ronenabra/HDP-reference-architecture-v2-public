'use strict';

/** Actual existing Admin maintenance status and Explain after an owned metadata checkpoint restart. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');

test('migration status distinguishes observed apply from preview; responsive passive Help preserves state', async ({ browser }, info) => {
    const previous = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'owned-metadata07-browser';
    const fixture = await require(path.join(root, 'test-support/consent-snapshot-fixture')).startSnapshotFixture();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true,
        extraHTTPHeaders: { 'x-admin-password': 'owned-metadata07-browser' } });
    try {
        const cutover = require(path.join(root, 'test-support/public-metadata-cutover')).cutoverFixture({ store: fixture.store });
        const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
        const checkpointPath = path.join(process.env.STATE_DIR, 'pcm-ig-041/checkpoint.json');
        const checkpoint = fs.readFileSync(checkpointPath, 'utf8');
        const page = await context.newPage(), mutations = [];
        page.on('request', request => { if (request.method() !== 'GET') mutations.push(request.url()); });
        await page.goto(fixture.base + '/admin');
        const status = page.locator('[data-metadata-migration-status]');
        await expect(status).toContainText('Observed migration: applied');
        await expect(status).toContainText('pcm-private-state/1'); await expect(status).toContainText('pcm-public-fhir/1');
        await expect(status).toContainText('0 changed'); await expect(status).toContainText('0 rejected');
        for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1024, 2]]) {
            await page.setViewportSize({ width, height: 1000 }); await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
            await status.scrollIntoViewIfNeeded();
            const geometry = await status.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
            expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
            await page.screenshot({ path: info.outputPath(`metadata-maintenance-${width}-${zoom}.png`) });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await page.setViewportSize({ width: 390, height: 1000 });
        await page.getByLabel('Explain this page', { exact: true }).check();
        const freeze = page.getByRole('button', { name: 'Freeze migration checkpoint', exact: true });
        await freeze.focus();
        await expect(page.locator('#pcm-help-tooltip')).toContainText('Preview never writes');
        await expect(page.locator('#pcm-help-tooltip')).toContainText('public FHIR export are insufficient');
        await expect(page.locator('#pcm-help-tooltip')).toContainText('five-component artifacts');
        await page.screenshot({ path: info.outputPath('metadata-help-mobile.png') });
        await page.keyboard.press('Escape');
        expect(mutations).toEqual([]); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8')).toBe(before);
        expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(checkpoint);
        expect(fixture.requests.filter(item => /\/token$|\/introspect$/.test(item.path))).toEqual([]);
        expect(await status.innerText()).not.toMatch(/BEGIN PRIVATE|access_token|client_assertion|adminPassword/);
        fs.writeFileSync(info.outputPath('observed-migration.json'), JSON.stringify({ status: await status.innerText(), digest: cutover.digest, mutations, url: page.url() }, null, 2));
    } finally {
        await context.close(); await fixture.close();
        if (previous === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previous;
    }
});
