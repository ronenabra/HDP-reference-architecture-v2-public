'use strict';
/** Exercise actual Doctor layout, patient state and contextual help without live writes. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.DOCTOR_UI_ROOT || path.resolve(__dirname, '../../..');
const { render } = require(path.join(root, 'test-support/doctor-ux-render'));

/** Fulfil the real page/assets and record selection saves, rejecting every other mutation. */
async function load(page, selectedPatientId = '', suppliedHtml = '') {
    const selections = [], unexpected = [];
    const html = suppliedHtml || render('empty', 'active', {
        selectedPatientId, selectedServiceId: 'review-service',
        serviceList: { complete: true, warnings: [] },
        services: [{ id: 'review-service', signature: 'review-v1', name: 'Review service', purpose: 'Synthetic review', available: true, readiness: 'Ready' }]
    });
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === 'https://doctor-ui.test' && url.pathname === '/doctor/selection' && request.method() === 'POST') {
            selections.push(request.postDataJSON());
            return route.fulfill({ json: { patient: { automaticTestApproval: false } } });
        }
        if (request.method() === 'GET' && url.origin === 'https://doctor-ui.test') {
            if (url.pathname === '/doctor/') return route.fulfill({ body: html, contentType: 'text/html' });
            const asset = path.basename(url.pathname);
            if (/^[a-z-]+\.(js|css)$/.test(asset) && fs.existsSync(path.join(root, 'src/shared/ui', asset))) {
                return route.fulfill({ body: fs.readFileSync(path.join(root, 'src/shared/ui', asset)), contentType: asset.endsWith('.js') ? 'application/javascript' : 'text/css' });
            }
        }
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.abort();
    });
    await page.goto('https://doctor-ui.test/doctor/');
    return { selections, unexpected };
}

/** Record page geometry independently of Help's generated accessibility controls. */
async function geometry(page) {
    return page.locator('#doctor-identity, [data-patient-mode], #configured-patient, #service-id, [data-request-consent]').evaluateAll(nodes => nodes.map(node => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { id: node.id || node.dataset.patientMode || 'submit', x, y, width, height };
    }));
}

test('Explain belongs in the header and uses icon-free reference help without moving controls', async ({ page }, info) => {
    const { selections, unexpected } = await load(page);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await expect(page.locator('.doctor-navigation .explain-toggle')).toBeVisible();
    const checkboxSize = await toggle.boundingBox();
    expect(checkboxSize.height).toBeLessThan(30);
    const sizes = info.project.name === 'mobile' ? [[390, 1], [320, 1]] : [[1440, 1], [1024, 1], [1440, 2]];
    for (const [width, zoom] of sizes) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
        await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        const before = await geometry(page);
        await toggle.check();
        await expect(page.locator('.doctor-help-control, .doctor-help-field')).toHaveCount(0);
        expect(await geometry(page)).toEqual(before);
        expect(await page.locator('.explain-affordance').evaluateAll(nodes => nodes.every(node =>
            getComputedStyle(node, '::after').content !== '"?"' && getComputedStyle(node).clipPath === 'inset(50%)'))).toBe(true);
        await page.locator('#service-id').focus();
        await expect(page.getByRole('tooltip')).toBeVisible();
        await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        await expect(page.locator('#service-id')).toBeFocused();
        await page.screenshot({ path: info.outputPath(`doctor-explain-${width}-zoom-${zoom}.png`), fullPage: true });
        await toggle.uncheck();
        expect(await geometry(page)).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    }
    expect(selections).toEqual([]); expect(unexpected).toEqual([]);
});

