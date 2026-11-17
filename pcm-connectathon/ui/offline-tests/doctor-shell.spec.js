'use strict';
/** Real EJS/controller geometry plus a real Doctor/public-wire library round trip. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = process.env.DOCTOR_UI_ROOT || path.resolve(__dirname, '../../..');
const { render } = require(path.join(root, 'test-support/doctor-ux-render'));
const ejs = require('node:module').createRequire(path.join(root, 'package.json'))('ejs');
const { ORDINARY } = require(path.join(root, 'src/sp-client/src/patient-choice'));
const longName = 'Hospital application with a long configured name / '.repeat(6);
const context = { browserBase: '/team/doctor', teamId: 'shell-fixture', currentIdentity: 'hospital-a', identity: 'hospital-a',
    applicationLabel: longName, identities: [{ id: 'hospital-a', label: longName }],
    publicBaseUrls: { pcmUi: 'https://pcm.example/tenant/pcm' },
    conformance: { resultLabel: 'STRICT SANDBOX', version: 4, warnings: [] },
    sandboxNotice: { message: '0 of 1 configured data sources have relaxed transport or assertion checks.', sources: [{ name: 'Managed source', relaxed: [] }] } };

/** Keep all assets real and reject every network operation outside the rendered fixture. */
async function load(page, surface) {
    const unexpected = [], errors = [];
    const html = surface === 'request' ? render(undefined, 'active', context) : ejs.render(fs.readFileSync(path.join(root, 'src/sp-client/src/views/patients.ejs'), 'utf8'),
        { ...context, fixed: [ORDINARY], sources: [], state: { state: 'unloaded', generation: 1 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url()), asset = path.basename(url.pathname);
        if (request.method() === 'GET' && url.origin === 'https://shell.test') {
            if (url.pathname === '/team/doctor/') return route.fulfill({ body: html, contentType: 'text/html' });
            const filename = path.join(root, 'src/shared/ui', asset);
            if (/^[a-z-]+\.(css|js)$/.test(asset) && fs.existsSync(filename)) return route.fulfill({ body: fs.readFileSync(filename), contentType: asset.endsWith('.css') ? 'text/css' : 'application/javascript' });
        }
        unexpected.push(request.method() + ' ' + url.pathname); return route.abort();
    });
    await page.goto('https://shell.test/team/doctor/');
    return { unexpected, errors };
}

/** Compare document coordinates so ordinary native focus scrolling is not a layout change. */
const geometry = page => page.locator('.doctor-shell-header, .doctor-shell-header h1, .sandbox-navigation > a, #doctor-tools-button, .explain-toggle, .doctor-shell-notice').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect(); return { x: x + scrollX, y: y + scrollY, width, height };
}));

for (const surface of ['request', 'library']) test(`${surface} shell: long context, responsive Explain geometry and native Tools`, async ({ page }, info) => {
    const { unexpected, errors } = await load(page, surface);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' });
    await expect(page.locator('header h1')).toContainText('Doctor');
    await expect(page.locator('.doctor-shell-header')).toContainText('Requesting application:');
    const sizes = info.project.name === 'mobile' ? [[390, 1], [320, 1]] : [[1440, 1], [1024, 1], [1440, 2]];
    const measurements = [];
    for (const [width, zoom] of sizes) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        await toggle.uncheck();
        const before = await geometry(page);
        await toggle.check(); expect(await geometry(page)).toEqual(before);
        await page.locator('#doctor-tools-button').focus();
        await expect(page.getByRole('tooltip')).toBeVisible();
        const tip = await page.getByRole('tooltip').boundingBox();
        expect(tip.x).toBeGreaterThanOrEqual(0); expect(tip.x + tip.width).toBeLessThanOrEqual(width + 1);
        await page.keyboard.press('Escape'); await expect(page.locator('#doctor-tools-button')).toBeFocused();
        await toggle.uncheck(); expect(await geometry(page)).toEqual(before);
        await page.screenshot({ path: info.outputPath(`${surface}-${width}-zoom-${zoom}-off.png`), fullPage: true });
        const captured = await geometry(page);
        await toggle.check(); expect(await geometry(page)).toEqual(captured);
        await page.screenshot({ path: info.outputPath(`${surface}-${width}-zoom-${zoom}-on.png`), fullPage: true });
        await toggle.uncheck();
        const open = page.locator('#doctor-tools-button');
        if (info.project.name === 'mobile') await open.tap(); else { await open.focus(); await page.keyboard.press('Enter'); }
        await expect(page.locator('#doctor-tools-panel')).toBeVisible();
        await expect(page.getByRole('link', { name: 'Test SMART application launch', exact: true })).toBeFocused();
        const panel = await page.locator('#doctor-tools-panel').boundingBox();
        expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(width + 1);
        await page.keyboard.press('Escape'); await expect(open).toBeFocused();
        await open.click(); await page.getByRole('button', { name: 'Close tools', exact: true }).click();
        await expect(open).toBeFocused(); await expect(page.locator('#doctor-tools-panel')).toBeHidden();
        const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
        measurements.push({ width, zoom, geometry: captured, overflow });
    }
    fs.writeFileSync(info.outputPath('geometry.json'), JSON.stringify(measurements, null, 2));
    expect(unexpected).toEqual([]); expect(errors).toEqual([]);
});

