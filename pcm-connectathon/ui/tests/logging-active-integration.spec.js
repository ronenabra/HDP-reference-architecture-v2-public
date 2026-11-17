'use strict';
/** Render the integrated authored Consent template with synthetic local data.
 * This is browser/template integration, not a live SMART authorization journey.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const fixtureOrigin = 'https://integration-help.test';
const templatePath = path.join(root, 'src/pcm-core/src/views/consent.ejs');
// The maintained Docker suite copies only tests and assets; these additional
// template checks explicitly require the owned repository fixture environment.
test.beforeEach(() => test.skip(!fs.existsSync(templatePath), 'requires authored repository templates; live Consent remains covered by help-integration.spec.js'));

async function consentFixture(page, state) {
    const commands = [];
    const ejs = require(path.join(root, 'node_modules/ejs'));
    const template = templatePath;
    const html = ejs.render(fs.readFileSync(template, 'utf8'), {
        consentPresentation: require(path.join(root, 'src/shared/consent-presentation')), teamId: 'synthetic-integration', consent: { id: 'synthetic-consent', status: state, patient: { identifier: { value: '000000018' } } },
        requesterName: 'Synthetic Doctor', serviceName: 'Synthetic catalog service',
        dataSources: [{ id: 'ho-a', name: 'Synthetic HO A', endpoint: 'https://ho-a.invalid', selected: true }],
        scopeOptions: [{ id: 'auto-resources', kind: 'generated', label: 'All service resource types — Auto-generated', value: 'patient/Patient.rs patient/Observation.rs' }],
        selectedScope: 'patient/Patient.rs patient/Observation.rs', sourceCsrf: 'synthetic-csrf',
        sourceView: { canEdit: true, notice: 'Synthetic sandbox only', version: 2,
            choices: [{ id: 'ho-a', name: 'Synthetic HO A', eligible: true, selected: true, state: 'available' },
                { id: 'ho-b', name: 'Synthetic HO B', eligible: true, selected: false, state: 'available' }] }
    }, { filename: template });
    await page.route(`${fixtureOrigin}/**`, route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== 'GET') {
            commands.push(request.postDataJSON());
            return route.fulfill({ status: 401, json: { error: 'Synthetic authentication failure; no application state was changed' } });
        }
        if (url.pathname.startsWith('/assets/')) {
            const name = path.basename(url.pathname);
            if (!['connectathon.css', 'admin-feedback.js', 'connectathon.js', 'source-change.js', 'consent-cancellation.js', 'approval-scopes.js', 'help-copy.js', 'help.js'].includes(name)) return route.abort();
            return route.fulfill({ body: fs.readFileSync(path.join(root, 'src/shared/ui', name)), contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript' });
        }
        return route.fulfill({ body: html, contentType: 'text/html' });
    });
    await page.goto(`${fixtureOrigin}/consent`);
    return commands;
}

for (const state of ['proposed', 'active']) test(`Integrated Consent ${state} keeps help and source-change intent separate @smoke`, async ({ page }, testInfo) => {
    const commands = await consentFixture(page, state);
    const values = () => page.locator('form input').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked]));
    const before = await values();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const target = page.locator(state === 'proposed' ? '#scope-auto-resources' : '[data-source-apply]');
    if (state === 'active') await page.locator('[data-help-key="demo.source-change"]').first().focus();
    else await target.focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveJSProperty('tagName', 'DIV');
    if (state === 'proposed') await expect(tooltip).toContainText('Generated data types');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    expect(await values()).toEqual(before);
    expect(commands).toEqual([]);
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    if (state === 'active') {
        const apply = page.locator('[data-source-apply]'), cancel = page.locator('[data-source-cancel]');
        await expect(apply).toBeDisabled(); await expect(cancel).toBeDisabled();
        await page.locator('#sim-ho-b').check();
        await expect(apply).toBeEnabled(); await cancel.click();
        await expect(page.locator('#sim-ho-b')).not.toBeChecked(); await expect(apply).toBeDisabled();
        await page.locator('#sim-ho-a').uncheck();
        await apply.click();
        await expect(page.locator('[data-source-result]')).toContainText('Admin login is required');
        expect(commands).toEqual([{ action: 'apply', sourceIds: [], expectedVersion: '2', csrf: 'synthetic-csrf' }]);
    }
    const audit = await new AxeBuilder({ page }).analyze();
    await testInfo.attach('consent-template-axe', { body: JSON.stringify(audit.violations), contentType: 'application/json' });
    expect(audit.violations.filter(item => ['serious', 'critical'].includes(item.impact) || item.id === 'aria-allowed-role')).toEqual([]);
});