test('patient modes identify their panels and the library is separate navigation', async ({ page }, info) => {
    const { selections, unexpected } = await load(page);
    const choose = page.getByRole('tab', { name: 'Choose patient', exact: true });
    const manual = page.getByRole('tab', { name: 'Enter identifier', exact: true });
    await expect(choose).toHaveAttribute('aria-selected', 'true');
    await expect(choose).toHaveAttribute('aria-controls', 'patient-choices');
    await expect(manual).toHaveAttribute('aria-controls', 'patient-manual');
    await expect(page.locator('[data-patient-choices]')).toBeVisible();
    await expect(page.locator('[data-patient-manual]')).toBeHidden();
    await expect(page.locator('#patient-name')).toHaveText('No patient selected.');
    await expect(page.locator('.patient-modes [data-patient-library]')).toHaveCount(0);
    await page.locator('#configured-patient').selectOption('http://fhir.health.gov.il/identifier/il-national-id|000000018');
    await manual.click();
    await expect(manual).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#patient-id')).toHaveValue('000000018');
    await page.locator('#patient-id').fill('000000026');
    await expect.poll(() => selections.at(-1)?.patientId).toBe('000000026');
    await expect(page.locator('#patient-name')).toContainText('Name unknown');
    await choose.click(); await expect(page.locator('#configured-patient')).toHaveValue('');
    await expect(page.locator('#patient-id')).toHaveValue('000000026');
    await page.screenshot({ path: info.outputPath('doctor-patient-entry.png'), fullPage: true });
    expect(unexpected).toEqual([]);
});

test('returning patient-library drafts preserve the identifier, service and entry mode', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('pcm-doctor-draft:/doctor:hospital-a', JSON.stringify({
        patientId: '000000026', patientSystem: 'http://fhir.health.gov.il/identifier/il-national-id',
        serviceId: 'review-service', mode: 'manual', fields: {}
    })));
    const { selections, unexpected } = await load(page);
    await expect(page.getByRole('tab', { name: 'Enter identifier', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#patient-id')).toHaveValue('000000026');
    await expect(page.locator('#service-id')).toHaveValue('review-service');
    await expect.poll(() => selections.at(-1)?.patientId).toBe('000000026');
    expect(unexpected).toEqual([]);
});

test('Patient library uses the same help presentation and clearly names the return entry mode', async ({ page }, info) => {
    const ejs = require('node:module').createRequire(path.join(root, 'package.json'))('ejs');
    const { ORDINARY } = require(path.join(root, 'src/sp-client/src/patient-choice'));
    const html = ejs.render(fs.readFileSync(path.join(root, 'src/sp-client/src/views/patients.ejs'), 'utf8'), {
        browserBase: '/doctor', teamId: 'ux-render', identity: 'hospital-a',
        fixed: [ORDINARY], sources: [], state: { generation: 1, state: 'idle' }
    });
    const { unexpected } = await load(page, '', html);
    await expect(page.getByRole('heading', { name: /Doctor Patient library/ })).toBeVisible();
    await page.getByRole('tab', { name: /Source sample/ }).click();
    await expect(page.getByText(/return to the request and choose Enter identifier/)).toBeVisible();
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    const loadButton = page.getByRole('button', { name: 'Load sample', exact: true });
    const sizes = info.project.name === 'mobile' ? [[390, 1], [320, 1]] : [[1440, 1], [1024, 1], [1440, 2]];
    for (const [width, zoom] of sizes) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
        await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        const geometry = () => page.locator('#sample-source, #patient-load > button:not([data-help-for]), main > form').evaluateAll(nodes => nodes.map(node => {
            const { x, y, width, height } = node.getBoundingClientRect(); return { x: x + scrollX, y: y + scrollY, width, height };
        }));
        const before = await geometry();
        await toggle.check();
        expect(await geometry()).toEqual(before);
        await expect(page.locator('.doctor-help-control, .doctor-help-field')).toHaveCount(0);
        await expect(loadButton).toBeDisabled();
        const sourceBounds = await page.locator('#sample-source').boundingBox(), loadBounds = await loadButton.boundingBox();
        expect(loadBounds.y).toBeGreaterThanOrEqual(sourceBounds.y + sourceBounds.height + 7);
        const proxy = page.getByRole('button', { name: 'Explain Load up to 10 sandbox patients', exact: true });
        if (info.project.name === 'mobile') {
            await loadButton.scrollIntoViewIfNeeded(); const bounds = await loadButton.boundingBox();
            await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        } else await proxy.focus();
        await expect(page.getByRole('tooltip')).toContainText('Load up to 10 sandbox patients');
        const tooltip = await page.getByRole('tooltip').boundingBox();
        expect(tooltip.x).toBeGreaterThanOrEqual(0); expect(tooltip.x + tooltip.width).toBeLessThanOrEqual(width + 1);
        await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        // Focus-only accessibility proxies are allowed; unfocus before absence checks.
        await toggle.focus();
        expect(await page.locator('.explain-affordance').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).clipPath === 'inset(50%)'))).toBe(true);
        expect(await geometry()).toEqual(before);
        await toggle.uncheck(); expect(await geometry()).toEqual(before);
        await toggle.check(); expect(await geometry()).toEqual(before);
        // Chromium full-page capture can round zoomed text layout by one CSS px.
        // Assert toggle geometry before capture, then take a fresh post-capture baseline.
        await page.screenshot({ path: info.outputPath(`doctor-library-${width}-zoom-${zoom}.png`), fullPage: true });
        const captured = await geometry();
        await toggle.uncheck(); expect(await geometry()).toEqual(captured);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    }
    expect(unexpected).toEqual([]);
});

