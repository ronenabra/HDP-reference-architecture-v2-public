'use strict';
/** Fixed classification and generated confidentiality on the dedicated catalog authoring path. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture(); });
test.afterAll(async () => { await fixture?.close(); });

test('POLICY fixed Patient, classification and default R/V policy survive catalog creation with reachable help @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport: { width: mobile ? 390 : 1440, height: 1000 } });
    const page = await context.newPage();
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const click = target => mobile ? target.tap() : target.click();
    try {
        await page.goto(fixture.base + '/admin/services'); await click(page.locator('[data-service-new]'));
        const form = page.locator('[data-service-create]');
        await click(form.getByText('Service classification and type', { exact: true }));
        await expect(form).toContainText('Fixed service classification: Hospital (35)'); await expect(form).toContainText('INFA (information access)');
        await form.locator('[name="name"]').fill(`Owned policy ${info.project.name}`); await form.locator('[name="purpose"]').fill('Fixed classification and generated confidentiality');
        await form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]').check();
        const patient = form.locator('[data-permission-type="Patient"]'); await expect(patient).toContainText('Read and search included (patient/Patient.rs)'); await expect(patient.locator('input')).toHaveCount(0);
        await expect(form.locator('[data-scope-origin]')).toHaveText('Generated');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        for (const [target, text] of [[form.locator('summary[data-help-key="services.category"]'), 'administrative'], [form.locator('label[data-help-key="services.confidentiality"]'), 'Very Restricted (V) remains excluded'], [patient, 'Patient read and search']]) {
            const proxy = target.locator('xpath=following-sibling::button[@data-help-for][1]');
            if (await proxy.count()) { if (mobile) await proxy.tap(); else await proxy.focus(); } else await target.focus();
            await expect(page.getByRole('tooltip')).toContainText(text); await page.keyboard.press('Escape');
        }
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        const exact = await form.locator('[name="approvalScope"]').inputValue();
        expect(exact).toContain('Confidentiality|R'); expect(exact).toContain('Confidentiality|V');
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        const catalog = fixture.store.getAll('HealthcareService').find(service => service.name === `Owned policy ${info.project.name}`);
        expect(catalog.providedBy).toBeUndefined(); expect(catalog.category[0].coding[0].code).toBe('35'); expect(catalog.type[0].coding[0].code).toBe('INFA');
        const definition = fixture.store.privateRecords.services.getDefinition(catalog.id);
        expect(definition.confidentialityPolicy).toEqual({ allowRestricted: false }); expect(definition.grant.scope).toBe(exact);
        await page.screenshot({ path: info.outputPath('fixed-policy-readback.png'), fullPage: false });
    } finally { await context.close(); }
});
