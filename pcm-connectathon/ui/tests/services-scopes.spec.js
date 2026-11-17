'use strict';
/** Dedicated authoring form against real owned Admin/catalog stores, desktop and native touch. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/mounted' }); });
test.afterAll(async () => { await fixture?.close(); });

/** Open the existing mounted renderer and retain native touch rather than synthesized mouse clicks. */
async function open(browser, info) {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport: { width: mobile ? 390 : 1440, height: 1000 } });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.base + '/admin/services');
    const click = target => mobile ? target.tap() : target.click();
    await click(page.locator('[data-service-new]'));
    return { page, context, click, errors, form: page.locator('[data-service-create]') };
}

/** The complete editable field inventory and fixed server-owned classification. */
async function assertDraft(form, value) {
    for (const key of ['name', 'purpose', 'category', 'accessMode', 'duration', 'durationUnit']) await expect(form.locator(`[name="${key}"]`)).toHaveValue(String(value[key]));
    for (const key of ['allowChanges', 'includeMasterData']) await expect(form.locator(`[name="${key}"]`)).toBeChecked({ checked: value[key] === true });
    await expect(form.locator('[name="allowRestricted"]')).toBeChecked({ checked: value.confidentialityPolicy?.allowRestricted === true });
    for (const row of await form.locator('[data-service-bucket]').all()) {
        const code = await row.getAttribute('data-service-bucket'), choice = value.buckets.find(item => item.code === code);
        await expect(row.locator('[name="enabled"]')).toBeChecked({ checked: Boolean(choice) });
        if (!choice) continue;
        await expect(row.locator('[name="history"]')).toHaveValue(String(choice.history));
        await expect(row.locator('[name="historyUnit"]')).toHaveValue(choice.historyUnit);
        for (const tag of await row.locator('[name="sensitivity"]').all()) await expect(tag).toBeChecked({ checked: choice.sensitivity.includes(await tag.inputValue()) });
    }
    for (const permission of value.permissions.filter(item => item.type !== 'Patient')) {
        for (const action of ['r', 's']) await expect(form.locator(`[data-permission-type="${permission.type}"] input[value="${action}"]`)).toBeChecked({ checked: permission.actions.includes(action) });
    }
    expect(JSON.parse(await form.locator('[name="exampleQueries"]').inputValue())).toEqual(value.exampleQueries);
}

