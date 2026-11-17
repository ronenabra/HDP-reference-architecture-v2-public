'use strict';
/** Public-only real Doctor UI, passive boundaries, responsive cards, clipboard and explicit status. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer(); });
test.afterAll(async () => { await fixture?.close(); });
const card = page => page.locator('[data-consent-card]').first();
/** Open a native disclosure with the same keyboard operation at every viewport. */
async function disclose(page, label) { const target = card(page).locator('summary').filter({ hasText: label }); await target.focus(); await page.keyboard.press('Enter'); }
/** Wait for page's actual new document after clicking button; deferred submission returns a completion promise. */
async function submit(page, button) { await Promise.all([page.waitForEvent('load'), button.click()]); }
/** Discover on page, select target card's fixture source, and resolve after the selection control changes. */
async function discover(page, target = card(page)) {
    await submit(page, target.getByRole('button', { name: 'Check / Discover', exact: true }));
    await target.locator('[data-source-choice]').selectOption(fixture.base + '/source-1');
}

test('compact two-card dimensions, full IDs, keyboard disclosures and zero-effect copying/help', async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(), dimensions = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(fixture.doctorBase);
        await expect(page.locator('[data-consent-card]')).toHaveCount(2);
        expect(await page.locator('[data-card-disclosure][open]').count()).toBe(0);
        await page.locator('[data-consent-card]').evaluateAll(nodes => nodes.forEach(node => { node.style.width = '720px'; }));
        const normal = await page.locator('[data-consent-card]').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        fs.writeFileSync(info.outputPath('normal-dimensions.json'), JSON.stringify(normal, null, 2));
        expect(normal.every(value => value.width === 720 && value.height <= 360)).toBe(true);
        await page.screenshot({ path: info.outputPath('normal-two-cards-1440.png'), fullPage: true });
        const original = await card(page).locator('[data-consent-id]').textContent();
        const before = fixture.requests.length;
        await disclose(page, 'Approval details');
        await expect(card(page).getByText('Granted permissions not yet obtained', { exact: true })).toBeVisible();
        await expect(card(page).getByText('Token status not checked.')).toBeVisible();
        await disclose(page, 'Request overrides'); await disclose(page, 'View FHIR requests');
        await card(page).getByRole('button', { name: 'Copy Consent ID', exact: true }).click();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);
        await page.getByLabel('Explain this page', { exact: true }).check();
        await card(page).locator('[data-copy-consent]').focus(); await page.keyboard.press('Escape');
        await page.getByLabel('Explain this page', { exact: true }).uncheck();
        expect(fixture.requests.length).toBe(before);
        expect(fixture.violations).toEqual([]);
        for (const width of [1440, 1024, 390, 320]) {
            await page.locator('[data-consent-card]').evaluateAll(nodes => nodes.forEach(node => { node.style.width = ''; }));
            await page.setViewportSize({ width, height: 1000 });
            await expect(card(page).getByRole('button', { name: 'Fetch data', exact: true })).toBeVisible();
            dimensions.push(await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('[data-consent-card]')].map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) })));
            expect(dimensions.at(-1).scroll).toBeLessThanOrEqual(width + 1);
            await page.screenshot({ path: info.outputPath('expanded-' + width + '.png'), fullPage: true });
        }
        await page.setViewportSize({ width: 1024, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('zoom-200.png'), fullPage: true });
        fs.writeFileSync(info.outputPath('dimensions.json'), JSON.stringify(dimensions, null, 2)); expect(errors).toEqual([]);
    } finally { await context.close(); }
});

