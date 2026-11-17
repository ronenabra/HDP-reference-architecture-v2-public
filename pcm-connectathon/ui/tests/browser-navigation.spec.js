'use strict';
/** Render maintained navigation templates on alternate origins without changing a retained team. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const available = fs.existsSync(path.join(root, 'src/shared/browser-navigation.js'));
const ejs = available ? require(path.join(root, 'node_modules/ejs')) : null;
const { browserNavigation } = available ? require(path.join(root, 'src/shared/browser-navigation')) : {};
let admin;
if (available) {
    require(path.join(root, 'test-support/team-config')).installTestRuntime();
    admin = require(path.join(root, 'src/pcm-core/src/routes/ui'))._test;
}
test.beforeEach(() => test.skip(!available, 'requires read-only repository mount: PCM_NAV_REPO'));

/** Build an untrusted-proxy Express request view for the browser's actual origin. */
function request(origin) {
    const url = new URL(origin);
    return { protocol: url.protocol.slice(0, -1), get: name => name === 'host' ? url.host : undefined };
}
for (const hostname of ['localhost', '192.0.2.10', 'reachable.example.test']) {
    test(`Header navigation uses reachable ${hostname} with nondefault ports @smoke`, async ({ page }) => {
        const pcm = `http://${hostname}:14100`, doctor = `http://${hostname}:13100`;
        const configured = { spClient: 'http://localhost:13100/doctor', pcmUi: 'http://localhost:14100/pcm' };
        const pcmLinks = browserNavigation(configured, request(pcm), 'pcmUi');
        const doctorLinks = browserNavigation(configured, request(doctor), 'spClient');
        const render = (file, values) => ejs.render(fs.readFileSync(path.join(root, file), 'utf8'), values);
        const dashboard = render('src/pcm-core/src/views/dashboard.ejs', { teamId: 'nav-fixture', consents: [], workflowUrl: `https://${hostname}:14101/sandbox/authentication`, publicBaseUrls: pcmLinks });
        const doctorPage = render('src/sp-client/src/views/index.ejs', { teamId: 'nav-fixture', consents: [], identities: [], currentIdentity: 'fixture', flash: null, patients: [], selectedPatientId: '', patientInventory: { state: 'empty' }, conformance: { mode: 'connectathon', resultLabel: 'Synthetic fixture', warnings: [] }, publicBaseUrls: doctorLinks });
        const logs = render('src/sp-client/src/views/logs.ejs', { teamId: 'nav-fixture', serviceName: 'Doctor', publicUrls: doctorLinks });
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/ui')) return route.fulfill({ contentType: 'text/html', body: dashboard });
            if (url.pathname.endsWith('/logs-view') && url.port === '13100') return route.fulfill({ contentType: 'text/html', body: logs });
            if (url.pathname === '/doctor') return route.fulfill({ contentType: 'text/html', body: doctorPage });
            if (url.pathname === '/admin') return route.fulfill({ contentType: 'text/html', body: admin.renderAdminHtml(request(pcm)) });
            return route.fulfill({ contentType: 'text/html', body: '<h1>Destination</h1>' });
        });
        await page.goto(`${pcm}/pcm/ui`);
        await expect(page.locator('[data-help-key="common.nav-doctor"]')).toHaveAttribute('href', `${doctor}/doctor`);
        await expect(page.locator('[data-help-key="common.nav-admin"]')).toHaveAttribute('href', '/pcm/admin');
        await expect(page.locator('[data-help-key="common.nav-logs"]')).toHaveAttribute('href', '/pcm/logs-view');
        await page.goto(`${doctor}/doctor`);
        await expect(page.locator('[data-help-key="common.nav-consents"]')).toHaveAttribute('href', `${pcm}/pcm/ui`);
        await expect(page.locator('[data-help-key="common.nav-logs"]')).toHaveAttribute('href', `${pcm}/pcm/logs-view`);
        await page.goto(`${doctor}/doctor/logs-view`);
        const central = page.locator('[data-help-key="service-logs.adapter"]');
        await expect(central).toHaveAttribute('href', `${pcm}/pcm/logs-view?role=adapter&diagnostics=true`);
        await expect(page.locator('[data-help-key="service-logs.doctor"]')).toHaveAttribute('href', '/doctor/logs-view');
        // DOM click also exercises collapsed mobile menus without changing the target.
        await central.evaluate(node => node.click());
        await expect(page).toHaveURL(`${pcm}/pcm/logs-view?role=adapter&diagnostics=true`);
        await page.goto(`${pcm}/admin`);
        const link = page.locator('[data-help-key="common.nav-doctor"]');
        await expect(link).toHaveAttribute('href', `http://${hostname}:3100`);
    });
}
