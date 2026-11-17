'use strict';
/** Render the actual registry with disposable policy fixtures and exercise the real help controller. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const available = fs.existsSync(path.join(root, 'src/shared/consent-presentation.js'));
const ejs = available ? require(path.join(root, 'node_modules/ejs')) : null;
const { relaxedConsentSources } = available ? require(path.join(root, 'src/shared/consent-presentation')) : {};
test.beforeEach(() => test.skip(!available, 'requires owned authored repository fixture'));

test('consent bypass notice names effective sources and opens Explain help @smoke', async ({ page }) => {
    const relaxedSources = relaxedConsentSources({ simulation: { controls: { consentState: false }, perSource: {
        'legacy-ds': { consentState: false }, 'protected-source': { consentState: true }
    } } });
    const html = await ejs.renderFile(path.join(root, 'src/pcm-core/src/views/dashboard.ejs'), {
        workflowUrl: 'http://banner.test/sandbox/authentication', teamId: 'banner-owned', publicBaseUrls: { pcmUi: '', spClient: '' }, consents: [], relaxedSources
    });
    await page.route('http://banner.test/**', route => {
        const name = new URL(route.request().url()).pathname;
        if (name.startsWith('/assets/')) return route.fulfill({ path: path.join(root, 'src/shared/ui', path.basename(name)) });
        return route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('http://banner.test/ui');
    const notice = page.locator('[data-help-key="consent.relaxed-access"]');
    await expect(notice).toContainText('sources using the default settings and for legacy-ds');
    await expect(notice).not.toContainText('protected-source');
    await expect(page.getByRole('tooltip')).toBeHidden();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await notice.focus();
    await expect(page.getByRole('tooltip')).toContainText('source-specific exceptions');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
