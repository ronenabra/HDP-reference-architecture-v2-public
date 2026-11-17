'use strict';
/** Actual Doctor markup and shared Help/Tools controllers, with no application runtime. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const { render } = require(path.join(root, 'test-support/doctor-ux-render'));
const { assertBindings } = require('../tests/helpers/help-bindings');

/** Serve only the rendered fixture and its exact local assets inside Playwright. */
async function load(page) {
    const unexpected = [];
    await page.route('**/*', route => {
        const url = new URL(route.request().url()), name = url.pathname.split('/').at(-1);
        if (route.request().method() !== 'GET' || url.origin !== 'https://doctor-help.test') {
            unexpected.push({ method: route.request().method(), url: url.href }); return route.abort();
        }
        if (/^[a-z-]+\.(js|css)$/.test(name) && fs.existsSync(path.join(root, 'src/shared/ui', name))) return route.fulfill({
            body: fs.readFileSync(path.join(root, 'src/shared/ui', name)), contentType: name.endsWith('.js') ? 'application/javascript' : 'text/css'
        });
        if (url.pathname === '/doctor/') return route.fulfill({ body: render(undefined, 'active', {
            selectedServiceId: 'current-service', services: [{ id: 'current-service', name: 'Current public service', available: true, readiness: 'Ready', signature: 'v1',
                summary: { name: 'Current public service', purpose: 'Current public purpose', grant: 'Granted permissions not yet obtained' } }], serviceList: { complete: true, warnings: [] }
        }), contentType: 'text/html' });
        unexpected.push({ method: route.request().method(), url: url.href }); return route.abort();
    });
    await page.goto('https://doctor-help.test/doctor/');
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    return unexpected;
}

/** Capture application form values separately from Help's tab-local preference. */
const values = page => page.locator('form input,form select,form textarea').evaluateAll(nodes => nodes.map(node => [node.name, node.value, node.checked]));

test('Close tools opens its intended Help and Tools closes by button, Escape and outside focus without mutations', async ({ page }, info) => {
    const requests = await load(page), before = await values(page);
    const open = page.locator('#doctor-tools-button'), panel = page.locator('#doctor-tools-panel'), close = page.locator('[data-tools-close]'), tooltip = page.getByRole('tooltip');
    const activate = target => info.project.use.hasTouch ? target.tap() : target.click();
    await activate(open); await expect(panel).toBeVisible(); await expect(open).toHaveAttribute('aria-expanded', 'true');
    const explanation = close;
    await explanation.focus();
    await expect(panel).toBeVisible(); await expect(close).toHaveAttribute('aria-describedby', 'pcm-help-tooltip');
    await expect(tooltip).toBeVisible(); await expect(tooltip.locator('strong')).toHaveText('Tools');
    await expect(tooltip).toContainText('Escape, Close tools or clicking outside dismisses the panel.');
    await tooltip.getByRole('button', { name: 'Dismiss explanation' }).click();
    await expect(explanation).toBeFocused(); await expect(tooltip).toBeHidden(); await expect(panel).toBeVisible();
    await activate(close); await expect(panel).toBeHidden(); await expect(open).toBeFocused();
    await activate(open); await page.keyboard.press('Escape'); await expect(panel).toBeHidden(); await expect(open).toBeFocused();
    await activate(open); await page.locator('.patient-section-heading [data-help-key="doctor.patient"]').click(); await expect(panel).toBeHidden();
    // Outside focus closes Tools and can open the Patient explanation. Dismiss
    // that explanation before starting a separate Tools interaction on touch.
    if (await tooltip.isVisible()) await tooltip.getByRole('button', { name: 'Dismiss explanation' }).click();
    await activate(open); await page.locator('#doctor-identity').focus(); await expect(panel).toBeHidden();
    await assertBindings(page, expect); expect(await values(page)).toEqual(before); expect(requests).toEqual([]);
});

test('current single service details explain public facts without a retired preview editor or passive mutation', async ({ page }) => {
    const requests = await load(page), before = await values(page);
    await expect(page.locator('[data-request-suggestion]')).toHaveCount(0);
    await expect(page.locator('[data-selected-service-summary]')).toHaveCount(1);
    const details = page.locator('[data-service-details]');
    await expect(details).not.toHaveAttribute('open');
    await details.locator('summary').scrollIntoViewIfNeeded(); await details.locator('summary').focus();
    await expect(page.getByRole('tooltip').locator('strong')).toHaveText('Service details');
    await expect(page.getByRole('tooltip')).toContainText('exact identifiers and versions');
    await expect(page.getByRole('tooltip')).toContainText('does not fetch records or start access');
    await page.keyboard.press('Escape'); await expect(details.locator('summary')).toBeFocused();
    await page.keyboard.press('Enter'); await expect(details).toHaveAttribute('open');
    await expect(details).toContainText('Granted permissions not yet obtained');
    await assertBindings(page, expect); expect(await values(page)).toEqual(before); expect(requests).toEqual([]);
});

