'use strict';

/** Changed invariant notices and retired controls in desktop/native-touch browsers. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/consent-snapshot-fixture')).startSnapshotFixture(); });
test.afterAll(async () => { await fixture?.close(); });

test('ENFORCE presets expose only authentication controls and preserve approval bytes @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ isMobile: mobile, hasTouch: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [], receipts = [];
    page.on('pageerror', error => errors.push(error.message));
    const { approveConsent } = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle'));
    const { URL } = require(path.join(root, 'src/shared/consent-scope-snapshot'));
    const { SIMULATION_CONTROLS, REQUIRED_AUTHORIZATION_CONTROLS } = require(path.join(root, 'src/shared/conformance-policy'));
    const consent = approveConsent({ store: fixture.store, consent: fixture.create(), scopeChoice: 'service-provided',
        sourceOrganizationIds: fixture.config.healthOrganizations.map(source => source.dataSourceOrganization.id) });
    const bytes = JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot);
    try {
        await page.goto(fixture.base + '/admin');
        await expect(page.locator('[name="grantFullClinicalAccess"]')).toHaveCount(0);
        for (const name of REQUIRED_AUTHORIZATION_CONTROLS) await expect(page.locator(`[name="control.${name}"]`)).toHaveCount(0);
        for (const name of SIMULATION_CONTROLS) await expect(page.locator(`[name="control.${name}"]`)).toHaveCount(1);
        for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) {
            await page.locator('#simulation-preset').selectOption(preset);
            await page.locator('[data-preset-defaults]').click();
            await page.locator('[data-simulation-form] button[type="submit"], [data-simulation-form] button:not([type])').filter({ hasText: 'Save simulation controls' }).click();
            await expect(page).toHaveURL(fixture.base + '/admin');
            expect(fixture.store.get('Consent', consent.id).extension.find(extension => extension.url === URL).valueString).toBe(bytes);
            await expect(page.getByText('Every preset enforces the exact approved scope, Patient/source context and current authority.', { exact: false })).toBeVisible();
            const saved = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)); receipts.push({ preset, savedSimulation: saved.securitySimulation, scope: fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope });
        }
        if (mobile) {
            await page.locator('[data-simulation-form]').evaluate(form => {
                const pane = document.querySelector('.admin-content');
                pane.scrollTop += form.getBoundingClientRect().top - pane.getBoundingClientRect().top - 10;
            });
            await page.screenshot({ path: info.outputPath('admin-invariant-controls-top.png') });
            await page.locator('[data-simulation-form]').evaluate(form => {
                const pane = document.querySelector('.admin-content');
                pane.scrollTop += form.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom + 10;
            });
            await page.screenshot({ path: info.outputPath('admin-invariant-controls-bottom.png') });
        } else await page.locator('[data-simulation-form]').screenshot({ path: info.outputPath('admin-invariant-controls.png') });
        expect(await page.locator('.admin-content').evaluate(pane => pane.scrollWidth <= pane.clientWidth + 1)).toBe(true);
        await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
        await expect(page.getByText('Exact approved permissions', { exact: true })).toBeVisible();
        await expect(page.getByText('Every security preset enforces that scope and Patient/source context.', { exact: false })).toBeVisible();
        await page.screenshot({ path: info.outputPath('consent-invariant-notice.png'), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('preset-readback.json'), JSON.stringify({ receipts, serializedSnapshot: bytes }, null, 2));
    } finally { await context.close(); }
});
