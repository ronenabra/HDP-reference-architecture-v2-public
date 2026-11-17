'use strict';
/** Actual Admin saved/default/Strict controls, passive Explain and responsive capability state. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/consent-snapshot-fixture')).startSnapshotFixture(); });
test.afterAll(async () => { await fixture?.close(); });

test('Admin capability shows default, saves disable/restore and locks Strict without side effects or secrets', async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
    const page = await context.newPage();
    try {
        await page.goto(fixture.base + '/admin');
        const form = page.locator('[data-own-token-capability]'), control = form.getByLabel('Service Provider own-token introspection');
        await expect(control).toHaveValue('default'); await expect(form).toContainText('Effective: enabled · preset default');
        await control.selectOption('false'); await form.getByRole('button', { name: 'Save own-token capability' }).click();
        await expect(control).toHaveValue('false'); await expect(form).toContainText('Effective: disabled · explicit override');
        await control.selectOption('default'); await form.getByRole('button', { name: 'Save own-token capability' }).click();
        await expect(form).toContainText('Effective: enabled · preset default');
        const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
        for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1024, 2]]) {
            await page.setViewportSize({ width, height: 1000 }); await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
            await form.scrollIntoViewIfNeeded();
            const geometry = await form.evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth }));
            expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
            await page.screenshot({ path: info.outputPath(`admin-capability-${width}-${zoom}.png`) });
        }
        expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8')).toBe(before);
        const strict = require(path.join(root, 'test-support/team-config')).buildTeamConfig({}, 'strict');
        for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) fixture.config[key] = strict[key];
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
        await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await page.setViewportSize({ width: 390, height: 1000 }); await page.reload();
        await expect(control).toBeDisabled(); await expect(form.getByRole('button', { name: 'Save own-token capability' })).toBeDisabled();
        await expect(form).toContainText('Effective: disabled · Strict lock');
        await expect(form).toContainText('Strict prohibits');
        await page.getByLabel('Explain this page', { exact: true }).check();
        await form.scrollIntoViewIfNeeded();
        const target = await form.getByRole('button', { name: 'Save own-token capability', exact: true }).boundingBox();
        await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
        await expect(page.locator('#pcm-help-tooltip')).toContainText('Optional sandbox diagnostic capability');
        const locked = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
        await page.screenshot({ path: info.outputPath('admin-strict-help-mobile.png') });
        await page.keyboard.press('Escape'); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8')).toBe(locked);
        const html = await form.innerHTML(); expect(html).not.toMatch(/BEGIN PRIVATE|access_token|client_assertion=|adminPassword=/);
        expect(new URL(page.url()).search).toBe('');
        const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
        expect(storage.local).toEqual({});
        expect(Object.entries(storage.session).every(([key, value]) => key.startsWith('pcm-explain:') && ['on', 'off'].includes(value))).toBe(true);
        fs.writeFileSync(info.outputPath('capability-browser-state.json'), JSON.stringify({ storage, url: page.url(), formText: await form.innerText() }, null, 2));
        expect(fixture.requests.filter(value => /\/token$|\/introspect$/.test(value.path))).toEqual([]);
    } finally { await context.close(); }
});