test('64-character case/dot/hyphen ID and long/multisource/error content wraps with manual copy fallback', async ({ browser }, info) => {
    const longId = ('aB.cD-' + 'Z'.repeat(58)); expect(longId.length).toBe(64);
    const original = [...fixture.consents.values()][0], value = structuredClone(original);
    value.id = longId; value.identifier[0].value = 'BUSINESS-IDENTIFIER-IS-SEPARATE';
    value.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '324573740' }; value.patient.display = 'Long public patient name '.repeat(12);
    value.provision.actor.push({ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: 'Organization/public-source-2' } });
    fixture.consents.set(longId, value); fixture.instance.name = 'Long service name '.repeat(16);
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    try {
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
        await page.goto(fixture.doctorBase);
        const target = page.locator('[data-consent-card]').filter({ has: page.locator(`[data-consent-id]:text-is("${longId}")`) });
        await expect(target).toHaveCount(1); expect(await target.locator('[data-consent-id]').textContent()).toBe(longId);
        const headings = [];
        for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1024, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
            const layout = await target.locator('.doctor-card-heading').evaluate(node => {
                const name = node.querySelector('strong'), badge = node.querySelector('.badge');
                const range = document.createRange(); range.selectNodeContents(badge);
                const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
                return { name: name.textContent, status: badge.textContent, statusLines: lines.size,
                    badgeWidth: badge.getBoundingClientRect().width, badgeScrollWidth: badge.scrollWidth,
                    badgeClientWidth: badge.clientWidth, scroll: document.documentElement.scrollWidth, viewport: innerWidth };
            });
            expect(layout.name).toContain(value.patient.display);
            expect(layout.name).toContain(value.patient.identifier.value);
            expect(layout.status).toBe('Recorded: active');
            expect(layout.statusLines, `readable complete status at ${width}px / ${zoom * 100}%`).toBe(1);
            expect(layout.badgeScrollWidth).toBeLessThanOrEqual(layout.badgeClientWidth + 1);
            expect(layout.scroll).toBeLessThanOrEqual(layout.viewport + 1);
            headings.push({ width, zoom, ...layout });
            await page.screenshot({ path: info.outputPath(`long-heading-${width}-${zoom * 100}.png`), fullPage: true });
        }
        fs.writeFileSync(info.outputPath('long-heading-dimensions.json'), JSON.stringify(headings, null, 2));
        await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        await page.setViewportSize({ width: 320, height: 900 });
        await discover(page, target);
        await expect(target.locator('[data-source-choice] option')).toHaveCount(3);
        await expect(target.locator('[data-source-choice]')).toContainText('Public source 2');
        await target.getByRole('button', { name: 'Copy Consent ID' }).click(); await expect(target.locator('[data-copy-feedback]')).toContainText('Clipboard unavailable');
        expect(await target.locator('[data-consent-id]').evaluate(node => { const selection = getSelection(), range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range); return selection.toString(); })).toBe(longId);
        await target.getByText('Approval details', { exact: true }).click();
        await target.getByText('Request overrides', { exact: true }).click();
        await target.getByText('View FHIR requests', { exact: true }).click();
        await expect(target).toContainText('BUSINESS-IDENTIFIER-IS-SEPARATE');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('long-id-mobile-320.png'), fullPage: true });
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }));
        await page.reload(); await target.getByRole('button', { name: 'Copy Consent ID' }).click(); await expect(target.locator('[data-copy-feedback]')).toContainText('Clipboard denied');
        await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedConsent = value; } } }));
        await page.reload(); await target.getByRole('button', { name: 'Copy Consent ID' }).click(); expect(await page.evaluate(() => window.copiedConsent)).toBe(longId);
        expect(fixture.violations).toEqual([]);
    } finally { fixture.consents.delete(longId); fixture.instance.name = 'Clinical summary'; await context.close(); }
});

test('public token response and optional status matrix preserve refusal; inactive blocks fetch and clears results', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 1000 });
    await page.goto(fixture.doctorBase);
    await discover(page);
    await disclose(page, 'Request overrides'); await card(page).locator('[name="requestedScope"]').fill('patient/Observation.rs patient/Condition.r');
    await submit(page, card(page).getByRole('button', { name: 'Fetch data', exact: true }));
    await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toBeVisible();
    await disclose(page, 'Approval details');
    await expect(card(page).locator('[aria-label="Token response"]')).toContainText('Validated token-response grant');
    const acquired = await card(page).locator('[aria-label="Token response"]').textContent();
    expect(acquired).not.toContain('opaque-doctor-public');
    for (const outcome of ['refused', 'unsupported', 'unavailable', 'issuer-valid', 'active']) {
        fixture.state.introspection = outcome;
        await submit(page, card(page).getByRole('button', { name: 'Check token status', exact: true }));
        await disclose(page, 'Approval details');
        await expect(card(page).locator('[data-token-status]')).toContainText(['active', 'issuer-valid'].includes(outcome) ? 'Active when checked at' : 'Not independently checked');
        await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toBeVisible();
        expect(await card(page).locator('[aria-label="Token response"]').textContent()).toBe(acquired);
    }
    await page.screenshot({ path: info.outputPath('active-token-response.png'), fullPage: true });
    fixture.state.introspection = 'issuer-mismatch';
    await submit(page, card(page).getByRole('button', { name: 'Check token status', exact: true }));
    await disclose(page, 'Approval details');
    await expect(card(page).locator('[data-token-status]')).toContainText('Contradictory or invalid');
    await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Fetch data', exact: true })).toBeDisabled();
    fixture.state.introspection = 'active';
    await discover(page);
    await submit(page, card(page).getByRole('button', { name: 'Fetch data', exact: true }));
    await disclose(page, 'Approval details');
    fixture.state.introspection = 'inactive';
    await submit(page, card(page).getByRole('button', { name: 'Check token status', exact: true }));
    await disclose(page, 'Approval details');
    await expect(card(page).locator('[data-token-status]')).toContainText('PCM reports token inactive');
    await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    await expect(card(page).getByRole('button', { name: 'Fetch data', exact: true })).toBeDisabled();
    expect(fixture.violations).toEqual([]);
    fs.writeFileSync(info.outputPath('public-network.json'), JSON.stringify({ requests: fixture.requests, violations: fixture.violations }, null, 2));
    fixture.state.introspection = 'active';
});

