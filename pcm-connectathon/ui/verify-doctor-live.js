'use strict';
/** Read-only checks of the deployed Doctor UI; never submit a clinical or selection request. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium, expect } = require('/suite/node_modules/@playwright/test');
const address = process.argv[2] || 'http://10.0.0.204:3100/?identity=hospital-a';
const output = process.env.DOCTOR_LIVE_OUTPUT || '/artifacts';
const root = process.env.DOCTOR_UI_ROOT || '/workspace';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Capture only application geometry, excluding dynamically created Help proxies. */
const geometry = page => page.locator('#doctor-identity, [data-patient-mode], #service-id, [data-request-consent]').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { id: node.id || node.dataset.patientMode || 'submit', x, y, width, height };
}));

/** Verify the reported URL with actual server HTML and assets in both input modes. */
async function main() {
    fs.mkdirSync(output, { recursive: true });
    const browser = await chromium.launch();
    const results = [];
    try {
        for (const width of [1440, 390]) {
            const mobile = width === 390;
            const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: mobile, hasTouch: mobile });
            const page = await context.newPage(), errors = [], writes = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                if (['GET', 'HEAD'].includes(route.request().method())) return route.continue();
                writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
                return route.abort();
            });
            const response = await page.goto(address, { waitUntil: 'networkidle' });
            assert.equal(response.status(), 200);
            await expect(page).toHaveTitle('Doctor · Synthetic service provider');
            const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
            await expect(page.locator('.doctor-navigation .explain-toggle')).toBeVisible();
            assert.equal(await toggle.count(), 1);
            assert.ok((await toggle.boundingBox()).height < 30);
            const modes = page.locator('[data-patient-mode]');
            assert.equal(await modes.count(), 2);
            const initialMode = await page.locator('[data-patient-mode][aria-pressed="true"]').getAttribute('data-patient-mode');
            const patientValue = await page.locator('#patient-id').inputValue();
            await page.getByRole('button', { name: 'Enter identifier', exact: true }).click();
            await expect(page.locator('#patient-manual')).toBeVisible();
            await expect(page.locator('#patient-id')).toHaveValue(patientValue);
            await page.getByRole('button', { name: 'Choose patient', exact: true }).click();
            await expect(page.locator('#patient-choices')).toBeVisible();
            await expect(page.locator('#patient-manual')).toBeHidden();
            await page.locator(`[data-patient-mode="${initialMode}"]`).click();
            const toolButton = page.locator('#doctor-tools-button');
            await toolButton.click(); await expect(page.locator('#doctor-tools-panel')).toBeVisible();
            await page.locator('[data-tools-close]').click(); await expect(page.locator('#doctor-tools-panel')).toBeHidden();
            const before = await geometry(page);
            await toggle.check();
            assert.deepEqual(await geometry(page), before);
            assert.equal(await page.locator('.doctor-help-control, .doctor-help-field').count(), 0);
            assert.ok(await page.locator('.explain-affordance').evaluateAll(nodes => nodes.every(node =>
                getComputedStyle(node, '::after').content !== '"?"' && getComputedStyle(node).clipPath === 'inset(50%)')));
            const field = page.locator('#patient-id');
            await toggle.uncheck();
            await page.getByRole('button', { name: 'Enter identifier', exact: true }).click();
            await toggle.check();
            if (mobile) await field.tap(); else await field.focus();
            await expect(page.getByRole('tooltip')).toBeVisible();
            await page.getByRole('button', { name: 'Dismiss explanation' }).click();
            await expect(page.getByRole('tooltip')).toBeHidden();
            await expect(field).toBeFocused();
            await toggle.uncheck();
            await page.locator(`[data-patient-mode="${initialMode}"]`).click();
            await toggle.check();
            await page.screenshot({ path: path.join(output, `live-${width}-explain.png`), fullPage: true });
            await toggle.uncheck();
            assert.deepEqual(await geometry(page), before);
            await page.screenshot({ path: path.join(output, `live-${width}-normal.png`), fullPage: true });
            await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
            await page.evaluate(() => { document.documentElement.style.zoom = ''; });
            const assets = {};
            for (const asset of ['connectathon.css', 'doctor-tools.js', 'doctor-selection.js', 'help-copy.js', 'help.js']) {
                const assetUrl = await page.locator(`[src$="/${asset}"], [href$="/${asset}"]`).first().evaluate(node => node.src || node.href);
                const assetResponse = await context.request.get(assetUrl);
                assert.equal(assetResponse.status(), 200);
                assets[asset] = hash(await assetResponse.body());
                assert.equal(assets[asset], hash(fs.readFileSync(path.join(root, 'src/shared/ui', asset))));
            }
            await page.getByRole('link', { name: 'Open Patient library', exact: true }).click();
            await expect(page.getByRole('heading', { name: 'Patient library', exact: true })).toBeVisible();
            await expect(page.getByRole('heading', { name: 'Available patients', exact: true })).toBeVisible();
            await expect(page.getByText(/return to Doctor and choose Enter identifier/)).toBeVisible();
            await expect(page.locator('.doctor-navigation .explain-toggle')).toBeVisible();
            assert.equal(await page.locator('.doctor-help-control, .doctor-help-field').count(), 0);
            assert.ok(await page.locator('.explain-affordance').evaluateAll(nodes => nodes.every(node =>
                getComputedStyle(node, '::after').content !== '"?"' && getComputedStyle(node).clipPath === 'inset(50%)')));
            await page.screenshot({ path: path.join(output, `live-${width}-library.png`), fullPage: true });
            assert.deepEqual(errors, []); assert.deepEqual(writes, []);
            results.push({ width, mobile, httpStatus: response.status(), headerHelp: true, iconFreeReferenceHelp: true,
                stableToggleGeometry: true, patientModesPreserveIdentifier: true, toolsOpenClose: true,
                helpOpensAndDismisses: true, zoom200FitsViewport: true, patientLibraryNavigation: true,
                browserErrors: errors, attemptedWrites: writes, servedAssetSha256: assets });
            await context.close();
        }
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(output, 'live-browser-results.json'), JSON.stringify({ address, checkedAt: new Date().toISOString(), results }, null, 2) + '\n');
    console.log(JSON.stringify({ passed: results.length, address, viewports: results.map(result => result.width), browserErrors: 0, attemptedWrites: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
