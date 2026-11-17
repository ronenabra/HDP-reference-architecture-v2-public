'use strict';
/** Actual public-only Doctor/library tabs, compact details, native Help and viewport evidence. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');

test('R7 attached tabs, compact summary, public Approval details and Explain remain passive across layouts', async ({ page }, info) => {
    const fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer({ sampling: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(fixture.doctorBase + '/?identity=hospital-a');
        await page.locator('#service-id').selectOption(fixture.instance.id);
        const before = fixture.requests.length;
        const choose = page.getByRole('tab', { name: 'Choose patient', exact: true });
        const manual = page.getByRole('tab', { name: 'Enter identifier', exact: true });
        await choose.focus(); await page.keyboard.press('ArrowRight');
        await expect(manual).toBeFocused(); await expect(manual).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tabpanel', { name: 'Enter identifier' })).toBeVisible();
        await page.keyboard.press('Home'); await expect(choose).toBeFocused();
        await expect(page.locator('[data-service-details]')).not.toHaveAttribute('open');
        const summary = page.locator('[data-selected-service-summary]');
        await expect(summary.locator(':scope > dl dt')).toHaveText(['Purpose', 'Data', 'Maximum consent period']);
        const card = page.locator('[data-consent-card]').first();
        await card.getByText('Approval details', { exact: true }).click();
        // Sections with headings retain their existing location within each Consent card.
        await expect(card.locator('[aria-label="Consent and service"]')).toContainText('Saved approval access details are unavailable in Doctor');
        await expect(card.locator('[aria-label="Consent and service"] > dl dt')).toHaveText(['Patient', 'Provider', 'Service', 'Consent status', 'Approval starts', 'Approval ends', 'Access mode', 'Recorded sources', 'Discovered sources']);
        await expect(card.locator('[aria-label="Consent and service"]')).not.toContainText('Service categories/history inputs');
        await expect(card.locator('[data-token-details]')).toContainText('Granted permissions not yet obtained');
        const sizes = info.project.name === 'mobile' ? [[390, 1], [320, 1], [390, 2]] : [[1440, 1], [1024, 1], [1440, 2]];
        const geometry = [];
        for (const [width, zoom] of sizes) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
            await page.evaluate(() => scrollTo(0, 0));
            const measured = await page.locator('.doctor-page .row').evaluate(node => {
                const columns = [...node.children].map(child => child.getBoundingClientRect());
                return { ratio: columns[1].width / columns[0].width, stacked: columns[1].y > columns[0].y + 10 };
            });
            if (width / zoom >= 1024) expect(measured.ratio).toBeCloseTo(1.55, 1);
            const distance = await page.evaluate(() => {
                const summary = document.querySelector('[data-selected-service-summary]').getBoundingClientRect();
                return document.querySelector('[data-request-consent]').getBoundingClientRect().top - summary.bottom;
            });
            expect(distance / zoom).toBeLessThan(100);
            const beforeToggle = await summary.boundingBox();
            await page.getByRole('checkbox', { name: 'Explain this page' }).check();
            expect(await summary.boundingBox()).toEqual(beforeToggle);
            await page.locator('[data-service-details] summary').focus();
            await expect(page.getByRole('tooltip')).toContainText('Service details');
            await page.keyboard.press('Escape');
            await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: info.outputPath(`doctor-${width}-zoom-${zoom}.png`), fullPage: true });
            geometry.push({ width, zoom, ...measured, distance });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
        await page.locator('[data-service-details] summary').click();
        await expect(summary).toContainText('service settings, not granted record dates');
        expect(fixture.requests.length).toBe(before);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.locator('[data-patient-library]').click();
        await expect(page.getByText('Sandbox details and diagnostics', { exact: true })).toHaveCount(0);
        const demo = page.getByRole('tab', { name: /Demo & test patients/ });
        await demo.focus(); await page.keyboard.press('End');
        await expect(page.getByRole('tab', { name: /Source sample/ })).toBeFocused();
        await page.locator('#sample-load').click();
        await expect(page.locator('#sample-state')).toContainText('Loaded');
        const dates = page.locator('#sample-results td[data-label="Date of birth"]');
        await expect(dates).toHaveText(['1985-03-12', '1985-03', 'Not provided']);
        const sampled = fixture.requests.length;
        await page.locator('#sample-results summary').first().click();
        await expect(page.locator('#sample-results details').first()).toContainText('1985-03-12');
        await page.reload();
        await page.getByRole('tab', { name: /Source sample/ }).click();
        await expect(dates).toHaveText(['1985-03-12', '1985-03', 'Not provided']);
        expect(fixture.requests.length).toBe(sampled);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('receipt.json'), JSON.stringify({ geometry, requests: fixture.requests, errors, violations: fixture.violations }, null, 2));
    } finally { await fixture.close(); }
});
