'use strict';
/** Full service-management journey on owned real OAuth/FHIR listeners and certificates. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const available = fs.existsSync(path.join(root, 'test-support/services-fixture.js'));
let fixture;
test.beforeAll(async () => { if (available) fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture(); });
test.afterAll(async () => { if (fixture) await fixture.close(); });
test.beforeEach(async ({ context }) => {
    test.skip(!available, 'requires owned repository/certificate fixtures');
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
});
/** Save one private action and refresh only after its actual result is visible. */
async function change(page, id, action) {
    const resource = fixture.store.get('HealthcareService', id), catalog = !resource.providedBy;
    const role = Object.entries(fixture.config.organizations).find(([, org]) => resource.providedBy?.reference === `Organization/${org.id}`)?.[0] || 'serviceProvider';
    await page.goto(`${fixture.base}/admin/services?view=${catalog ? 'catalog' : 'assignments'}&providerRole=${role}&target=${id}`);
    const row = page.locator(catalog ? `[data-catalog-id="${id}"]` : `[data-service-id="${id}"]`);
    if (!catalog) await row.locator('[data-service-expansion] > summary').click();
    const form = row.locator('[data-service-sandbox]');
    if (action === 'Delete') await form.locator('details > summary').click();
    page.once('dialog', dialog => dialog.accept());
    await form.locator(`button[value="${{ Activate: 'activate', Disable: 'disable', Enable: 'enable', Delete: 'delete' }[action]}"]`).click();
    if (catalog) {
        await expect(form.locator('[data-service-result]')).toContainText(action === 'Delete' ? 'Deleted from this runtime' : 'Sandbox change saved');
        await form.getByRole('link', { name: 'Refresh Services' }).click();
    } else if (action === 'Delete') await expect(row).toHaveCount(0);
    else await expect(row.locator('[data-connection-result]')).toContainText('Sandbox change saved');
}

