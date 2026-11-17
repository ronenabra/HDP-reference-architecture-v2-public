'use strict';
/** Inspect real rendered pilots and controllers, rejecting incidental mutations. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.FOUNDATION_ROOT || path.resolve(__dirname, '../../..');
const { render } = require(path.join(root, 'test-support/doctor-ux-render'));
const { startApprovalFixture } = require(path.join(root, 'test-support/approval-scope-fixture'));
let fixture;
test.beforeAll(async () => { fixture = await startApprovalFixture(); });
test.afterAll(async () => { await fixture?.close(); });

/** Capture successful controls without Help's presentation-only checkbox. */
async function forms(page) {
    return page.locator('form').evaluateAll(nodes => nodes.map(form => ({
        action: form.getAttribute('action'), method: form.method,
        fields: [...form.querySelectorAll('[name]')].map(node => ({ name: node.name, value: node.value, disabled: node.disabled, checked: node.checked }))
    })));
}

for (const pilot of ['doctor', 'consent']) test(`${pilot}: wrapping header, Help and passive navigation preserve forms`, async ({ page }, info) => {
    const consent = fixture.create(), mutations = [], errors = [], unexpected = [];
    const before = process.env.FOUNDATION_PHASE === 'before';
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) mutations.push(`${request.method()} ${request.url()}`); });
    if (pilot === 'doctor') {
        const html = render(undefined, 'active', { selectedPatientId: '' });
        await page.route('https://doctor-ui.test/**', route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/doctor/') return route.fulfill({ body: html, contentType: 'text/html' });
            const asset = path.basename(url.pathname), file = path.join(root, 'src/shared/ui', asset);
            if (/^[a-z-]+\.(js|css)$/.test(asset) && fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file), contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css' });
            unexpected.push(url.pathname); return route.abort();
        });
    }
    await page.goto(pilot === 'doctor' ? 'https://doctor-ui.test/doctor/' : `${fixture.base}/ui/approve/${consent.id}`);
    const original = await forms(page), stored = JSON.stringify(fixture.store.get('Consent', consent.id));
    const sizes = before ? [[1440, 1], [390, 1]] : [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]];
    for (const [width, zoom] of sizes) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
        await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        if (!before) {
            const header = page.locator('.sandbox-header');
            await expect(header).toBeVisible();
            await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeVisible();
            const links = await header.locator('nav > a').evaluateAll(nodes => nodes.map(node => ({ name: node.textContent.trim(), href: node.getAttribute('href') })));
            expect(links.map(link => link.name)).toEqual(pilot === 'doctor' ? ['Doctor', 'Consents', 'Logs'] : ['Consents', 'Services']);
            expect(links.every(link => link.href && !link.href.includes('undefined'))).toBe(true);
            await expect(header.locator('[aria-current="page"]')).toHaveCount(1);
            const controls = await header.locator('nav > a, select, .explain-toggle, #doctor-tools-button').evaluateAll(nodes => nodes.map(node => {
                const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, height: rect.height };
            }));
            expect(controls.every(rect => rect.left >= 0 && rect.right <= width + 1 && rect.height >= 44 * zoom - 1)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
            const heading = await header.locator('.sandbox-heading').boundingBox(), navigation = await header.locator('nav').boundingBox();
            expect(navigation.y - (heading.y + heading.height)).toBeLessThanOrEqual(24 * zoom);
            const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
            const geometry = await header.boundingBox();
            if (width < 500) await toggle.tap(); else await toggle.check();
            expect(await header.boundingBox()).toEqual(geometry);
            const link = header.locator('nav > a').first();
            await link.focus();
            await expect(page.getByRole('tooltip')).toBeVisible();
            await page.getByRole('button', { name: 'Dismiss explanation' }).click();
            await expect(link).toBeFocused();
            await toggle.uncheck();
            if (pilot === 'doctor') {
                const tools = page.locator('#doctor-tools-button');
                await tools.click(); await expect(page.locator('#doctor-tools-panel')).toBeVisible();
                const panel = await page.locator('#doctor-tools-panel').boundingBox();
                expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(width + 1);
                await page.keyboard.press('Escape'); await expect(page.locator('#doctor-tools-panel')).toBeHidden();
                await expect(tools).toBeFocused();
            }
            expect(await forms(page)).toEqual(original);
        }
        await page.screenshot({ path: info.outputPath(`${pilot}-${width}-zoom-${zoom}.png`), fullPage: true });
    }
    expect(mutations).toEqual([]); expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    expect(JSON.stringify(fixture.store.get('Consent', consent.id))).toBe(stored);
});
