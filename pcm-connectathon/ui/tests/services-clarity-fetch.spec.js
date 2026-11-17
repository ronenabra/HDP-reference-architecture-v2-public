'use strict';
/** Current Doctor browser retrieves explicit R/V fixtures under the exact public wildcard response. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer();
    fixture.state.scope = 'patient/*.rs'; fixture.state.sourceMode = 'restricted-fixture';
});
test.afterAll(async () => { await fixture?.close(); });

test('CLARITY all-access browser fetch renders R and V and preserves public-only grant provenance', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), click = target => mobile ? target.tap() : target.click(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(fixture.doctorBase);
        const card = page.locator('[data-consent-card]').first();
        await click(card.getByRole('button', { name: 'Check / Discover', exact: true }));
        await click(card.locator('summary').filter({ hasText: 'Request overrides' }));
        await card.locator('[name="requestedScope"]').fill('patient/Observation.s');
        await card.locator('[name="endpointUrl"]').fill(fixture.base + '/source-1');
        await click(card.getByRole('button', { name: 'Fetch data', exact: true }));
        const data = card.locator('[aria-label="Fetched FHIR data"]');
        await expect(data).toBeVisible(); await expect(data).toContainText('public-R'); await expect(data).toContainText('public-V');
        await expect(data).toContainText('2001-01-01');
        const approval = card.locator('summary').filter({ hasText: 'Approval details' });
        await click(approval); await expect(card.locator('[aria-label="Token response"]')).toContainText('patient/*.rs');
        await expect(card.locator('[aria-label="Token response"]')).not.toContainText('opaque-doctor-public');
        const source = fixture.requests.filter(row => row.path.startsWith('/source-'));
        expect(source.length).toBeGreaterThan(0); expect(source.every(row => row.path === '/source-1/Observation')).toBe(true);
        expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        await click(data.getByText('FHIR technical details', { exact: true }));
        await data.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('all-access-rv-browser.png'), fullPage: false });
        // A real subsequent query edit still fences the displayed data and token facts immediately.
        await click(card.locator('summary').filter({ hasText: 'Request overrides' }));
        await card.locator('[name="requestedScope"]').fill('patient/Condition.s');
        await expect(data).toHaveCount(0);
        await expect(card.locator('[data-token-details]')).toContainText('changed context');
        expect(fixture.requests.filter(row => row.path.startsWith('/source-'))).toHaveLength(source.length);
        fs.writeFileSync(info.outputPath('all-access-rv-public-traffic.json'), JSON.stringify({ fixtureOnly: true, nativeEnforcementReused: '../sandbox-full-access-01/native-final.json', scope: fixture.state.scope, requests: fixture.requests, violations: fixture.violations, errors }, null, 2));
    } finally { await context.close(); }
});