test('actual mounted library round trip preserves application, service and manual draft without clinical effects', async ({ page }, info) => {
    const fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer();
    let proxy;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        // An owned proxy reproduces a deployment mount without changing the product router.
        proxy = http.createServer((req, res) => {
            if (!req.url.startsWith('/team/doctor')) { res.writeHead(404); return res.end(); }
            const upstream = http.request(fixture.doctorBase + (req.url.slice('/team/doctor'.length) || '/'), { method: req.method, headers: req.headers }, response => {
                res.writeHead(response.statusCode, response.headers); response.pipe(res);
            });
            upstream.on('error', error => { res.writeHead(502); res.end(error.message); }); req.pipe(upstream);
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${proxy.address().port}/team/doctor`;
        fixture.config.publicBaseUrls.spClient = base;
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
        await page.goto(base + '/?identity=hospital-a');
        const service = page.locator('#service-id');
        await service.selectOption(fixture.instance.id);
        await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click();
        await page.locator('#patient-id').fill('000000026');
        // The existing selection save is deliberate; navigation/help must add no clinical operation.
        await expect(page.locator('#patient-feedback')).toContainText('Ordinary identifiers require explicit Consent review');
        const selected = await service.inputValue(), before = fixture.requests.length, count = fixture.consents.size;
        await page.locator('[data-patient-library]').click();
        await expect(page.getByRole('link', { name: 'Back to request', exact: true })).toHaveAttribute('href', '/team/doctor/?identity=hospital-a');
        await expect(page.locator('.doctor-application-context')).toContainText(require(path.join(root, 'src/sp-client/src/identities')).getIdentities().find(value => value.id === 'hospital-a').label);
        await expect(page.getByRole('link', { name: 'Consents', exact: true })).toHaveAttribute('href', /\/ui$/);
        await expect(page.locator('.doctor-shell-notice')).toContainText('Synthetic patients only');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const back = page.getByRole('link', { name: 'Back to request', exact: true });
        await back.focus(); await expect(page.getByRole('tooltip')).toContainText('selected service');
        await page.keyboard.press('Escape'); await expect(back).toBeFocused();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.screenshot({ path: info.outputPath('actual-library.png'), fullPage: true });
        expect(fixture.requests.slice(before)).toEqual([]);
        await back.click();
        await expect(service).toHaveValue(selected);
        await expect(page.locator('#doctor-identity')).toHaveValue('hospital-a');
        await expect(page.locator('#patient-id')).toHaveValue('000000026');
        await expect(page.getByRole('tab', { name: 'Enter identifier', exact: true })).toHaveAttribute('aria-selected', 'true');
        // Revisit and exercise the library's Tools destination, using the same saved draft.
        await page.locator('[data-patient-library]').click();
        await page.locator('#doctor-tools-button').click();
        await page.getByRole('link', { name: 'Manual request testing', exact: true }).click();
        await expect(page.locator('#manual-testing')).toHaveAttribute('open', '');
        await expect(service).toHaveValue(selected); await expect(page.locator('#patient-id')).toHaveValue('000000026');
        await page.screenshot({ path: info.outputPath('actual-return.png'), fullPage: true });
        const after = fixture.requests.slice(before);
        expect(after.filter(request => request.path.startsWith('/source-') || (request.method === 'POST' && request.path.endsWith('/Consent')) || request.requestedScope?.startsWith('patient/'))).toEqual([]);
        expect(fixture.consents.size).toBe(count); expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('passive-receipt.json'), JSON.stringify({ selected, application: 'hospital-a', consentCount: count, requests: after, violations: fixture.violations, errors }, null, 2));
        // Library navigation holds a deliberate draft; Reset must not resurrect it.
        await page.locator('[data-patient-library]').click();
        const draftKey = 'pcm-doctor-draft:/team/doctor:hospital-a';
        await page.locator('#doctor-tools-button').click();
        page.once('dialog', dialog => dialog.dismiss());
        await page.getByRole('button', { name: 'Reset Doctor state', exact: true }).click();
        await expect(page.getByRole('link', { name: 'Back to request', exact: true })).toBeVisible();
        expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).patientId, draftKey)).toBe('000000026');
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button', { name: 'Reset Doctor state', exact: true }).click();
        await expect(page.locator('#patient-id')).toHaveValue('000000018');
        await expect(service).toHaveValue('');
        expect(fixture.consents.size).toBe(count); expect(fixture.violations).toEqual([]);
    } finally {
        if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
        await fixture.close();
    }
});
