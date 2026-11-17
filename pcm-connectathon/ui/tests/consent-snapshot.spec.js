'use strict';
/** Real disposable approval/source/cancellation journeys with exact serialized decisions. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/consent-snapshot-fixture')).startSnapshotFixture(); });
test.afterAll(async () => { await fixture?.close(); });

test('CONSENT exact alternatives, frozen source edits, cancellation and new approval @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ isMobile: mobile, hasTouch: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    const page = await context.newPage(), receipts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const { EXACT, V } = require(path.join(root, 'test-support/consent-snapshot-fixture'));
    const click = async element => mobile ? element.tap() : element.click();
    try {
        for (const choice of ['service-provided', 'auto-resources', 'auto-buckets', 'custom']) {
            const consent = fixture.create();
            await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
            await expect(page.locator('#scope-service-provided')).toBeChecked();
            await page.locator('[data-alternative-permissions] > summary').click();
            if (choice === 'custom') {
                await page.locator('#scope-custom').check();
                await page.locator('#custom-scope').fill('suspect scope');
                await expect(page.locator('[data-scope-warnings]')).toContainText('Advisory warnings');
                await page.screenshot({ path: info.outputPath('manual-advisory.png'), fullPage: true });
                await page.locator('#custom-scope').fill(`patient/Patient.rs?${V} patient/Encounter.s?status=finished&${V}`);
            } else await click(page.locator(`#scope-${choice}`));
            const reviewed = choice === 'custom' ? await page.locator('#custom-scope').inputValue() : await page.locator(`#scope-${choice}`).getAttribute('data-scope-value');
            const wire = [];
            page.once('request', request => { if (request.method() === 'POST') wire.push(request.postData()); });
            await click(page.getByRole('button', { name: 'Approve request', exact: true }));
            await expect(page).toHaveURL(`${fixture.base}/ui`);
            await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
            const saved = fixture.store.get('Consent', consent.id), snapshot = fixture.store.privateRecords.approvals.getDecision(saved.id).snapshot;
            expect(snapshot.scope).toBe(reviewed); expect(snapshot.choice).toBe(choice); expect(snapshot.usable).toBe(true);
            expect(snapshot.service.grant.scope).toBe(EXACT);
            await expect(page.locator('[data-approved-scope]')).toHaveText(reviewed);
            await expect(page.locator('[data-approval-provenance]')).toContainText('sandbox simulation');
            await expect(page.locator('[name="scopeChoice"], [name="customScope"]')).toHaveCount(0);
            await page.locator('[data-exact-permissions] > summary').click();
            await page.screenshot({ path: info.outputPath(`${choice}-approved.png`), fullPage: true });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            const bytes = JSON.stringify(snapshot);
            const sourceForm = page.locator('[data-source-change]');
            await page.locator('[data-source-settings] > summary').click();
            await expect(sourceForm).toBeVisible();
            const boxes = sourceForm.locator('input[type="checkbox"]');
            for (let index = 0; index < await boxes.count(); index++) await boxes.nth(index).uncheck();
            await Promise.all([page.waitForEvent('domcontentloaded'), click(sourceForm.locator('[data-source-apply]'))]);
            await expect(page.locator('[data-source-change] input[type="checkbox"]:checked')).toHaveCount(0);
            expect(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot)).toBe(bytes);
            await page.reload();
            await page.locator('[data-source-settings] > summary').click();
            const firstBox = page.locator('[data-source-change] input[type="checkbox"]').first(); await firstBox.check();
            await Promise.all([page.waitForEvent('domcontentloaded'), click(page.locator('[data-source-apply]'))]);
            await expect(page.locator('[data-source-change] input[type="checkbox"]:checked')).toHaveCount(1);
            expect(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot)).toBe(bytes);
            if (choice === 'service-provided') {
                await page.locator('[data-cancellation-settings] > summary').click();
                page.once('dialog', dialog => dialog.accept());
                await click(page.getByRole('button', { name: 'Permanently cancel consent', exact: true }));
                await expect(page.locator('[data-consent-status]')).toContainText('Service Provider cancelled');
                expect(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot)).toBe(bytes);
                const replacement = fixture.create(); expect(replacement.id).not.toBe(consent.id);
                await page.goto(`${fixture.base}/ui/approve/${replacement.id}`); await page.locator('[data-alternative-permissions] > summary').click(); await click(page.locator('#scope-auto-resources'));
                await click(page.getByRole('button', { name: 'Approve request', exact: true }));
                await expect(page).toHaveURL(`${fixture.base}/ui`);
                expect(fixture.store.privateRecords.approvals.getDecision(replacement.id).snapshot.choice).toBe('auto-resources');
                expect(fixture.store.get('Consent', consent.id).status).toBe('inactive');
            }
            receipts.push({ consentId: consent.id, reviewed, wire, snapshot, serializedSnapshot: bytes,
                afterSourceAndCancellation: fixture.store.get('Consent', consent.id) });
        }
        const invalid = fixture.create(); await page.goto(`${fixture.base}/ui/approve/${invalid.id}`);
        await page.locator('[data-alternative-permissions] > summary').click(); await page.locator('#scope-custom').check();
        await page.locator('#custom-scope').fill('  suspect scope  '); await click(page.getByRole('button', { name: 'Approve request', exact: true }));
        await expect(page).toHaveURL(`${fixture.base}/ui`); await page.goto(`${fixture.base}/ui/approve/${invalid.id}`);
        await expect(page.locator('[data-approval-unusable]')).toContainText('Unusable approval scope');
        expect(fixture.store.privateRecords.approvals.getDecision(invalid.id).snapshot.scope).toBe('  suspect scope  ');
        expect(await page.locator('[data-approved-scope]').textContent()).toBe('  suspect scope  ');
        await page.screenshot({ path: info.outputPath('unusable-approved.png'), fullPage: true });
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('approval-readback.json'), JSON.stringify({ visibility: 'diagnostic', component: 'pcm-consents-qualification', operation: 'compare-private-approval', receipts, apiRequests: fixture.requests }, null, 2));
        expect(fixture.requests.some(request => request.path.endsWith('/api/fhir-service/r4/token') && request.status === 200 && request.certificate)).toBe(true);
    } finally { await context.close(); }
});
