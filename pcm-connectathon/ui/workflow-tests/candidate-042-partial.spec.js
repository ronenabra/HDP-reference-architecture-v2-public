'use strict';
/** Requires the runner to stop only its owned HO-C gateway; no browser response mocking. */
const { test, expect } = require('@playwright/test');
const pcm = process.env.PCM_UI_PCM_URL;
test.skip(process.env.PCM_UI_CANDIDATE_042 !== 'true' || process.env.PCM_UI_WORKFLOW_PARTIAL !== 'true', 'Explicit owned stopped-source fixture required');

test('candidate 0.4.2 unavailable source stays unknown in presence and discovery', async ({ page }, testInfo) => {
    await page.goto(`${pcm}/sandbox/authentication`);
    await page.getByText('Local trusted SSO simulation', { exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with local SSO simulation', exact: true }).click();
    await page.getByRole('button', { name: 'Check my source presence', exact: true }).click();
    await expect(page.locator('[data-presence-results]')).toContainText('000000018 · Reference Health Organization C Data Source: Could not check');
    await expect(page.locator('[data-presence-results]')).toContainText('Previously known: absent');
    await page.getByRole('button', { name: 'Find or refresh dependents', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Some HMOs could not be checked' })).toBeVisible();
    const unavailableDiscovery = page.locator('[data-discovery-sources] li').filter({ hasText: 'Reference Health Organization C Data Source: Could not check' });
    await expect(unavailableDiscovery).toHaveCount(1);
    await expect(unavailableDiscovery).toBeVisible();
    await expect(page.locator('[data-dependent-card]')).toHaveCount(2);
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-partial-source.png`, fullPage: true });
    expect(await page.content()).not.toMatch(/PRIVATE KEY|client_assertion|access_token|local_jwt/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