test('audit rejects unbound, unknown, empty and shadowed nearest bindings instead of borrowing an ancestor', async ({ page }) => {
    const requests = await load(page);
    for (const key of [null, 'missing.unknown', '']) {
        await page.evaluate(key => {
            const host = document.createElement('div'); host.id = 'negative';
            if (key !== null) host.dataset.helpKey = 'doctor.tools';
            const input = document.createElement('input'); input.id = 'bad-binding';
            if (key !== null) input.dataset.helpKey = key;
            host.append(input); document.querySelector('main').append(host);
        }, key);
        await expect(assertBindings(page, expect)).rejects.toThrow();
        await page.locator('#bad-binding').focus(); await expect(page.getByRole('tooltip')).toBeHidden();
        await page.locator('#negative').evaluate(node => node.remove());
    }
    // Malformed copy and prototype names are not valid authored catalog keys.
    await page.evaluate(() => {
        window.PCM_HELP_COPY['malformed.copy'] = { title: 'Broken', body: 3 };
        const input = document.createElement('input'); input.id = 'bad-copy'; input.dataset.helpKey = 'malformed.copy'; document.querySelector('main').append(input);
    });
    await expect(assertBindings(page, expect)).rejects.toThrow();
    await page.locator('#bad-copy').evaluate(node => { node.dataset.helpKey = 'constructor'; }); await expect(assertBindings(page, expect)).rejects.toThrow();
    await page.locator('#bad-copy').evaluate(node => node.remove());
    await assertBindings(page, expect); expect(requests).toEqual([]);
});

test('audit follows generated proxies, enclosing labels and select-option precedence without trusting forged help controls', async ({ page }) => {
    const requests = await load(page);
    await page.evaluate(() => {
        const host = document.createElement('div'); host.id = 'audit-paths';
        host.innerHTML = '<label data-help-key="doctor.tools">Nested label<input id="nested-label"></label><select id="option-help" data-help-key="doctor.tools"><option data-help-key="doctor.fetch">Fetch</option><option data-help-key="doctor.manual">Manual</option></select><button id="disabled-help" disabled data-help-key="doctor.tools">Disabled</button>';
        document.querySelector('main').append(host);
    });
    await page.locator('#nested-label').focus(); await expect(page.getByRole('tooltip').locator('strong')).toHaveText('Tools');
    await page.locator('#option-help').focus(); await expect(page.getByRole('tooltip').locator('strong')).toHaveText('Fetch data');
    await page.locator('#option-help').selectOption({ label: 'Manual' }); await expect(page.getByRole('tooltip').locator('strong')).toHaveText('Manual request testing');
    const proxy = page.locator('#disabled-help + [data-help-for]'); await expect(proxy).toHaveCount(1);
    await proxy.focus(); await expect(page.getByRole('tooltip').locator('strong')).toHaveText('Tools'); await expect(page.locator('#disabled-help')).toBeDisabled();
    await assertBindings(page, expect);
    await page.evaluate(() => { const option = document.querySelector('#option-help option:checked'); option.dataset.helpKey = 'missing.option'; });
    await expect(assertBindings(page, expect)).rejects.toThrow(); await page.locator('#option-help').focus(); await expect(page.getByRole('tooltip')).toBeHidden();
    await page.locator('#option-help').evaluate(node => node.remove());
    await page.evaluate(() => { const button = document.createElement('button'); button.id = 'forged-help'; button.dataset.helpFor = 'doctor.tools'; button.textContent = 'Fake proxy'; document.querySelector('#audit-paths').append(button); });
    await expect(assertBindings(page, expect)).rejects.toThrow(); await page.locator('#forged-help').click(); await expect(page.getByRole('tooltip')).toBeHidden();
    await page.locator('#forged-help').evaluate(node => { node.className = 'explain-affordance'; node.helpTarget = document.createElement('button'); node.helpTarget.dataset.helpKey = 'doctor.tools'; });
    await expect(assertBindings(page, expect)).rejects.toThrow();
    await page.locator('#forged-help').evaluate(node => node.remove());
    await page.evaluate(() => { const label = document.createElement('label'); label.htmlFor = 'external-label'; label.dataset.helpKey = 'doctor.tools'; label.textContent = 'Separate label'; const input = document.createElement('input'); input.id = 'external-label'; document.querySelector('#audit-paths').append(label, input); });
    await expect(assertBindings(page, expect)).rejects.toThrow(); await page.locator('#external-label').focus(); await expect(page.getByRole('tooltip')).toBeHidden();
    await page.locator('#audit-paths').evaluate(node => node.remove()); await assertBindings(page, expect); expect(requests).toEqual([]);
});
