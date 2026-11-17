'use strict';
/** Desktop/mobile authored-template lifecycle, command confirmation and recovery checks. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const available = fs.existsSync(path.join(root, 'src/shared/consent-status.js'));
const ejs = available ? require(path.join(root, 'node_modules/ejs')) : null;
const status = available ? require(path.join(root, 'src/shared/consent-status')).consentStatus : null;
const states = { requested: 'proposed', active: 'active', rejected: 'rejected', 'temporarily-inactive': 'inactive', 'permanently-inactive': 'inactive', 'service-provider-cancelled': 'inactive' };
test.beforeEach(() => test.skip(!available, 'requires read-only repository mount: PCM_NAV_REPO'));

/** Serve real templates/assets and a controlled command result; no retained runtime is mutated. */
async function fixture(page, state = 'active', outcome = 200) {
    let code = state, version = 2, commands = [];
    const consent = () => ({ id: 'fixture-consent', status: states[code], meta: { versionId: String(version) },
        patient: { identifier: { value: '000000018' } }, provision: { period: { start: '2026-10-01T00:00:00Z', end: '2027-04-01T00:00:00Z' } },
        extension: [{ url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status', valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-consent-business-status', code } }] });
    const render = file => ejs.render(fs.readFileSync(path.join(root, file), 'utf8'), {
        consentPresentation: require(path.join(root, 'src/shared/consent-presentation')), workflowUrl: 'https://cancel.test/sandbox/authentication', teamId: 'cancel-fixture', consent: consent(), lifecycle: status(consent()), consents: [{ ...consent(), lifecycle: status(consent()), requesterName: 'Provider', serviceName: 'Service', parentOrgName: 'Parent' }],
        publicBaseUrls: { pcmUi: '', spClient: '' }, requesterName: 'Provider', serviceName: 'Service', dataSources: [], scopeOptions: [], selectedScope: '', sourceCsrf: 'source-csrf',
        sourceView: { choices: [], version: String(version), canEdit: code === 'active', notice: 'Sandbox only' },
        cancellation: { canCancel: ['requested', 'active'].includes(code), providerRole: 'serviceProvider', providerName: 'Provider', version: String(version), csrf: 'version-csrf', reason: ['requested', 'active'].includes(code) ? '' : 'This state cannot be cancelled or restored.' }
    });
    await page.route('https://cancel.test/**', route => {
        const url = new URL(route.request().url());
        if (route.request().method() === 'POST') {
            commands.push(route.request().postDataJSON());
            if ([200, 409].includes(outcome)) { code = outcome === 200 ? 'service-provider-cancelled' : 'temporarily-inactive'; version++; }
            return route.fulfill({ status: outcome, json: { error: 'Provider unavailable', status: status(consent()) } });
        }
        if (url.pathname.startsWith('/assets/')) {
            return route.fulfill({ body: fs.readFileSync(path.join(root, 'src/shared/ui', path.basename(url.pathname))), contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
        }
        return route.fulfill({ contentType: 'text/html', body: render(url.pathname === '/ui' ? 'src/pcm-core/src/views/dashboard.ejs' : 'src/pcm-core/src/views/consent.ejs') });
    });
    await page.goto('https://cancel.test/ui/approve/fixture-consent');
    return commands;
}
for (const code of Object.keys(states)) test(`Consent ${code} shows evidence and keeps read-only navigation @smoke`, async ({ page }) => {
    await fixture(page, code);
    await expect(page.locator('[data-consent-status]')).toContainText(`FHIR record status: ${states[code]}`);
    await expect(page.locator('[data-consent-status]')).toContainText('No status-change time or person responsible is available');
    const button = page.getByRole('button', { name: 'Permanently cancel consent', exact: true });
    if (['requested', 'active'].includes(code)) await expect(button).toBeEnabled(); else await expect(button).toBeDisabled();
    if (!['requested', 'active'].includes(code)) { await expect(page.locator('[data-source-change]')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Approve request' })).toHaveCount(0); }
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.locator('h2[data-help-key="pcm.cancel-consent"]').focus();
    // Enabled controls support keyboard descriptions; disabled controls retain their section explanation.
    await page.locator('h2[data-help-key="pcm.cancel-consent"]').hover();
    await expect(page.getByRole('tooltip')).toContainText('Cancel this consent');
    await page.goto('https://cancel.test/ui');
    await expect(page.locator('[data-help-key="pcm.review"], [data-help-key="pcm.review-details"]').filter({ hasText: /Review|View Consent/ }).last()).toHaveAttribute('href', '/ui/approve/fixture-consent');
});
for (const outcome of [200, 409, 401, 503]) test(`Permanently cancel consent confirmation and outcome ${outcome} refresh or explain recovery @smoke`, async ({ page }) => {
    const commands = await fixture(page, 'active', outcome);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).click(); expect(commands).toEqual([]);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).click();
    if (outcome === 200) await expect(page.locator('[data-consent-status]')).toContainText('Service Provider cancelled');
    else if (outcome === 409) await expect(page.locator('[data-consent-status]')).toContainText('Temporarily inactive');
    else await expect(page.locator('[data-cancellation-result]')).toContainText(outcome === 401 ? 'Admin login is required' : 'Provider unavailable');
    expect(commands).toEqual([{ expectedVersion: '2', providerRole: 'serviceProvider', csrf: 'version-csrf' }]);
    expect(JSON.stringify(commands)).not.toMatch(/access_token|private_key|adminPassword/);
    await expect(page.getByRole('link', { name: 'Back to Consents' }).last()).toBeVisible();
});

test('details fields and disabled actions open their own Explain text without sending commands @smoke', async ({ page }) => {
    const commands = await fixture(page);
    await expect(page.getByRole('checkbox', { name: 'Explain this page' })).not.toBeChecked();
    await expect(page.getByRole('tooltip')).toBeHidden();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    for (const [key, text] of [
        ['pcm.details-title', 'Review the recorded consent'], ['pcm.request-information', 'These fields identify'],
        ['pcm.approval-dates', 'These dates bound'], ['pcm.status-history', 'A general record-update timestamp'],
        ['pcm.recorded-sources', 'Being listed does not confirm'], ['pcm.saved-permissions', 'actually issues'],
        ['pcm.permission-choice', 'whether the saved scope'], ['pcm.source-history', 'does not represent a new patient approval'],
        ['pcm.refresh', 'Unsaved checkbox changes'], ['pcm.cancel', 'without saving changes']
    ]) {
        await page.locator(`[data-help-key="${key}"]`).first().focus();
        await expect(page.getByRole('tooltip')).toContainText(text);
        await page.keyboard.press('Escape');
    }
    await page.locator('[data-help-for="pcm.source-save"]').focus();
    await expect(page.getByRole('tooltip')).toContainText('Change at least one source selection');
    expect(commands).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await expect(page.locator('[data-help-for]')).toHaveCount(0);
    await page.evaluate(() => document.body.style.zoom = '150%');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
