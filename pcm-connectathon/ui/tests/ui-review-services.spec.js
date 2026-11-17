'use strict';
/** R6 actual authoring, pending-save and exact-provider journeys use owned server fixtures. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/r6' }); });
test.afterAll(async () => { await fixture?.close(); });
/** Preserve native touch while exercising the mounted application and original HTTP commands. */
async function open(browser, info) {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport: { width: mobile ? 390 : 1440, height: 1000 } });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base + '/admin/services?providerRole=hospitalBServiceProvider');
    return { page, context, errors, click: target => mobile ? target.tap() : target.click(), form: page.locator('[data-service-create]') };
}
/** Change the real browser viewport and inspect horizontal containment plus the reserved Explain row. */
async function capture(page, info, state) {
    for (const width of info.project.name.includes('mobile') ? [390, 320] : [1440, 1024]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: info.outputPath(`${state}-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: info.project.name.includes('mobile') ? 320 : 720, height: 500 });
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${state}-zoom200.png`), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
}

test('R6 blank and template defaults preserve explicit and overlapping choices; browsing keeps old bytes', async ({ browser }, info) => {
    const { page, context, click, form, errors } = await open(browser, info);
    try {
        const before = JSON.stringify({ services: fixture.store.getAll('HealthcareService'), consents: fixture.store.getAll('Consent') });
        await expect(page.locator('[data-service-peer="catalog"]')).toHaveAttribute('aria-current', 'page');
        await capture(page, info, 'catalog');
        await click(page.locator('[data-service-new]'));
        await expect(form.locator('[name="includeMasterData"]')).toBeChecked();
        await form.locator('[name="name"]').fill('R6 default draft'); await form.locator('[name="purpose"]').fill('Review finite access');
        await click(form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]'));
        const observation = form.locator('[data-permission-type="Observation"]');
        await expect(observation.locator('[value="r"]')).toBeChecked(); await expect(observation.locator('[value="s"]')).toBeChecked();
        await click(observation.locator('[value="r"]')); await click(observation.locator('[value="s"]'));
        // The two maintained allergy bucket aliases share AllergyIntolerance.
        await click(form.locator('[data-service-bucket="allergiesAndIntolerances"] [name="enabled"]'));
        const allergy = form.locator('[data-permission-type="AllergyIntolerance"]');
        await expect(allergy.locator('[value="r"]')).toBeChecked(); await expect(allergy.locator('[value="s"]')).toBeChecked();
        await click(allergy.locator('[value="r"]'));
        await click(form.locator('[data-service-bucket="allergies"] [name="enabled"]'));
        await expect(allergy.locator('[value="r"]')).not.toBeChecked(); await expect(allergy.locator('[value="s"]')).toBeChecked();
        await click(form.locator('[data-service-bucket="allergiesAndIntolerances"] [name="enabled"]'));
        await expect(allergy.locator('[value="r"]')).not.toBeChecked(); await expect(allergy.locator('[value="s"]')).toBeChecked();
        await expect(observation.locator('[value="r"]')).not.toBeChecked(); await expect(observation.locator('[value="s"]')).not.toBeChecked();
        await click(form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]'));
        await click(form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]'));
        await expect(observation.locator('[value="r"]')).not.toBeChecked();
        await click(form.locator('[name="includeMasterData"]'));
        await click(page.locator('[data-service-cancel]')); await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('[data-services-loading]')).toBeHidden(); await click(page.locator('[data-service-new]'));
        await expect(form.locator('[name="includeMasterData"]')).not.toBeChecked();
        page.once('dialog', dialog => dialog.accept()); await click(form.locator('[data-service-template-pick]').first());
        const value = JSON.parse(await form.locator('[data-service-template-pick]').first().getAttribute('data-template-values'));
        await expect(form.locator('[name="includeMasterData"]')).toBeChecked({ checked: value.includeMasterData === true });
        for (const permission of value.permissions.filter(row => row.type !== 'Patient')) for (const action of ['r','s']) await expect(form.locator(`[data-permission-type="${permission.type}"] [value="${action}"]`)).toBeChecked({ checked: permission.actions.includes(action) });
        page.once('dialog', dialog => dialog.accept()); await click(form.getByRole('button', { name: 'Blank', exact: true }));
        await form.locator('[name="name"]').fill('Laboratory results'); await form.locator('[name="purpose"]').fill('Read laboratory test results');
        await click(form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]'));
        await expect(form.locator('[name="includeMasterData"]')).toBeChecked();
        await form.locator('[data-service-bucket] details').first().evaluate(node => { node.open = true; });
        await expect(form.getByText('Exact sensitive-category codes', { exact: true })).toHaveCount(0);
        for (const input of await form.locator('[data-service-bucket]').first().locator('[name="sensitivity"]').all()) expect(await input.locator('..').textContent()).toContain((await input.inputValue()).split('|')[1]);
        const purposeBox = await form.locator('[name="purpose"]').boundingBox();
        await click(page.getByRole('checkbox', { name: 'Explain this page' }));
        expect(await form.locator('[name="purpose"]').boundingBox()).toEqual(purposeBox);
        await click(page.getByRole('checkbox', { name: 'Explain this page' }));
        await capture(page, info, 'create');
        expect(JSON.stringify({ services: fixture.store.getAll('HealthcareService'), consents: fixture.store.getAll('Consent') })).toBe(before);
        expect(errors).toEqual([]);
    } finally { await context.close(); }
});

