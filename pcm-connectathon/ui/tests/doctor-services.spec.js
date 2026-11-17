'use strict';
/** Actual Doctor EJS/controllers with a deterministic ordinary-client boundary for page/failure UI states. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), http = require('node:http');
const root = process.env.PCM_NAV_REPO || '/repo';
let f, doctor, base, pageNumber, mode, searchCalls;
const ready = { id: 'owned-later', name: 'Later-page owned service', purpose: 'A readable follow-up purpose', readiness: 'Ready to request', available: true,
    definitionReference: 'HealthcareService/definition', definitionVersion: '2', instanceVersion: '3', signature: 'current' };
test.beforeAll(async () => {
    f = await require(root + '/test-support/services-fixture').startServicesFixture('connectathon-mtls', { browserBase: '/pcm' });
    const client = require(root + '/src/sp-client/src/client');
    client.searchConsents = async () => [];
    client.readOwnedService = async id => { if (mode === 'error') throw new Error('503 exact read temporarily unavailable'); return { ...ready, id }; };
    client.searchServices = async (_identity, options) => {
        searchCalls.push({ identity: _identity, page: options.page || '' });
        if (!['hospital-a', 'hospital-b'].includes(_identity)) throw new Error('Services unavailable: diagnostic identity is not a registered provider');
        if (mode === 'error') throw new Error('503 ordinary service API temporarily unavailable');
        pageNumber++;
        return { services: options.page ? [ready, { ...ready, id: 'pending', name: 'Pending registration', available: false, readiness: 'Waiting for activation' }] : [],
            next: options.page ? '' : 'actual-opaque-next', pages: options.page ? 2 : 1, complete: !!options.page, warnings: [], used: { requests: pageNumber, bytes: pageNumber * 100 } };
    };
    const express = require('node:module').createRequire(root + '/package.json')('express'), app = express();
    app.use('/doctor', require(root + '/src/sp-client/src/index').app);
    doctor = http.createServer(app); await new Promise(resolve => doctor.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${doctor.address().port}/doctor`;
    f.config.publicBaseUrls.spClient = base.replace('127.0.0.1', 'localhost'); f.config.publicBaseUrls.pcmUi = f.base.replace('127.0.0.1', 'localhost');
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(f.config));
});
test.afterAll(async () => { doctor?.closeAllConnections(); if (doctor) await new Promise(resolve => doctor.close(resolve)); await f?.close(); });

test('Doctor LIST empty, paging, refresh error, disabled controls and native help @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile'), context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    pageNumber = 0; mode = 'ready'; searchCalls = [];
    const click = async locator => mobile ? locator.tap() : locator.click();
    try {
        await page.goto(base + '/?identity=hospital-a');
        await expect(page.getByRole('button', { name: 'Create consent request', exact: true })).toBeDisabled();
        await expect(page.getByText('No connected services loaded.', { exact: false })).toBeVisible();
        await expect(page.locator('[role="status"]').filter({ hasText: 'Partial or unavailable' })).toBeVisible();
        const callsBeforeHelp = searchCalls.length;
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const requestButton = page.getByRole('button', { name: 'Create consent request', exact: true });
        const proxy = page.getByRole('button', { name: 'Explain Create consent request', exact: true });
        if (mobile) {
            await requestButton.scrollIntoViewIfNeeded();
            const bounds = await requestButton.boundingBox();
            await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        } else await proxy.focus();
        await expect(page.getByRole('tooltip')).toBeVisible(); await expect(page.getByRole('button', { name: 'Dismiss explanation' })).toBeInViewport({ ratio: 1 });
        await click(page.getByRole('button', { name: 'Dismiss explanation' }));
        if (mobile) await expect(page.getByRole('checkbox', { name: 'Explain this page' })).toBeFocused();
        else await expect(proxy).toBeFocused();
        // Enabled actions retain their native click; keyboard focus requests Help.
        await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
        await expect(page.getByRole('tooltip')).toContainText('Refresh services');
        await click(page.getByRole('button', { name: 'Dismiss explanation' }));
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        expect(searchCalls.length).toBe(callsBeforeHelp);
        await click(page.getByRole('button', { name: 'Load more services', exact: true }));
        await expect(page.locator('#service-id option[value="owned-later"]')).toBeEnabled();
        await expect(page.locator('#service-id option[value="pending"]')).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Create consent request', exact: true })).toBeDisabled();
        await page.locator('#service-id').selectOption('owned-later');
        await expect(page.getByRole('button', { name: 'Create consent request', exact: true })).toBeEnabled();
        await expect(page.locator('[name="serviceStamp"]')).toHaveValue('current');
        await click(page.getByText('Service details', { exact: true }));
        await expect(page.getByText('A readable follow-up purpose', { exact: false }).first()).toBeVisible();
        expect(searchCalls.map(item => item.page)).toEqual(['', 'actual-opaque-next']);
        await page.screenshot({ path: info.outputPath('loaded-paging.png'), fullPage: true });
        mode = 'error'; await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('#service-id option[value="owned-later"]')).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Create consent request', exact: true })).toBeDisabled();
        await expect(page.getByText('503 ordinary service API temporarily unavailable', { exact: true }).last()).toBeVisible();
        await expect(page.locator('#doctor-identity')).toHaveValue('hospital-a');
        await page.screenshot({ path: info.outputPath('refresh-error.png'), fullPage: true });
        mode = 'ready'; await page.locator('#doctor-identity').selectOption('untrusted');
        await expect(page.getByRole('link', { name: 'Manage services in PCM', exact: true })).toHaveCount(0);
        await expect(page.getByText('Services unavailable: diagnostic identity is not a registered provider', { exact: true }).last()).toBeVisible();
        await expect(page.locator('#doctor-identity')).toHaveValue('untrusted');
        await expect(page.locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
        expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        fs.writeFileSync(info.outputPath('ui-state-receipt.json'), JSON.stringify({ mobile, viewport: page.viewportSize(), searchCalls, errors, clinicalFallback: false, boundary: 'actual EJS/controllers; deterministic ordinary-client doubles, not native/runtime paging proof' }, null, 2));
    } finally { await context.close(); }
});

test('Doctor LIST Manage return follows a changed PCM provider context @smoke', async ({ browser }, info) => {
    const mobile = info.project.name.includes('mobile'), context = await browser.newContext({ hasTouch: mobile, isMobile: mobile, viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    pageNumber = 0; mode = 'ready'; searchCalls = [];
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: f.base }]);
    const page = await context.newPage();
    const click = async locator => mobile ? locator.tap() : locator.click();
    try {
        await page.goto(f.base + '/admin/services?providerRole=serviceProvider');
        for (const [role, identity] of [['hospitalBServiceProvider', 'hospital-b'], ['serviceProvider', 'hospital-a']]) {
            await page.goto(f.base + '/admin/services?providerRole=' + role);
            await click(page.locator('[data-service-load]').getByRole('button', { name: 'Refresh', exact: true }));
            await expect(page.locator('[data-services-loading]')).toBeHidden();
            const back = page.getByRole('link', { name: 'Doctor', exact: true });
            await expect(back).toHaveAttribute('href', base + '/?identity=' + identity);
            await click(back); await expect(page.locator('#doctor-identity')).toHaveValue(identity);
            await click(page.getByRole('button', { name: 'Tools', exact: true }));
            await click(page.getByRole('link', { name: 'Manage services in PCM', exact: true }));
            await expect(page).toHaveURL(url => url.searchParams.get('providerRole') === role);
            await expect(page.locator('[data-services-fragment="doctor-return"]')).toHaveAttribute('href', base + '/?identity=' + identity);
            await expect(page.locator('#service-provider')).toHaveCount(0);
        }
    } finally { await context.close(); }
});

/** Execute the maintained read-only verifier against this owned actual Doctor route. */
test('Doctor icon-free live verifier binds local served assets and preserves state', async ({}, info) => {
    test.setTimeout(60000);
    mode = 'ready'; pageNumber = 0; searchCalls = [];
    const { spawn } = require('node:child_process');
    const output = info.outputPath('live-verifier');
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [root + '/pcm-connectathon/ui/verify-doctor-live.js', base + '/?identity=hospital-a'], {
            env: { ...process.env, DOCTOR_UI_ROOT: root, DOCTOR_LIVE_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe']
        });
        let transcript = '';
        child.stdout.on('data', chunk => { transcript += chunk; });
        child.stderr.on('data', chunk => { transcript += chunk; });
        child.on('error', reject);
        child.on('exit', code => resolve({ code, transcript }));
    });
    fs.writeFileSync(info.outputPath('live-verifier.log'), result.transcript);
    expect(result.code, result.transcript).toBe(0);
    const receipt = JSON.parse(fs.readFileSync(output + '/live-browser-results.json', 'utf8'));
    expect(receipt.results).toHaveLength(2);
    expect(receipt.results.every(result => result.iconFreeReferenceHelp && result.attemptedWrites.length === 0)).toBe(true);
});
