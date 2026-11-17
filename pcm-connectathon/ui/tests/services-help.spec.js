'use strict';
/** HELP audit of mounted real Services EJS, ordinary results and current local controller. */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/owned/help' }); });
test.afterAll(async () => { await fixture?.close(); });

/** Only actual mutating service commands count; signed read-only preview is a separate boundary. */
const writes = request => request.method() === 'POST' && /\/admin\/services\/(?:catalog|create|assign|[^/]+\/(?:status|sandbox))$/.test(new URL(request.url()).pathname);

/** Assert the current long popup and sticky close both fit the visual viewport. */
async function contained(page) {
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByRole('button', { name: 'Dismiss explanation' })).toBeInViewport({ ratio: 1 });
    const box = await tooltip.boundingBox(), viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('HELP mounted Services audits live fields, result rows, disabled reasons and no mutations @smoke', async ({ browser }, info) => {
    test.setTimeout(120000);
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), mutations = [], errors = [], coverage = [];
    page.on('request', request => { if (writes(request)) mutations.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(fixture.base + '/admin/services');
        await expect(page.getByRole('checkbox', { name: 'Explain this page' })).not.toBeChecked();
        await expect(page.locator('[data-help-for]')).toHaveCount(0);
        await page.locator('[data-service-new]').click();
        const form = page.locator('[data-service-create]');
        await form.locator('[name="name"]').fill('HELP long name ' + 'readable service '.repeat(25));
        await form.locator('[name="purpose"]').fill('Owned HELP audit, no create or lifecycle commands');
        await form.locator('[data-service-bucket="laboratoryTests"] [name="enabled"]').check();
        await form.locator('[name="purpose"]').press('Tab');
        await expect(form.locator('[data-preview-status]')).toContainText('Generated at');
        // Disclosure-only changes reveal all authored states without executing a command.
        await page.locator('details').evaluateAll(nodes => { for (const node of nodes) node.open = true; });
        const missing = await page.locator('a,button,input:not([type="hidden"]),select,textarea,summary').evaluateAll(nodes => nodes.filter(node =>
            !node.dataset.helpKey && !node.closest('label[data-help-key]') && !node.closest('[data-help-key]')
        ).map(node => ({ tag: node.tagName, name: node.name, text: node.textContent.slice(0, 50) })));
        expect(missing).toEqual([]);
        const values = () => form.locator('input,select,textarea').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked]));
        const before = await values();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const keys = [...new Set(await page.locator('[data-help-key]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.helpKey)))];
        for (const key of keys) {
            const target = page.locator(`[data-help-key="${key}"]:visible`).first();
            await target.scrollIntoViewIfNeeded();
            await page.evaluate(() => document.activeElement.blur());
            const proxy = target.locator('xpath=following-sibling::button[@data-help-for][1]');
            if (await proxy.count() && await proxy.getAttribute('data-help-for') === key) {
                await proxy.focus();
            } else if (key === 'common.explain') await target.locator('input').focus();
            else await target.focus();
            await contained(page);
            await expect(page.getByRole('tooltip')).toContainText(await page.evaluate(key => window.PCM_HELP_COPY[key].title, key));
            coverage.push(key); await page.keyboard.press('Escape');
        }
        expect(coverage).toEqual(expect.arrayContaining(['services.patient-changes', 'services.history', 'services.sensitivity', 'services.scope', 'services.preview', 'services.templates']));
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.locator('[data-service-cancel]').click();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const disabled = page.locator('[data-service-sandbox] button:disabled').first();
        await disabled.scrollIntoViewIfNeeded();
        const disabledHelp = disabled.locator('xpath=following-sibling::button[@data-help-for][1]');
        await page.evaluate(() => document.activeElement.blur());
        if (mobile) { const box = await disabled.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); } else await disabledHelp.focus();
        await contained(page); await expect(disabled).toBeDisabled();
        await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        await expect(mobile ? page.getByRole('checkbox', { name: 'Explain this page' }) : disabledHelp).toBeFocused();
        expect(await values()).toEqual(before); expect(mutations).toEqual([]);
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.locator('[data-service-new]').click();
        const audit = await new AxeBuilder({ page }).analyze();
        expect(audit.violations).toEqual([]);
        await page.evaluate(() => document.body.style.zoom = '200%');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const label = form.locator('label[for="service-name"]'); await label.scrollIntoViewIfNeeded(); await label.focus();
        await contained(page); await page.screenshot({ path: info.outputPath('long-help-200-percent.png'), fullPage: false }); await page.keyboard.press('Escape');
        await page.evaluate(() => document.body.style.zoom = '100%');
        // Normal next-field editing remains usable with Explain enabled.
        await form.locator('[name="name"]').fill('HELP ordinary input after help');
        await form.locator('[name="purpose"]').fill('Normal next input remains reachable');
        await expect(form.locator('[name="purpose"]')).toHaveValue('Normal next input remains reachable');
        await page.keyboard.press('Escape');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await expect(page.locator('[data-help-for]')).toHaveCount(0);
        fs.writeFileSync(info.outputPath('help-audit.json'), JSON.stringify({ mobile, mountedBase: '/owned/help', keys: coverage, mutations, errors, axeViolations: audit.violations }, null, 2));
        expect(errors).toEqual([]);
    } finally { await context.close(); }
});

/** An attempted write is explicit; subsequent disabled help cannot replay it. */
test('HELP Create help stays reachable after an uncertain submit without another request @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), attempts = [];
    page.on('request', request => { if (writes(request)) attempts.push(new URL(request.url()).pathname); });
    const click = async target => mobile ? target.tap() : target.click();
    try {
        await page.goto(fixture.base + '/admin/services');
        await click(page.locator('[data-service-new]'));
        await click(page.locator('[data-template-key="laboratory-follow-up"]'));
        const form = page.locator('[data-service-create]');
        await expect(form.locator('[data-preview-status]')).toContainText('Generated at');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const help = form.locator('[data-help-for="services.create"]');
        if (mobile) await page.locator('[data-service-panel] p[data-help-key="services.create"]').tap(); else await help.focus();
        await contained(page); await page.keyboard.press('Escape');
        expect(attempts).toEqual([]);
        await page.route('**/admin/services/catalog', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Owned uncertain fixture response' }) }));
        await click(form.getByRole('button', { name: 'Create service', exact: true }));
        await expect(form.locator('[data-service-result]')).toContainText('result may be uncertain');
        await expect(form.getByRole('button', { name: 'Create service', exact: true })).toBeDisabled();
        await expect(help).toBeEnabled();
        const values = await form.locator('input,select,textarea').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked]));
        if (mobile) { await form.getByRole('button', { name: 'Create service', exact: true }).scrollIntoViewIfNeeded(); const box = await form.getByRole('button', { name: 'Create service', exact: true }).boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); } else await help.focus();
        await contained(page); await expect(page.getByRole('tooltip')).toContainText('uncertain result');
        await page.getByRole('button', { name: 'Dismiss explanation' }).click(); await expect(mobile ? page.getByRole('checkbox', { name: 'Explain this page' }) : help).toBeFocused();
        expect(attempts).toHaveLength(1);
        expect(await form.locator('input,select,textarea').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked]))).toEqual(values);
        fs.writeFileSync(info.outputPath('locked-help.json'), JSON.stringify({ mobile, explicitAttempt: attempts, additionalHelpRequests: 0, protectedActionDisabled: true }, null, 2));
    } finally { await context.close(); }
});
