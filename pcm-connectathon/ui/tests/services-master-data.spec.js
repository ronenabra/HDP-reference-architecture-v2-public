'use strict';
/** Mounted actual desktop/native-touch authoring and canonical master metadata. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture(); });
test.afterAll(async () => { await fixture?.close(); });
test('MASTER explicit read-only checkbox and help persist through catalog definition @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const click = async target => mobile ? target.tap() : target.click();
    try {
        await page.goto(fixture.base + '/admin/services'); await click(page.locator('[data-service-new]'));
        const form = page.locator('[data-service-create]'), control = form.locator('[name="includeMasterData"]');
        await expect(control).toBeChecked();
        await form.getByLabel('Service name', { exact: true }).fill('Owned master ' + info.project.name);
        await form.getByLabel('Purpose', { exact: true }).fill('Finite direct logical-ID access');
        await click(form.locator('[data-service-bucket="laboratoryTests"] input[name="enabled"]'));
        await expect(control).toBeChecked();
        await expect(form.locator('[data-scope-origin]')).toHaveText('Generated');
        expect(await form.locator('[name="approvalScope"]').inputValue()).toContain('patient/Organization.r?');
        for (const type of ['Practitioner','PractitionerRole','Location']) expect(await form.locator('[name="approvalScope"]').inputValue()).toContain(`patient/${type}.r?`);
        await click(page.getByRole('checkbox', { name: 'Explain this page' }));
        const help = form.locator('label[data-help-key="services.master-data"]').locator('xpath=following-sibling::button[@data-help-for][1]');
        if (mobile) await form.locator('p[data-help-key="services.master-data"]').tap(); else await help.focus();
        await expect(page.getByRole('tooltip')).toContainText('outside the Patient compartment');
        await page.keyboard.press('Escape'); await click(page.getByRole('checkbox', { name: 'Explain this page' }));
        await expect(control).toBeChecked();
        await page.screenshot({ path: info.outputPath('master-setting.png'), fullPage: true });
        await click(form.getByRole('button', { name: 'Create service', exact: true }));
        await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        const canonical = fixture.store.getAll('HealthcareService').find(x => x.name === 'Owned master ' + info.project.name);
        expect(canonical.providedBy).toBeUndefined(); expect(fixture.store.privateRecords.services.getDefinition(canonical.id).includeMasterData).toBe(true);
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    } finally { await context.close(); }
});