test('Services creates, activates, assigns, disables/enables and safely deletes through labelled boundaries @smoke', async ({ page }, info) => {
    test.setTimeout(120000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.base}/admin/services`);
    await expect(page.getByRole('checkbox', { name: 'Explain this page' })).not.toBeChecked();
    await page.locator('[data-service-new]').click();
    const create = page.locator('[data-service-create]');
    const name = `Owned browser service ${info.project.name}`;
    await create.getByLabel('Service name', { exact: true }).fill(name);
    await create.getByLabel('Purpose', { exact: true }).fill('Disposable service management verification');
    await create.locator('[data-service-bucket="laboratoryTests"] input[name="enabled"]').check();
    await expect(create.locator('[data-scope-origin]')).toHaveText('Generated');
    const beforeCreate = fixture.requests.filter(request => request.method === 'POST' && request.path.endsWith('/HealthcareService')).length;
    await create.getByRole('button', { name: 'Create service', exact: true }).dblclick();
    await expect(create.locator('[data-service-result]')).toContainText('Created pending definition');
    expect(fixture.requests.filter(request => request.method === 'POST' && request.path.endsWith('/HealthcareService')).length).toBe(beforeCreate);
    const catalog = fixture.store.getAll('HealthcareService').find(service => service.name === name && !service.providedBy);
    const catalogId = catalog.id;
    await expect(create.getByRole('button', { name: 'Create service', exact: true })).toBeDisabled();
    await page.locator('[data-service-cancel]').click(); await change(page, catalogId, 'Activate');
    await page.locator('[data-service-peer="assignments"]').click();
    const firstAssignment = page.locator(`[data-service-group="${catalogId}"] [data-provider-pair="${fixture.config.organizations.serviceProvider.id}"] [data-service-assign]`);
    await firstAssignment.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator(`[data-service-group="${catalogId}"]`)).toContainText('Assigned — waiting for activation');
    const instance = fixture.store.getAll('HealthcareService').find(service => service.name === name && service.providedBy);
    await change(page, instance.id, 'Activate');
    const assign = page.locator(`[data-service-group="${catalogId}"] [data-provider-pair="${fixture.config.organizations.hospitalBServiceProvider.id}"] [data-service-assign]`);
    await assign.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator(`[data-service-group="${catalogId}"]`)).toContainText('Assigned — waiting for activation');
    const second = fixture.store.getAll('HealthcareService').find(service => service.name === name && service.providedBy?.reference.endsWith(fixture.config.organizations.hospitalBServiceProvider.id));
    await change(page, second.id, 'Activate'); await change(page, second.id, 'Disable'); await change(page, second.id, 'Enable');
    await change(page, second.id, 'Disable'); await change(page, second.id, 'Delete');
    await change(page, instance.id, 'Disable'); await change(page, instance.id, 'Delete');
    await change(page, catalogId, 'Disable'); await change(page, catalogId, 'Delete');
    expect(fixture.store.get('HealthcareService', catalogId)).toBeNull();
    const creates = fixture.requests.filter(request => request.method === 'POST' && request.path.endsWith('/HealthcareService') && request.status === 201);
    expect(new Set(creates.map(request => request.organization)).size).toBe(2);
    expect(new Set(creates.map(request => request.certificate)).size).toBe(2);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('deleting a pending registration keeps its hidden shared definition reviewable @smoke', async ({ page }, info) => {
    const template = require(path.join(root, 'src/pcm-core/src/service-templates')).loadTemplates()[0];
    const request = structuredClone(template.request); request.name = `Pending cleanup ${info.project.name}`;
    const lifecycle = require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle'));
    const created = lifecycle.registerHealthcareService({ store: fixture.store, callerOrganization: fixture.store.get('Organization', fixture.config.organizations.serviceProvider.id), request });
    const instance = created.instance, id = created.canonical.id;
    await page.goto(`${fixture.base}/admin/services?target=${instance.id}`);
    await change(page, instance.id, 'Delete');
    await page.goto(`${fixture.base}/admin/services?view=catalog&target=${id}`);
    await expect(page.locator(`[data-catalog-id="${id}"]`)).toBeVisible();
    await change(page, id, 'Delete');
    expect(fixture.store.get('HealthcareService', id)).toBeNull();
});

test('Services Explain opens fields and disabled action help without operations, including narrow layout @smoke', async ({ page }, info) => {
    await page.goto(`${fixture.base}/admin/services`);
    const before = fixture.events.length;
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    for (const [key, text] of [['catalog', 'shared definition'], ['restart', 'Uncheckpointed runtime changes']]) {
        const target = page.locator(`[data-help-key="services.${key}"]:visible`).first();
        await target.focus(); await expect(page.getByRole('tooltip')).toContainText(text); await page.keyboard.press('Escape');
    }
    const row = page.locator('[data-catalog-id]').first();
    await row.locator('[data-catalog-overflow] > summary').click();
    await row.locator('[data-help-for="services.delete"]').last().focus();
    await expect(page.getByRole('tooltip')).toContainText('resolving all dependencies');
    expect(fixture.events.length).toBe(before);
    await page.screenshot({ path: `/artifacts/services-${info.project.name}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
    await expect(page.locator('[data-help-for]')).toHaveCount(0);
    await page.evaluate(() => document.body.style.zoom = '150%');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Services explanations open by native touch with a keyboard counterpart @smoke', async ({ browser }) => {
    const touch = browser.browserType().name() !== 'firefox';
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch, ...(touch ? { isMobile: true } : {}) });
    try {
        await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
        const page = await context.newPage();
        await page.goto(`${fixture.base}/admin/services`);
        const before = fixture.events.length;
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const target = page.locator('[data-help-key="services.restart"]');
        if (touch) await target.tap(); else await target.focus();
        await expect(page.getByRole('tooltip')).toContainText('Uncheckpointed runtime changes');
        expect(fixture.events.length).toBe(before);
    } finally { await context.close(); }
});