test('contradictory status, external PCM refusal and local expiry never keep clinical authority', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(fixture.doctorBase);
    await discover(page);
    await disclose(page, 'Request overrides'); await card(page).locator('[name="requestedScope"]').fill('patient/Observation.s');
    fixture.state.rejectClinical = true;
    await submit(page, card(page).getByRole('button', { name: 'Fetch data', exact: true }));
    await expect(page.locator('[data-help-key="common.feedback"]')).toContainText('External PCM rejects requested scope');
    await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('external-pcm-error.png'), fullPage: true });
    fixture.state.rejectClinical = false;
    await submit(page, card(page).getByRole('button', { name: 'Fetch data', exact: true }));
    await disclose(page, 'Approval details'); fixture.state.introspection = 'contradictory';
    await submit(page, card(page).getByRole('button', { name: 'Check token status', exact: true }));
    await disclose(page, 'Approval details');
    await expect(card(page).locator('[data-token-status]')).toContainText('Contradictory or invalid');
    await expect(card(page).getByRole('button', { name: 'Fetch data', exact: true })).toBeDisabled();
    await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    fixture.state.introspection = 'active'; fixture.state.lifetime = 2;
    await discover(page);
    await submit(page, card(page).getByRole('button', { name: 'Fetch data', exact: true }));
    await disclose(page, 'Approval details');
    await expect(card(page).locator('[data-token-status]')).toContainText('Token expired locally', { timeout: 6000 });
    await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
    fixture.state.lifetime = 30;
    expect(fixture.violations).toEqual([]);
});

test('capability-disabled and Strict fixtures disable the explicit status button without probing PCM', async ({ page }) => {
    const client = require(path.join(root, 'src/sp-client/src/client')), original = client.ownTokenInspectionCapability;
    try {
        for (const strict of [false, true]) {
            client.ownTokenInspectionCapability = () => original({ conformance: { preset: strict ? 'strict' : 'connectathon-easy' }, security: { pcmApi: { allowServiceProviderOwnTokenIntrospection: false } } }, { mode: strict ? 'strict' : 'connectathon' });
            await page.goto(fixture.doctorBase); const count = fixture.requests.filter(value => value.path.endsWith('/introspect')).length;
            await disclose(page, 'Approval details');
            await expect(card(page).getByRole('button', { name: 'Check token status', exact: true })).toBeDisabled();
            await expect(card(page).locator('[data-token-status]')).toContainText(strict ? 'Introspection disabled in Strict' : 'Introspection disabled');
            expect(fixture.requests.filter(value => value.path.endsWith('/introspect')).length).toBe(count);
        }
    } finally { client.ownTokenInspectionCapability = original; }
});

test('delayed actual public introspection cannot repopulate a changed source/card generation', async ({ page }) => {
    await page.goto(fixture.doctorBase);
    await discover(page);
    await disclose(page, 'Request overrides'); await card(page).locator('[name="requestedScope"]').fill('patient/Observation.s');
    await submit(page, card(page).getByRole('button', { name: 'Fetch data', exact: true }));
    await disclose(page, 'Approval details');
    const fields = await page.locator('form[id^="status-"]').first().evaluate(form => Object.fromEntries(new FormData(form)));
    let release; fixture.state.statusDelay = new Promise(resolve => { release = resolve; });
    const count = fixture.requests.filter(value => value.path.endsWith('/introspect')).length;
    const pending = page.request.post(fixture.doctorBase + '/token-status', { form: fields, maxRedirects: 0 });
    try {
        await expect.poll(() => fixture.requests.filter(value => value.path.endsWith('/introspect')).length).toBe(count + 1);
        await disclose(page, 'Request overrides');
        const selectionSaved = page.waitForResponse(response => response.url().endsWith('/selection') && response.ok());
        await card(page).locator('[name="endpointUrl"]').fill(fixture.base + '/source-2'); await selectionSaved;
        await expect(card(page).locator('[data-token-status]')).toContainText('changed context');
        release(); await pending;
        await page.reload(); await disclose(page, 'Approval details');
        await expect(card(page).locator('[data-token-details]')).toContainText('Granted permissions not yet obtained');
        await expect(card(page).locator('[data-token-status]')).not.toContainText('Active when checked');
        await expect(card(page).locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
        expect(fixture.violations).toEqual([]);
    } finally { release(); fixture.state.statusDelay = null; }
});