test('AUTHORING all templates and Blank are complete draft-only choices; dedicated form protects edits and responsive advanced controls', async ({ browser }, info) => {
    const { page, context, click, form, errors } = await open(browser, info);
    try {
        const templates = require(path.join(root, 'src/pcm-core/src/service-templates')).loadTemplates();
        const count = fixture.store.getAll('HealthcareService').length, requestCount = fixture.requests.length, tokenCount = fixture.tokens.size, consentCount = fixture.store.getAll('Consent').length;
        const mutations = () => fixture.requests.filter(row => row.method === 'POST' && !row.path.endsWith('/token')).length;
        const before = mutations();
        await expect(page.locator('[data-service-browse]')).toBeHidden(); await expect(form.locator('[name="approvalScope"]')).toBeVisible();
        await expect(form.locator('[data-service-template-pick]')).toHaveCount(5);
        for (const [index, template] of templates.entries()) {
            if (index) page.once('dialog', dialog => dialog.accept());
            await click(form.locator(`[data-template-key="${template.key}"]`));
            await assertDraft(form, { ...template.definition, exampleQueries: template.exampleQueries });
            await expect(form.locator(`[data-template-key="${template.key}"] strong`)).toHaveText(template.definition.name);
            await expect(form.locator(`[data-template-key="${template.key}"]`)).toHaveAttribute('aria-pressed', 'true');
            if (template.definition.scopeOrigin === 'custom') await expect(form.locator('[name="approvalScope"]')).toHaveValue(template.definition.approvalScope);
            else await expect(form.locator('[data-scope-origin]')).toHaveText('Generated');
        }
        expect(fixture.store.getAll('HealthcareService').length).toBe(count); expect(mutations()).toBe(before);
        expect(fixture.requests.length).toBe(requestCount); expect(fixture.tokens.size).toBe(tokenCount); expect(fixture.store.getAll('Consent').length).toBe(consentCount);
        const retained = await form.locator('[name="name"]').inputValue();
        page.once('dialog', dialog => dialog.dismiss()); await click(form.locator('[data-service-blank]')); await expect(form.locator('[name="name"]')).toHaveValue(retained);
        await click(page.locator('[data-service-cancel]')); await expect(page.locator('[data-service-new]')).toBeFocused();
        await click(page.locator('[data-service-new]')); await expect(form.locator('[name="name"]')).toHaveValue(retained);
        page.once('dialog', dialog => dialog.accept()); await click(form.locator('[data-service-blank]')); await expect(form.locator('[name="name"]')).toHaveValue('');
        await form.locator('[name="name"]').fill('Advanced complete field inventory'); await form.locator('[name="purpose"]').fill('Responsive editable draft');
        for (const row of await form.locator('[data-service-bucket]').all()) await row.locator('[name="enabled"]').check();
        await form.locator('[name="includeMasterData"]').check(); await form.locator('[name="allowRestricted"]').check();
        await form.locator('[name="allowChanges"]').check(); await click(form.getByText('Service classification and type', { exact: true }));
        await expect(form).toContainText('Fixed information-access type: INFA');
        await click(form.getByText('Illustrative query metadata', { exact: true }));
        const firstBucket = form.locator('[data-service-bucket]').first(); await click(firstBucket.getByText('Additional sensitive categories allowed (default: none)', { exact: true }));
        await expect(form.locator('[data-scope-origin]')).toHaveText('Generated');
        for (const width of info.project.name.includes('mobile') ? [390, 320] : [1440, 1024]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`complete-form-${width}.png`), fullPage: true });
            await form.locator('[name="approvalScope"]').scrollIntoViewIfNeeded();
            await page.screenshot({ path: info.outputPath(`scope-review-${width}.png`), fullPage: false });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('complete-form-200-percent.png'), fullPage: true });
        await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        expect(fixture.store.getAll('HealthcareService').length).toBe(count); expect(mutations()).toBe(before); expect(errors).toEqual([]);
        fixture.setTemplateLoader(() => { throw new Error('Owned unavailable template configuration'); });
        await page.goto(fixture.base + '/admin/services'); await click(page.locator('[data-service-new]'));
        await expect(form.locator('[data-service-template-pick]')).toHaveCount(0); await expect(form).toContainText('Templates unavailable');
        await form.locator('[name="name"]').fill(`No-template manual ${info.project.name}`); await form.locator('[name="purpose"]').fill('Manual creation remains available');
        await form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]').check();
        await form.locator('[name="approvalScope"]').fill('  unsupported experimental text\n  ');
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        fixture.setTemplateLoader(undefined);
        fs.writeFileSync(info.outputPath('template-field-inventory.json'), JSON.stringify({ templates: templates.map(item => item.key), bucketCodes: await form.locator('[data-service-bucket]').evaluateAll(rows => rows.map(row => row.dataset.serviceBucket)), fields: await form.locator('[name]').evaluateAll(fields => [...new Set(fields.map(field => field.name))]), unchangedResourceCount: count, mutations: mutations() - before }, null, 2));
    } finally { fixture.setTemplateLoader(undefined); await context.close(); }
});

