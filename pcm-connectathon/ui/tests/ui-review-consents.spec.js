'use strict';
/** R5 actual server-rendered Consent states: local previews, exact copy and passive Help. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const { assertBindings } = require('./helpers/help-bindings');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/consent-snapshot-fixture')).startSnapshotFixture(); });
test.afterAll(async () => { await fixture?.close(); });

/** Author only the owned fixture with the normal generated laboratory definition. */
function generatedDefinition() {
    const service = fixture.store.get('HealthcareService', 'approval-lab-follow-up');
    const canonical = fixture.store.get('HealthcareService', require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle')).basedOnId(service));
    const input = { ...fixture.store.privateRecords.services.getDefinition(canonical.id).grant.authoring, scopeOrigin: 'generated' };
    delete input.approvalScope;
    require(path.join(root, 'test-support/private-definition')).replaceDefinition(fixture.store, canonical, input, { now: Date.parse('2026-01-05T12:00:00Z') / 1000 });
}

/** The compact sticky Explain row must reserve real space above the focused control. */
async function noOverflow(page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const bar = await page.locator('.explain-bar').boundingBox();
    expect(bar.x).toBeGreaterThanOrEqual(0); expect(bar.x + bar.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
}

test('R5 pending and saved summaries reflow, preview exact alternatives and passive Help without writes', async ({ page, context }, info) => {
    generatedDefinition();
    const consent = fixture.create(), writes = [], errors = [], reads = [];
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); reads.push(new URL(request.url()).pathname); });
    page.on('pageerror', error => errors.push(error.message));
    const url = `${fixture.base}/ui/approve/${consent.id}`;
    await page.goto(url); await assertBindings(page, expect);
    await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
    await expect(page.locator('[data-access-summary]')).toContainText('From 5 Jan 2024, 12:00:00 UTC');
    await expect(page.locator('[data-access-limited]')).toBeHidden();
    await expect(page.locator('[data-alternative-permissions]')).not.toHaveAttribute('open');
    const widths = info.project.name.endsWith('mobile') ? [390, 320] : [1440, 1024];
    for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 }); await noOverflow(page);
        await page.screenshot({ path: info.outputPath(`consent-pending-${width}.png`), fullPage: true, scale: 'css' });
    }
    await page.locator('[data-alternative-permissions] > summary').click();
    await page.locator('#scope-auto-resources').check();
    await expect(page.locator('[data-access-summary]')).not.toContainText('From 5 Jan 2024');
    await expect(page.locator('[data-choice-advice]')).toContainText('broader sandbox override');
    const reviewed = await page.locator('#scope-auto-resources').getAttribute('data-scope-value');
    await expect(page.locator('[data-exact-scope]')).toHaveText(reviewed);
    await page.locator('#scope-auto-buckets').check();
    await expect(page.locator('[data-access-summary]')).toContainText('From');
    await expect(page.locator('[data-access-summary]')).not.toContainText('From 5 Jan 2024');
    await page.locator('#scope-custom').check();
    const exact = 'patient/Unknown.rs?_filter=do-not-interpret';
    await page.locator('#custom-scope').fill(exact);
    await expect(page.locator('[data-access-limited]')).toBeVisible();
    await expect(page.locator('[data-exact-scope]')).toHaveText(exact);
    await expect(page.locator('[data-choice-advice]')).toContainText('replaces the service permissions');
    await page.locator('[data-exact-permissions] > summary').click();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy scope', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exact);
    await expect(page.locator('[data-copy-result]')).toHaveText('Copied.');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('blocked'); } } }));
    await page.getByRole('button', { name: 'Copy Consent ID' }).click();
    await expect(page.locator('[data-copy-result]')).toContainText('Select the complete value');
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    const before = await page.locator('[data-access-summary]').boundingBox(); await toggle.check();
    expect(await page.locator('[data-access-summary]').boundingBox()).toEqual(before);
    await page.locator('#custom-scope').focus();
    await expect(page.getByRole('tooltip')).toContainText('Replace the service permissions');
    await expect(page.getByRole('tooltip')).not.toContainText('generator');
    await page.screenshot({ path: info.outputPath('consent-custom-help.png'), scale: 'css' });
    await page.keyboard.press('Escape'); await expect(page.locator('#custom-scope')).toBeFocused(); await toggle.uncheck();
    expect(writes).toEqual([]);
    // Actual existing approval owner saves an owned fixture; browsing never submits it.
    const saved = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle')).approveConsent({ store: fixture.store, consent });
    const bytes = JSON.stringify(fixture.store.privateRecords.approvals.getDecision(saved.id).snapshot);
    await page.goto(url); await assertBindings(page, expect);
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    await expect(page.locator('[data-access-summary]')).toContainText('From 5 Jan 2024, 12:00:00 UTC');
    await expect(page.locator('[data-approval-provenance]')).toContainText('no verified patient decision');
    for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 }); await noOverflow(page);
        await page.screenshot({ path: info.outputPath(`consent-approved-${width}.png`), fullPage: true, scale: 'css' });
    }
    await page.locator('[data-source-settings] > summary').click();
    await toggle.check();
    const disabled = page.locator('[data-source-apply]');
    await disabled.scrollIntoViewIfNeeded();
    if (info.project.name.endsWith('mobile')) { const box = await disabled.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); }
    else await page.getByRole('button', { name: 'Explain Save source changes', exact: true }).focus();
    await expect(page.getByRole('tooltip')).toContainText('Change at least one source selection');
    await page.screenshot({ path: info.outputPath('consent-disabled-help.png'), scale: 'css' });
    await page.getByRole('button', { name: 'Dismiss explanation' }).click(); await toggle.uncheck();
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: Math.floor(viewport.width / 2), height: 500 });
    await page.locator('[data-exact-permissions] > summary').click();
    await page.getByRole('button', { name: 'Copy scope', exact: true }).scrollIntoViewIfNeeded(); await noOverflow(page);
    const target = await page.getByRole('button', { name: 'Copy scope', exact: true }).boundingBox();
    expect(target.y).toBeGreaterThanOrEqual((await page.locator('.explain-bar').boundingBox()).height);
    await page.screenshot({ path: info.outputPath('consent-approved-200.png'), fullPage: true, scale: 'css' });
    expect(writes).toEqual([]); expect(errors).toEqual([]);
    expect(reads.filter(url => !url.startsWith('/assets/') && url !== '/favicon.ico')).toEqual([new URL(url).pathname, new URL(url).pathname]);
    expect(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(saved.id).snapshot)).toBe(bytes);
    fs.writeFileSync(info.outputPath('passive-audit.json'), JSON.stringify({ writes, reads, errors, exactCopy: exact, savedScope: JSON.parse(bytes).scope }, null, 2));
});

