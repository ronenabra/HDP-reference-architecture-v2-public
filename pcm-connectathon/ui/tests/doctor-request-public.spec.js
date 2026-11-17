'use strict';
/** Public-wire fixture proves create/passive summary cannot rewrite a different acquired grant. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer(); });
test.afterAll(async () => { await fixture?.close(); });

test('REQUEST public-only create retains an existing exact token grant and data; summaries issue no token/introspection/clinical call', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile'), context = await browser.newContext({ viewport: { width: mobile ? 320 : 1024, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage(), click = target => mobile ? target.tap() : target.click(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(fixture.doctorBase);
        const request = page.locator('form[action$="/create-consent"]');
        await page.locator('#configured-patient').selectOption('http://fhir.health.gov.il/identifier/il-national-id|000000018');
        await page.locator('#service-id').selectOption(fixture.instance.id);
        const first = page.locator('[data-consent-card]').first(), id = await first.getAttribute('data-consent-card');
        await click(first.getByRole('button', { name: 'Check / Discover', exact: true }));
        await click(first.getByText('Request overrides', { exact: true }));
        await first.locator('[name="requestedScope"]').fill('patient/Observation.s');
        await first.locator('[name="endpointUrl"]').fill(fixture.base + '/source-1');
        await click(first.getByRole('button', { name: 'Fetch data', exact: true }));
        const card = page.locator(`[data-consent-card="${id}"]`);
        await expect(card.locator('[aria-label="Fetched FHIR data"]')).toBeVisible();
        await click(card.getByText('Approval details', { exact: true }));
        const grant = (await card.locator('[data-token-details]').textContent()).trim();
        expect(grant).toContain(fixture.scope); expect(grant).not.toContain('opaque-doctor-public');
        const before = fixture.requests.length;
        await click(request.getByText('Service details', { exact: true }));
        await expect(request).toContainText('Granted permissions not yet obtained');
        expect(fixture.requests.length).toBe(before);
        const clinicalBefore = fixture.requests.filter(row => row.path.includes('/source-') || row.path.endsWith('/introspect') || row.requestedScope === 'patient/Observation.s').length;
        const old = JSON.stringify(fixture.consents.get(id));
        await click(request.getByRole('button', { name: 'Create consent request', exact: true }));
        await expect(page.locator('[data-help-key="common.feedback"]')).toContainText('Consent request created.');
        await click(card.getByText('Approval details', { exact: true }));
        expect((await card.locator('[data-token-details]').textContent()).trim()).toBe(grant);
        await expect(card.locator('[aria-label="Fetched FHIR data"]')).toBeVisible();
        expect(JSON.stringify(fixture.consents.get(id))).toBe(old);
        expect(fixture.requests.filter(row => row.path.includes('/source-') || row.path.endsWith('/introspect') || row.requestedScope === 'patient/Observation.s')).toHaveLength(clinicalBefore);
        const wire = fixture.requests.filter(row => row.method === 'POST' && row.path.endsWith('/Consent')).at(-1);
        expect(wire.body).toEqual(require(path.join(root, 'src/sp-client/src/fhir-builders')).buildConsentSubmit({ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }, fixture.instance.id));
        expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        await page.screenshot({ path: info.outputPath('existing-grant-after-new-request.png'), fullPage: true });
        fs.writeFileSync(info.outputPath('public-wire-create.json'), JSON.stringify({ fixtureOnly: true, unchangedExistingGrant: true, wire, requests: fixture.requests, violations: fixture.violations, errors }, null, 2));
    } finally { await context.close(); }
});
