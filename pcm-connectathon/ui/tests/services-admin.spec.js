'use strict';
/** Contextual protected Admin actions preserve separate standard provider authority. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture(); });
test.afterAll(async () => { await fixture?.close(); });

/** Create an owned canonical/registration pair through the retained lifecycle. */
function pair(name, role = 'serviceProvider') {
    const request = structuredClone(require(path.join(root, 'src/pcm-core/src/service-templates')).loadTemplates()[0].request); request.name = name;
    return require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle')).registerHealthcareService({ store: fixture.store, callerOrganization: fixture.store.get('Organization', fixture.config.organizations[role].id), request });
}

/** Authenticate the same mounted page on desktop or a native touch context. */
async function open(browser, info) {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    return { context, page: await context.newPage(), click: locator => mobile ? locator.tap() : locator.click() };
}

test('ADMIN separate catalog approval and exact provider activation, orphan cleanup and Strict remain contextual @smoke', async ({ browser }, info) => {
    const { page, context, click } = await open(browser, info), created = pair(`ADMIN exact context ${info.project.name}`);
    try {
        await page.goto(`${fixture.base}/admin/services?view=assignments&target=${created.instance.id}`);
        const registration = page.locator(`[data-service-id="${created.instance.id}"]`); await click(registration.locator('[data-service-expansion] > summary'));
        await click(registration.locator('.services-admin-actions > summary'));
        await expect(registration.getByRole('button', { name: 'Activate', exact: true })).toBeDisabled();
        await expect(registration).toContainText('definition first');
        await click(page.locator(`[data-service-group="${created.canonical.id}"]`).getByRole('link', { name: 'Review catalog definition' }));
        const definition = page.locator(`[data-catalog-id="${created.canonical.id}"]`);
        await expect(definition).toContainText('Global actions affect all providers');
        page.once('dialog', dialog => dialog.accept()); await click(definition.getByRole('button', { name: 'Approve', exact: true }));
        await expect(definition.locator('[data-service-result]')).toContainText('Sandbox change saved');
        await click(page.locator('[data-service-peer="assignments"]')); await click(registration.locator('[data-service-expansion] > summary'));
        await click(registration.locator('.services-admin-actions > summary'));
        await expect(registration.getByRole('button', { name: 'Activate', exact: true })).toBeEnabled();
        page.once('dialog', dialog => dialog.accept()); await click(registration.getByRole('button', { name: 'Activate', exact: true }));
        await expect(registration.locator('[data-connection-result]')).toContainText('Sandbox change saved');
        const before = fixture.store.get('HealthcareService', created.instance.id);
        await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(registration).toContainText('Consent and source checks still apply');
        const orphan = pair(`ADMIN orphan ${info.project.name}`);
        await page.goto(`${fixture.base}/admin/services?view=assignments&target=${orphan.instance.id}`);
        const cleanup = page.locator(`[data-service-id="${orphan.instance.id}"]`); await click(cleanup.locator('[data-service-expansion] > summary')); await click(cleanup.getByText('Admin actions', { exact: true }));
        page.once('dialog', dialog => dialog.accept()); await click(cleanup.getByRole('button', { name: 'Delete registration', exact: true }));
        await expect(cleanup).toHaveCount(0);
        await page.goto(`${fixture.base}/admin/services?view=catalog&target=${orphan.canonical.id}`);
        const hidden = page.locator(`[data-catalog-id="${orphan.canonical.id}"]`); await expect(hidden).toContainText('0 provider registrations'); await expect(hidden.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
        await click(hidden.locator('[data-catalog-overflow] > summary')); page.once('dialog', dialog => dialog.accept()); await click(hidden.getByRole('button', { name: 'Delete definition', exact: true })); await expect(hidden.locator('[data-service-result]')).toContainText('Deleted from this runtime');
        expect(fixture.store.get('HealthcareService', created.instance.id)).toEqual(before);
        const policy = fixture.config.conformance;
        try {
            fixture.config.conformance = { ...policy, preset: 'strict' }; await page.goto(`${fixture.base}/admin/services`);
            await expect(page.locator('[data-services-fragment="catalog"]')).toContainText('unavailable in strict mode');
            for (const button of await page.locator('[data-service-sandbox] button').all()) await expect(button).toBeDisabled();
        } finally { fixture.config.conformance = policy; }
    } finally { await context.close(); }
});

test('ADMIN catalog has no acting provider and foreign standard actions remain bound to their exact owner @smoke', async ({ browser }, info) => {
    const { page, context, click } = await open(browser, info), foreign = pair(`Foreign ADMIN context ${info.project.name}`, 'hospitalBServiceProvider');
    try {
        await page.goto(`${fixture.base}/admin/services`); await expect(page.locator('#service-provider')).toBeHidden();
        await expect(page.locator(`[data-catalog-id="${foreign.canonical.id}"]`)).toBeVisible();
        await click(page.locator('[data-service-peer="assignments"]'));
        const row = page.locator(`[data-service-id="${foreign.instance.id}"]`);
        await expect(row.locator('[data-service-status-form]')).toHaveAttribute('data-provider-id', fixture.config.organizations.hospitalBServiceProvider.id);
        await expect(row.locator('[data-service-status-form]')).toHaveAttribute('data-provider-role', 'hospitalBServiceProvider');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await context.close(); }
});