test('R5 source and cancellation failures keep recovery beside the unchanged decision', async ({ page }, info) => {
    const consent = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle')).approveConsent({ store: fixture.store, consent: fixture.create() });
    const bytes = JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot);
    await page.goto(`${fixture.base}/ui/approve/${consent.id}`);
    await page.locator('[data-source-settings] > summary').click();
    const source = page.locator('[data-source-change] input[type=checkbox]').first();
    await source.setChecked(!await source.isChecked());
    await page.route('**/sandbox-sources', route => route.fulfill({ status: 401, json: { error: 'Admin login required' } }));
    await page.locator('[data-source-apply]').click();
    await expect(page.locator('[data-source-result]')).toContainText('Admin login is required');
    await expect(page.locator('[data-source-apply]')).toBeEnabled();
    await page.locator('[data-source-cancel]').click();
    await expect(page.locator('[data-source-apply]')).toBeDisabled();
    await page.locator('[data-cancellation-settings] > summary').click();
    await page.route('**/cancel', route => route.fulfill({ status: 401, json: { error: 'Admin login required' } }));
    const dialogs = [];
    page.once('dialog', dialog => { dialogs.push(dialog.message()); dialog.accept(); });
    await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).click();
    await expect(page.locator('[data-cancellation-result]')).toContainText('Admin login is required');
    expect(dialogs[0]).toContain('cannot be undone'); expect(dialogs[0]).toContain('30 seconds');
    expect(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot)).toBe(bytes);
    await noOverflow(page); await page.screenshot({ path: info.outputPath('consent-recovery.png'), fullPage: true, scale: 'css' });
});


test('R5 stale approval retains the manual draft and terminal read-only state remains distinct', async ({ page }, info) => {
    const consent = fixture.create(), url = `${fixture.base}/ui/approve/${consent.id}`;
    await page.goto(url); await page.locator('[data-alternative-permissions] > summary').click();
    await page.locator('#scope-custom').check(); const text = '  patient/Unknown.rs?_filter=keep-exact  ';
    await page.locator('#custom-scope').fill(text);
    const service = fixture.store.get('HealthcareService', 'approval-lab-follow-up'); service.name = 'Edited after displayed review'; fixture.store.update(service);
    await page.getByRole('button', { name: 'Approve request', exact: true }).click();
    await expect(page.locator('[data-approval-error]')).toContainText('Consent or service changed');
    await expect(page.locator('#custom-scope')).toHaveValue(text); await expect(page.locator('#scope-custom')).toBeChecked();
    expect(fixture.store.get('Consent', consent.id).status).toBe('proposed');
    await noOverflow(page); await page.screenshot({ path: info.outputPath('consent-stale-review.png'), fullPage: true, scale: 'css' });
    require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle')).rejectConsent({ store: fixture.store, consent });
    await page.goto(url); await expect(page.locator('[data-consent-status]')).toContainText('declined');
    await expect(page.locator('[name=scopeChoice], [name=customScope], [data-source-change]')).toHaveCount(0);
    await expect(page.locator('[data-approval-unusable]')).toBeVisible();
    await page.locator('[data-cancellation-settings] > summary').click();
    await expect(page.getByRole('button', { name: 'Permanently cancel consent', exact: true })).toBeDisabled();
    await noOverflow(page); await page.screenshot({ path: info.outputPath('consent-rejected.png'), fullPage: true, scale: 'css' });
});
