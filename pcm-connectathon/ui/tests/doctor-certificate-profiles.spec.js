'use strict';
/** Actual configured profile selection and authored Explain text, including native touch. */
const { test, expect } = require('@playwright/test');

test('Doctor profile selection explains the shared primary and separate Hospital B credentials @smoke', async ({ browser, page }, info) => {
    const sp = process.env.PCM_UI_SP_URL;
    expect(sp, 'owned disposable Doctor URL is required').toBeTruthy();
    const mobile = info.project.name === 'chromium-mobile';
    const context = mobile ? await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }) : null;
    if (context) page = await context.newPage();
    try {
        for (const identity of ['hospital-a', 'hospital-b']) {
            await page.goto(`${sp}/?identity=${identity}`);
            const picker = page.locator('#doctor-identity');
            await expect(picker).toHaveValue(identity);
            await page.getByRole('checkbox', { name: 'Explain this page' }).check();
            if (mobile) await picker.tap(); else await picker.focus();
            await expect(page.getByRole('tooltip')).toContainText('shared P-256');
            await expect(page.getByRole('tooltip')).toContainText('distinct P-384');
            await page.keyboard.press('Escape');
            await page.goto(`${sp}/manage?identity=${identity}`);
            await expect(page.locator('#manage-identity')).toHaveValue(identity);
            const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
            expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
        }
    } finally { await context?.close(); }
});
