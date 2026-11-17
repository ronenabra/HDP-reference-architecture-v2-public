'use strict';
/** Real mounted Admin/catalog qualification with ordinary OAuth discovery and immutable approval checks. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/mounted' }); });
test.afterAll(async () => { await fixture?.close(); });

/** Open an owned page with desktop keyboard or native touch controls. */
async function open(browser, info) {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), errors = [], traffic = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/admin/services')) traffic.push({ method: response.request().method(), url: response.url(), status: response.status() }); });
    await page.goto(fixture.base + '/admin/services');
    return { page, context, errors, traffic, click: locator => mobile ? locator.tap() : locator.click() };
}

/** Explicitly inspect saved server state before using the next version-bound action. */
async function inspect(page, click, row) {
    await click(row.getByRole('link', { name: 'Refresh Services', exact: true }));
    await expect(page.locator('[data-services-loading]')).toBeHidden();
}

/** Create a genuine frozen decision against an existing registration through its existing lifecycle. */
function frozenDecision() {
    const { createConsent, approveConsent } = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle'));
    const { EXTENSIONS } = require(path.join(root, 'src/shared/pcm-contract'));
    const body = structuredClone(require(path.join(root, 'docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
    body.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${fixture.config.service.id}`;
    const clock = () => new Date();
    const pending = createConsent({ store: fixture.store, config: fixture.config, callerOrganization: fixture.store.get('Organization', fixture.config.organizations.serviceProvider.id), request: body, clock });
    return approveConsent({ store: fixture.store, consent: pending, scopeChoice: 'service-provided', sourceOrganizationIds: fixture.config.healthOrganizations.map(source => source.dataSourceOrganization.id), clock });
}

test('CATALOG zero-provider create, row approval/disable/enable/details/delete preserve drafts and authority on desktop and touch', async ({ browser }, info) => {
    const { page, context, click, errors, traffic } = await open(browser, info);
    try {
        const requests = fixture.requests.length;
        await expect(page.locator('[data-service-peer="catalog"]')).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('#service-provider')).toBeHidden();
        expect(fixture.requests.length).toBe(requests); // Catalog and Help use no ordinary discovery/token traffic.
        const frozen = frozenDecision(), approvals = JSON.stringify(fixture.store.privateState.approvals);
        const instances = () => fixture.store.getAll('HealthcareService').filter(service => service.providedBy);
        const before = instances();
        await click(page.locator('[data-service-new]')); await expect(page.locator('#service-create-heading')).toBeFocused();
        const form = page.locator('[data-service-create]'); await click(form.locator('[data-service-template-pick]').first());
        const name = `Catalog contextual ${info.project.name}`;
        await form.locator('[name="name"]').fill(name); await expect(form.locator('[data-scope-origin]')).toHaveText('Generated');
        // The decision just created changes root revision, so refresh without losing the live draft.
        await click(page.locator('[data-service-cancel]')); await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        await click(page.locator('[data-service-new]')); await expect(form.locator('[name="name"]')).toHaveValue(name);
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        const created = fixture.store.getAll('HealthcareService').find(service => service.name === name);
        expect(created.providedBy).toBeUndefined(); expect(instances()).toEqual(before);
        await click(form.getByRole('link', { name: 'Refresh Services', exact: true }));
        // Results refresh retains the dedicated form until Back is deliberately selected.
        await click(page.locator('[data-service-cancel]'));
        const row = page.locator(`[data-catalog-id="${created.id}"]`);
        await expect(row).toContainText('Pending approval'); await expect(row).toContainText('0 provider registrations');
        await click(row.locator('[data-service-expansion] > summary')); await expect(row.locator('[data-saved-scope]')).toHaveText(fixture.store.privateRecords.services.getDefinition(created.id).grant.scope);
        await expect(row).toContainText('Private authoring source: private-services');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const helpTarget = row.locator('[data-service-expansion] > summary');
        if (info.project.name.includes('mobile')) await helpTarget.tap(); else await helpTarget.focus();
        await expect(page.getByRole('tooltip')).toContainText('exact'); await page.keyboard.press('Escape');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        expect(instances()).toEqual(before);
        // Cancellation is side-effect free; accepted command locks until explicit readback.
        const events = fixture.events.length;
        page.once('dialog', dialog => dialog.dismiss()); await click(row.getByRole('button', { name: 'Approve', exact: true })); expect(fixture.events.length).toBe(events);
        for (const [label, state] of [['Approve', 'Active'], ['Disable', 'Disabled / frozen'], ['Enable', 'Active'], ['Disable', 'Disabled / frozen']]) {
            page.once('dialog', dialog => dialog.accept()); await click(row.getByRole('button', { name: label, exact: true }));
            await expect(row.locator('[data-service-result]')).toContainText('Sandbox change saved');
            await expect(row.getByRole('button', { name: label, exact: true })).toBeDisabled();
            await inspect(page, click, row); await expect(row).toContainText(state);
            expect(instances()).toEqual(before); expect(JSON.stringify(fixture.store.privateState.approvals)).toBe(approvals);
        }
        // Review drafts across both peer views and browser Back without applying provider actions.
        await click(page.locator('[data-service-new]')); await form.locator('[name="purpose"]').fill('Retained catalog draft'); await click(page.locator('[data-service-cancel]'));
        await click(page.locator('[data-service-peer="assignments"]')); await expect(page.locator('#services-view-heading')).toBeVisible();
        await page.goBack(); await expect(page.locator('#catalog-heading')).toBeVisible();
        await click(page.locator('[data-service-new]')); await expect(form.locator('[name="purpose"]')).toHaveValue('Retained catalog draft'); await click(page.locator('[data-service-cancel]'));
        for (const width of info.project.name.includes('mobile') ? [390, 320] : [1440, 1024]) {
            await page.setViewportSize({ width, height: 1000 }); await row.scrollIntoViewIfNeeded();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`catalog-${width}.png`), fullPage: true });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('catalog-200-percent.png'), fullPage: true }); await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        await click(row.locator('[data-catalog-overflow] > summary')); page.once('dialog', dialog => dialog.accept()); await click(row.getByRole('button', { name: 'Delete definition', exact: true }));
        await expect(row.locator('[data-service-result]')).toContainText('Deleted from this runtime'); await inspect(page, click, row); await expect(row).toHaveCount(0);
        expect(instances()).toEqual(before); expect(JSON.stringify(fixture.store.privateState.approvals)).toBe(approvals); expect(fixture.store.privateRecords.approvals.getDecision(frozen.id).snapshot).toBeTruthy();
        expect(fixture.events.filter(event => event.target === `HealthcareService/${created.id}` && ['admin-catalog-create', 'admin-service-command'].includes(event.operation)).every(event => event.visibility === 'diagnostic')).toBe(true);
        expect(errors).toEqual([]); fs.writeFileSync(info.outputPath('traffic-and-audit.json'), JSON.stringify({ traffic, requests: fixture.requests, events: fixture.events.filter(event => event.target === `HealthcareService/${created.id}`) }, null, 2));
    } finally { await context.close(); }
});

test('CATALOG error, stale and uncertain mutation results require inspection and never replay; stale page loads preserve view', async ({ browser }, info) => {
    const { page, context, click, errors } = await open(browser, info);
    try {
        const model = require(path.join(root, 'src/pcm-core/src/services-admin-model'));
        const definition = require(path.join(root, 'src/pcm-core/src/service-templates')).loadTemplates()[0].definition;
        const created = model.createCatalog({ store: fixture.store, config: fixture.config, definition: { ...definition, name: `Failure guards ${info.project.name}` }, expectedRevision: fixture.store.privateState.revision, operator: 'browser-unit', audit: event => fixture.events.push(event) });
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        const row = page.locator(`[data-catalog-id="${created.id}"]`), action = row.getByRole('button', { name: 'Approve', exact: true });
        let posts = 0; await page.route(`**/admin/services/${created.id}/sandbox`, route => { posts++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Owned unavailable result' }) }); });
        page.once('dialog', dialog => dialog.accept()); await click(action); await expect(row.locator('[data-service-result]')).toContainText('uncertain'); await expect(action).toBeDisabled(); expect(posts).toBe(1);
        await page.route(/\/admin\/services(?:\?.*)?$/, route => route.abort()); await click(row.getByRole('link', { name: 'Refresh Services' })); await expect(page.locator('[data-services-loading]')).toContainText('Stale results'); await expect(action).toBeDisabled(); expect(posts).toBe(1);
        await page.unroute(/\/admin\/services(?:\?.*)?$/); await page.unroute(`**/admin/services/${created.id}/sandbox`);
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        // Real concurrent change refuses the displayed stale version before writing.
        const current = fixture.store.get('HealthcareService', created.id); fixture.store.update({ ...current, extraDetails: 'Concurrent exact-version change' });
        page.once('dialog', dialog => dialog.accept()); await click(action); await expect(row.locator('[data-service-result]')).toContainText('service changed'); await expect(action).toBeDisabled();
        await inspect(page, click, row); await expect(row).toContainText('Concurrent exact-version change');
        let received = false, release; const held = new Promise(resolve => { release = resolve; });
        await page.route(`**/admin/services/${created.id}/sandbox`, async route => { posts++; const response = await route.fetch(); received = true; await held; await route.abort().catch(() => {}); }, { times: 1 });
        page.once('dialog', dialog => dialog.accept()); await click(action); await expect.poll(() => received).toBe(true);
        await expect(action).toBeDisabled(); release(); await expect(row.locator('[data-service-result]')).toContainText('uncertain'); await expect(action).toBeDisabled(); expect(posts).toBe(2);
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden(); await expect(row).toContainText('Active');
        expect(fixture.events.filter(event => event.target === `HealthcareService/${created.id}` && event.operation === 'admin-service-command' && event.action === 'activate')).toHaveLength(1);
        // Ordinary discovery still omits a second unapproved catalog; private authoring never enters public FHIR.
        const pending = model.createCatalog({ store: fixture.store, config: fixture.config, definition: { ...definition, name: `Hidden pending ${info.project.name}` }, expectedRevision: fixture.store.privateState.revision, operator: 'browser-unit', audit() {} });
        const client = await require(path.join(root, 'src/pcm-core/src/provider-management-client')).providerManagementClient({ config: fixture.config, providerRole: 'serviceProvider', tokenStore: fixture.tokens, store: fixture.store });
        await expect(client.read(pending.id)).rejects.toMatchObject({ status: 404 });
        const publicRead = await client.read(created.id); require(path.join(root, 'src/pcm-core/src/public-fhir')).assertPublic(publicRead); expect(JSON.stringify(publicRead)).not.toContain('pcm-service-grant/1');
        expect(errors).toEqual([]);
    } finally { await context.close(); }
});
