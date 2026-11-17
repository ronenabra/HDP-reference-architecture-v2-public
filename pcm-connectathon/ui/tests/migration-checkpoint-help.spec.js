'use strict';

/** Narrow real-Admin HTML popup proof; no operator checkpoint or configuration submission occurs. */
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path');

test('migration checkpoint popup explains freeze, stop, preview, fresh tokens and guarded rollback', async ({ page }, testInfo) => {
    const mutations = [];
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') { mutations.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        if (url.origin !== 'https://pcm04108.test') return route.abort();
        if (url.pathname === '/admin') return route.fulfill({ body: fs.readFileSync(process.env.PCM_HELP_ADMIN_FIXTURE || '/admin-fixture.html'), contentType: 'text/html' });
        if (url.pathname.startsWith('/assets/')) {
            const file = path.join('/ui-assets', path.basename(url.pathname));
            if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : 'text/css' });
        }
        return route.abort();
    });
    await page.goto('https://pcm04108.test/admin');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const button = page.getByRole('button', { name: 'Freeze migration checkpoint', exact: true });
    await button.focus();
    const popup = page.getByRole('tooltip');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('Freeze PCM configuration and policy state');
    await expect(popup).toContainText('31 seconds');
    await expect(popup).toContainText('Preview never writes');
    await expect(popup).toContainText('revocation, source removal or shortened validity');
    await page.screenshot({ path: `/artifacts/migration-checkpoint-help-${testInfo.project.name}.png` });
    expect(mutations).toEqual([]);
});