test('unknown identifiers stay editable and empty selection recovers before native validation', async ({ page }) => {
    const { unexpected } = await load(page, 'http://fhir.health.gov.il/identifier/il-national-id|000000026');
    await expect(page.getByRole('tab', { name: 'Enter identifier', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#patient-id')).toHaveValue('000000026');
    await page.locator('#patient-id').fill('');
    await page.getByRole('tab', { name: 'Choose patient', exact: true }).click();
    await page.locator('[data-request-consent]').click();
    await expect(page.locator('[data-patient-manual]')).toBeVisible();
    await expect(page.locator('#patient-id')).toBeFocused();
    expect(unexpected).toEqual([]);
});

test('help for a disabled action works by touch and keyboard without submitting', async ({ page }, info) => {
    const { selections, unexpected } = await load(page);
    const submit = page.locator('[data-request-consent]');
    await submit.evaluate(node => { node.disabled = true; });
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    const proxy = submit.locator('..').getByRole('button', { name: 'Explain Create consent request', exact: true });
    if (info.project.name === 'mobile') {
        await submit.scrollIntoViewIfNeeded();
        const bounds = await submit.boundingBox();
        await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    } else await proxy.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    if (info.project.name !== 'mobile') await expect(proxy).toBeFocused();
    expect(selections).toEqual([]); expect(unexpected).toEqual([]);
});

test('normal and zoomed pages fit the viewport, including open tools and expanded details', async ({ page }, info) => {
    await load(page);
    for (const zoom of [1, 2]) {
        await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('#doctor-tools-button').click();
        await expect(page.locator('#doctor-tools-panel')).toBeVisible();
        const bounds = await page.locator('#doctor-tools-panel').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
        if (await page.getByRole('tooltip').isVisible()) await page.getByRole('button', { name: 'Dismiss explanation' }).click();
        await page.locator('[data-tools-close]').click();
        await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        expect(overflow).toBe(false);
        await page.screenshot({ path: info.outputPath(`doctor-zoom-${zoom}.png`), fullPage: true });
    }
});

/** Native touch follows the same field-focus contract as Consent/Admin/Logs. */
test('native fields, dynamic disabled targets and exact patient state remain request-free', async ({ page }, info) => {
    const { selections, unexpected } = await load(page);
    await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click();
    const field = page.locator('#patient-id'), toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    const original = await field.inputValue();
    await toggle.check();
    if (info.project.name === 'mobile') await field.tap(); else await field.hover();
    await expect(page.getByRole('tooltip')).toContainText('Patient identifier');
    await expect(field).toHaveClass(/explain-target/);
    await page.getByRole('button', { name: 'Dismiss explanation' }).click();
    await field.focus(); await field.blur(); await field.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.getByRole('tooltip').getByRole('button').focus(); await page.keyboard.press('Escape');
    await expect(field).toBeFocused(); await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(field).toHaveValue(original);
    const action = page.locator('[data-request-consent]');
    await action.evaluate(node => { node.disabled = true; });
    const proxy = page.locator('[data-help-for="doctor.request"]');
    await expect(proxy).toHaveCount(1); await proxy.focus();
    await expect(page.getByRole('tooltip')).toContainText('Create consent request');
    await action.evaluate(node => { node.remove(); });
    await expect(proxy).toHaveCount(0); await expect(page.getByRole('tooltip')).toBeHidden();
    expect(selections).toEqual([]); expect(unexpected).toEqual([]);
});
