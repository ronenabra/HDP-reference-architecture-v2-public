'use strict';
/** Focused real Doctor render after ordinary authenticated PCM reads; no later Doctor redesign. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture, server, base, consent, exact;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/consent-snapshot-fixture')).startSnapshotFixture();
    consent = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle')).approveConsent({ store: fixture.store, consent: fixture.create(), scopeChoice: 'service-provided',
        sourceOrganizationIds: fixture.config.healthOrganizations.map(source => source.dataSourceOrganization.id) });
    exact = fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope;
    server = http.createServer(require(path.join(root, 'src/sp-client/src/index')).app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await fixture?.close(); });

test('QUALIFY Doctor renders public facts and separates intended operations from unavailable grant @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ isMobile: mobile, hasTouch: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(base + '/?identity=hospital-a');
        const card = page.locator('.card').filter({ has: page.locator(`input[name="consentId"][value="${consent.id}"]`) });
        await expect(card).toHaveCount(1);
        await card.getByText('Approval details', { exact: true }).click();
        await expect(card.locator('[data-token-details]')).toContainText('Granted permissions not yet obtained');
        await expect(card.locator('[data-token-status]')).toContainText('Token status not checked');
        const service = fixture.store.get('HealthcareService', consent.extension.find(item => item.url.endsWith('/ext-pcm-service')).valueReference.reference.split('/')[1]);
        const canonical = fixture.store.get('HealthcareService', service.extension.find(item => item.url.endsWith('/ext-based-on-canonical-healthcareservice')).valueReference.reference.split('/')[1]);
        const ceiling = require(path.join(root, 'src/sp-client/src/permission-plan')).servicePermissions(canonical).ceiling;
        await expect(card.locator('[name="requestedScope"]')).toHaveValue(ceiling);
        await card.getByText('Request overrides', { exact: true }).click();
        await card.locator('[name="requestedScope"]').fill('patient/Observation.s');
        expect(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot.scope).toBe(exact);
        await page.getByLabel('Explain this page', { exact: true }).check();
        await card.locator('summary[data-help-key="doctor.saved-scope"]').hover();
        await expect(page.locator('#pcm-help-tooltip')).toContainText('public facts');
        await page.keyboard.press('Escape');
        await page.getByLabel('Explain this page', { exact: true }).uncheck();
        await card.locator('[data-token-details]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('doctor-public-approval-details.png'), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('saved-wire-readback.json'), JSON.stringify({ exact, ceiling, savedConsent: fixture.store.get('Consent', consent.id),
            wireRequests: fixture.requests, viewport: page.viewportSize(), mobile, touched: mobile }, null, 2));
    } finally { await context.close(); }
});