test('R2 delayed success locks fields and failed save retains protected draft through template discard', async ({ browser }, info) => {
    const { page, context, click, form, errors } = await open(browser, info);
    try {
        await click(page.locator('[data-service-new]'));
        await click(form.locator('[data-service-template-pick]').first());
        await form.locator('[name="name"]').fill('R2 submitted ' + info.project.name);
        await expect(form.locator('[data-scope-origin]')).toHaveText('Generated');
        let release, reached;
        const pending = new Promise(resolve => { reached = resolve; });
        await page.route('**/admin/services/catalog', async route => { reached(); await new Promise(resolve => { release = resolve; }); await route.continue(); });
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await pending;
        await expect(form.locator('[name="name"]')).toBeDisabled(); await expect(form.locator('[name="includeMasterData"]')).toBeDisabled();
        await expect(form.getByRole('button', { name: 'Blank', exact: true })).toBeDisabled();
        await click(page.getByRole('checkbox', { name: 'Explain this page' }));
        await form.locator('[name="name"]').scrollIntoViewIfNeeded();
        if (info.project.name.includes('mobile')) { const box = await form.locator('[name="name"]').boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); } else await form.locator('[name="name"]').hover();
        await expect(page.getByRole('tooltip')).toBeVisible(); await page.keyboard.press('Escape');
        const before = await form.locator('[name="name"]').inputValue();
        await form.locator('[name="name"]').evaluate(node => { node.focus(); }); await page.keyboard.type('Unsubmitted');
        await expect(form.locator('[name="name"]')).toHaveValue(before);
        await click(page.getByRole('checkbox', { name: 'Explain this page' }));
        release(); await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        await expect(form.locator('[name="name"]')).toBeEnabled();
        expect(fixture.store.getAll('HealthcareService').filter(row => row.name === before)).toHaveLength(1);
        await form.locator('[name="name"]').fill('R2 newer unsaved edit');
        await click(page.locator('[data-service-cancel]')); await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('[data-services-loading]')).toBeHidden(); await click(page.locator('[data-service-new]'));
        page.once('dialog', dialog => dialog.dismiss()); await click(form.getByRole('button', { name: 'Blank', exact: true }));
        await expect(form.locator('[name="name"]')).toHaveValue('R2 newer unsaved edit');
        await page.unroute('**/admin/services/catalog');
        await page.route('**/admin/services/catalog', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Owned invalid save' }) }));
        await expect(form.locator('[data-scope-origin]')).toHaveText('Generated'); await click(form.getByRole('button', { name: 'Create service', exact: true }));
        await expect(form.locator('[data-service-result]')).toContainText('Owned invalid save'); await expect(form.locator('[name="name"]')).toBeEnabled();
        page.once('dialog', dialog => dialog.dismiss()); await click(form.locator('[data-service-template-pick]').last());
        await expect(form.locator('[name="name"]')).toHaveValue('R2 newer unsaved edit');
        page.once('dialog', dialog => dialog.accept()); await click(form.getByRole('button', { name: 'Blank', exact: true }));
        await expect(form.locator('[name="name"]')).toHaveValue(''); await expect(form.locator('[name="includeMasterData"]')).toBeChecked();
        expect(errors).toEqual([]);
    } finally { await context.close(); }
});

test('R6 provider filter retains context and actions still target the exact provider', async ({ browser }, info) => {
    const setup = require(path.join(root, 'test-support/services-list-fixture')).installServicesListFixture(fixture);
    const { page, context, click, errors } = await open(browser, info);
    try {
        await click(page.locator('[data-service-peer="assignments"]'));
        const provider = fixture.config.organizations.hospitalBServiceProvider.id;
        await page.locator('[data-provider-filter]').selectOption(provider);
        for (const pair of await page.locator('[data-provider-pair]:visible').all()) expect(await pair.getAttribute('data-provider-pair')).toBe(provider);
        await expect(page.locator('[data-service-count]')).toContainText('loaded assignment rows');
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        await expect(page.locator('[data-provider-filter]')).toHaveValue(provider);
        expect(new URL(page.url()).searchParams.get('providerRole')).toBe('hospitalBServiceProvider');
        const registration = setup.registrationsB[0], row = page.locator(`[data-service-id="${registration.id}"]`);
        await row.locator('[data-service-status-form]').getByRole('button', { name: 'Pause', exact: true }).scrollIntoViewIfNeeded();
        page.once('dialog', dialog => dialog.accept()); await click(row.locator('[data-service-status-form]').getByRole('button', { name: 'Pause', exact: true }));
        await expect(page.locator(`[data-service-id="${registration.id}"]`)).toContainText('Paused');
        const changed = fixture.store.get('HealthcareService', registration.id);
        expect(require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle')).ownerId(changed)).toBe(provider);
        expect(require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle')).businessStatus(fixture.store.get('HealthcareService', setup.registrationsA[0].id))).toBe('active');
        await capture(page, info, 'assignments');
        expect(errors).toEqual([]);
    } finally { await context.close(); setup.restore(); }
});