test('AUTHORING generated/manual precedence, stale/error fences, passive preservation and exact catalog readback', async ({ browser }, info) => {
    const { page, context, click, form, errors } = await open(browser, info);
    try {
        const first = form.locator('[data-service-template-pick]').first(); await click(first);
        const editor = form.locator('[name="approvalScope"]'), origin = form.locator('[data-scope-origin]'), status = form.locator('[data-preview-status]');
        await expect(origin).toHaveText('Generated'); const originalInputs = await form.locator('[data-service-bucket],[data-permission-type]').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('input,select')].map(input => [input.name || input.value, input.value, input.checked])));
        const raw = '  patient/Encounter.s?unusual=שלום%ZZ&status=finished\n\tmalformed experimental text  ';
        await editor.fill(raw); await expect(origin).toHaveText('Manual override');
        await expect(editor).toHaveValue(raw);
        expect(await form.locator('[data-service-bucket],[data-permission-type]').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('input,select')].map(input => [input.name || input.value, input.value, input.checked])))).toEqual(originalInputs);
        await form.locator('[name="name"]').fill(`Exact manual ${info.project.name}`); await form.locator('[name="purpose"]').fill('Manual text must remain exact');
        await form.locator('[name="duration"]').fill('7'); await form.locator('[name="durationUnit"]').selectOption('wk'); await form.locator('[name="accessMode"]').selectOption('one-time');
        await click(form.getByText('Service classification and type', { exact: true })); await editor.focus();
        await expect(editor).toHaveValue(raw); await expect(origin).toHaveText('Manual override');
        await click(page.locator('[data-service-cancel]'));
        await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('[data-services-loading]')).toBeHidden();
        await click(page.locator('[data-service-new]'));
        await expect(editor).toHaveValue(raw); await expect(origin).toHaveText('Manual override');
        // Native focus/touch and ordinary keyboard Explain share the accepted controller.
        await page.getByRole('checkbox', { name: 'Explain this page' }).check(); await editor.focus();
        await expect(page.getByRole('tooltip')).toContainText('exact');
        await page.keyboard.press('Escape'); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        let confirmations = 0; page.on('dialog', async dialog => { confirmations++; await dialog.dismiss(); });
        const history = form.locator('[data-service-bucket="laboratoryTests"] [name="history"]');
        await history.fill('5'); await expect(origin).toHaveText('Generated'); await expect(editor).not.toHaveValue(raw); expect(confirmations).toBe(0);
        // Hold a server-calculated generated response while a newer manual input supersedes it.
        let received = false, release; const held = new Promise(resolve => { release = resolve; });
        await page.route('**/admin/services/preview', async route => { const response = await route.fetch(); received = true; await held; await route.fulfill({ response }).catch(() => {}); }, { times: 1 });
        await history.fill('4'); await expect.poll(() => received).toBe(true);
        await editor.fill(raw); await expect(origin).toHaveText('Manual override'); release(); await expect(status).toContainText('Exact manual text'); await expect(editor).toHaveValue(raw);
        await page.route('**/admin/services/preview', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Owned generation failure' }) }));
        await click(form.locator('[data-reset-scopes]')); await expect(status).toContainText('Generation unavailable'); await expect(editor).toHaveValue(raw);
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await expect(form.locator('[data-service-result]')).toContainText('Regenerate successfully');
        await editor.fill(raw); await expect(origin).toHaveText('Manual override'); await expect(status).toContainText('Syntax advice unavailable');
        // Advisory failure must not prevent exact manual save.
        const name = await form.locator('[name="name"]').inputValue(), before = fixture.store.getAll('HealthcareService').length;
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        const saved = fixture.store.getAll('HealthcareService').filter(service => service.name === name); expect(saved).toHaveLength(1); expect(saved[0].providedBy).toBeUndefined();
        const record = fixture.store.privateRecords.services.getDefinition(saved[0].id); expect(record.grant.scope).toBe(raw); expect(record.grant.authoring.approvalScope).toBe(raw); expect(record.grant.origin).toBe('custom');
        expect(fixture.store.getAll('HealthcareService').length).toBe(before + 1);
        await page.screenshot({ path: info.outputPath('manual-exact-save-readback.png'), fullPage: true });
        fs.writeFileSync(info.outputPath('exact-private-readback.json'), JSON.stringify(record, null, 2)); expect(errors).toEqual([]);
        await page.unroute('**/admin/services/preview');
        // A fresh generated definition saves exactly the reviewed text and clock.
        await page.goto(fixture.base + '/admin/services'); await click(page.locator('[data-service-new]')); await click(first);
        await form.locator('[name="name"]').fill(`Generated equality ${info.project.name}`); await expect(origin).toHaveText('Generated');
        const generated = await editor.inputValue(), reviewed = await status.innerText();
        await click(form.getByRole('button', { name: 'Create service', exact: true })); await expect(form.locator('[data-service-result]')).toContainText('Created pending definition');
        const generatedService = fixture.store.getAll('HealthcareService').find(service => service.name === `Generated equality ${info.project.name}`);
        const grant = fixture.store.privateRecords.services.getDefinition(generatedService.id).grant; expect(grant.scope).toBe(generated); expect(reviewed).toContain(grant.anchor);
        const beforeConnect = fixture.store.getAll('HealthcareService').length;
        await click(form.getByRole('link', { name: 'Connect providers', exact: true }));
        await expect(page.locator('[data-service-browse]')).toBeVisible();
        await expect(page.locator(`[data-service-group="${generatedService.id}"]`)).toContainText('Pending approval');
        expect(fixture.store.getAll('HealthcareService').length).toBe(beforeConnect);
    } finally { await context.close(); }
});