/** Real native-touch/keyboard path from compact picker to one ordinary pending registration. */
test('Services scoped CSS preserves representative Consent Doctor and Admin layouts @smoke', async ({ page }, info) => {
    const ejs = require(path.join(root, 'node_modules/ejs'));
    const render = (file, values) => ejs.render(fs.readFileSync(path.join(root, file), 'utf8'), values);
    const links = { pcmUi: fixture.base, spClient: fixture.base };
    const samples = {
        Consent: render('src/pcm-core/src/views/dashboard.ejs', { teamId: 'layout-owned', consents: [], workflowUrl: `${fixture.base}/workflow`, publicBaseUrls: links }),
        Doctor: render('src/sp-client/src/views/index.ejs', { teamId: 'layout-owned', consents: [], identities: [], currentIdentity: 'fixture', flash: null, patients: [], selectedPatientId: '', patientInventory: { state: 'empty' }, conformance: { mode: 'connectathon', resultLabel: 'Synthetic fixture', warnings: [] }, publicBaseUrls: links }),
        Admin: require(path.join(root, 'src/pcm-core/src/routes/ui'))._test.renderAdminHtml({ protocol: 'http', get: key => key === 'host' ? new URL(fixture.base).host : undefined })
    };
    const amended = fs.readFileSync(path.join(root, 'src/shared/ui/connectathon.css'), 'utf8');
    const baseline = amended.slice(0, amended.indexOf('/* Complete Services catalog uses semantic columns'));
    const results = {};
    for (const [name, html] of Object.entries(samples)) {
        // Keep real authored markup while isolating layout from optional page controllers and requests.
        const content = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, '');
        await page.setContent(content);
        const style = await page.addStyleTag({ content: baseline });
        const measure = () => page.locator('h1,main,.container,button,input,select,.row').evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(); return [node.tagName, box.x, box.y, box.width, box.height];
        }));
        const before = await measure();
        await style.evaluate((node, css) => node.textContent = css, amended);
        const after = await measure();
        expect(after).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        results[name] = { measuredElements: after.length, unchanged: true, overflow: false };
        await page.screenshot({ path: `/artifacts/shared-${name}-${info.project.name}.png`, fullPage: true });
    }
    fs.writeFileSync(`/artifacts/shared-layout-${info.project.name}.json`, JSON.stringify(results, null, 2));
});

// Selected-provider LIST and REGISTRATION journeys are superseded by services-directory.spec.js:
// all-provider grouping/filter/details, exact owner lifecycle, honest named paging and response fences.
test('Services REGISTRATION uncertain suspension is inspected before retry without losing draft @smoke', async ({ page }) => {
    const lifecycle = require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle'));
    const service = fixture.store.getAll('HealthcareService').find(item => lifecycle.serviceKind(item) === 'instance' && lifecycle.ownerId(item) === fixture.config.organizations.serviceProvider.id && lifecycle.businessStatus(item) === 'active');
    expect(service).toBeTruthy();
    await page.goto(`${fixture.base}/admin/services?view=assignments`);
    await page.locator('[data-service-new]').click(); const draft = page.locator('[data-service-create]'); await draft.getByLabel('Service name', { exact: true }).fill('Draft during uncertain suspension');
    await page.locator('[data-service-cancel]').click();
    const row = page.locator(`[data-service-id="${service.id}"]`); await row.locator('[data-service-expansion] > summary').click();
    const form = row.locator('[data-service-status-form]');
    await page.route(`**/admin/services/${service.id}/status`, async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
    page.once('dialog', dialog => dialog.accept()); await form.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(form.locator('[data-service-result]')).toContainText('result is uncertain');
    await expect(form.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
    expect(lifecycle.businessStatus(fixture.store.get('HealthcareService', service.id))).toBe('suspended');
    await page.getByRole('link', { name: 'Refresh from first page', exact: true }).click(); await expect(page.locator('[data-services-loading]')).toBeHidden();
    await expect(row).toContainText('Paused'); await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await expect(draft.getByLabel('Service name', { exact: true })).toHaveValue('Draft during uncertain suspension');
    page.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(row.locator('[data-connection-result]')).toContainText('Registration active');
    await page.getByRole('link', { name: 'Refresh from first page', exact: true }).click(); await expect(page.locator('[data-services-loading]')).toBeHidden();
    const before = fixture.requests.filter(item => item.method === 'PUT').length;
    await page.route(`**/admin/services/${service.id}/status`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Upstream outcome unavailable' }) }), { times: 1 });
    page.once('dialog', dialog => dialog.accept()); await row.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(row.locator('[data-service-status-form] [data-service-result]')).toContainText('result may be uncertain');
    await expect(row.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await row.locator('[data-help-for="services.lifecycle"]').first().focus(); await expect(page.getByRole('tooltip')).toContainText('terminal');
    await page.keyboard.press('Escape'); expect(fixture.requests.filter(item => item.method === 'PUT').length).toBe(before);
});
