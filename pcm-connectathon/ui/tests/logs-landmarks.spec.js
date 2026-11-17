'use strict';

/** Landmark and keyboard regressions against the same real 10,500-record operator fixture. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const base = process.env.PCM_OPS_FIXTURE_URL;

test.beforeEach(() => {
    test.skip(!base, 'requires the isolated operator fixture, never a shared deployment');
});

/** Include the formerly moderate landmark failures as explicit gates, alongside severe issues. */
async function audit(page, testInfo, name) {
    const result = await new AxeBuilder({ page }).analyze();
    await testInfo.attach(name, { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
    expect(result.violations.filter(item => ['landmark-one-main', 'landmark-complementary-is-top-level', 'region', 'aria-allowed-role'].includes(item.id)
        || ['serious', 'critical'].includes(item.impact))).toEqual([]);
}

test('Logs landmarks contain initialized controls and preserve keyboard and responsive behavior @smoke', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/logs-view?diagnostics=true`);
    const main = page.getByRole('main', { name: /^Logs$/ });
    await expect(main).toHaveCount(1);
    await expect(main.locator('.log-row').first()).toBeVisible();
    await expect(page.locator('.explain-toggle')).toHaveCount(1);
    const toggle = main.getByRole('checkbox', { name: 'Explain this page' });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await audit(page, testInfo, 'landmarks-help-off');

    const mobile = page.viewportSize().width < 768;
    await expect(main.locator('#workbench')).toBeHidden();
    const filterButton = main.locator('[data-open-panel="filters"]');
    await filterButton.click();
    await expect(main.getByLabel('Role', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(main.locator('#workbench')).toBeHidden();
    await expect(filterButton).toBeFocused();
    const row = main.locator('.log-row').first();
    for (const key of ['Enter', ' ']) {
        await row.focus();
        await page.keyboard.press(key);
        await expect(row).toHaveAttribute('aria-current', 'true');
        await expect(main.locator('#details-pane pre[data-help-key="logs.payload"]')).toContainText('Fabricated Patient/000000018');
        await main.locator('#close-event-detail').click();
        await expect(row).toBeFocused();
    }
    await main.locator('#toggle-event-detail').click();
    const resizer = main.getByRole('separator', { name: /Resize.*up and down arrow keys/i });
    await expect(resizer).toBeVisible();
    await expect(resizer).toHaveAttribute('aria-orientation', 'horizontal');
    await resizer.focus();
    const minimum = Number(await resizer.getAttribute('aria-valuemin'));
    expect(minimum).toBeGreaterThanOrEqual(25);
    for (const [key, value] of [['Home', String(minimum)], ['ArrowUp', String(minimum + 5)], ['ArrowDown', String(minimum)], ['End', '70']]) {
        await page.keyboard.press(key);
        await expect(resizer).toHaveAttribute('aria-valuenow', value);
    }
    await main.locator('#close-event-detail').click();
    expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect((await main.locator('#log-list').boundingBox()).height).toBeGreaterThan(page.viewportSize().height * 0.55);
    if (mobile) {
        // Configurable columns keep readable widths in a horizontal list. Reach
        // Message through that scroll area, without overflowing the document.
        const messageCell = main.locator('.log-row .message-cell').first();
        await messageCell.scrollIntoViewIfNeeded();
        const message = await messageCell.boundingBox();
        expect(message.width).toBeGreaterThan(100);
        expect(message.x).toBeGreaterThanOrEqual(0);
        expect(message.x + message.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
        expect(await main.locator('#log-list').evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
        expect(await page.locator('html').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    }

    await toggle.check();
    await main.locator('#logs-title').focus();
    const tooltip = main.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    const bounds = await tooltip.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
    await audit(page, testInfo, 'landmarks-help-on');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
    await page.reload();
    await expect(main.locator('.log-row').first()).toBeVisible();
    await expect(page.locator('.explain-toggle')).toHaveCount(1);
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.locator('.explain-affordance')).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('logs-landmarks.png'), fullPage: true });
});
