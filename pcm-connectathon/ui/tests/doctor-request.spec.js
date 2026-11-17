'use strict';
/** Actual mounted Doctor + disposable PCM OAuth/FHIR, with faults only at ordinary API reads. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const { EXTENSIONS } = require(path.join(root, 'src/shared/pcm-contract'));
let fixture, setup, server, base, failSearch = false, holdSearch;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/request20',
        apiMiddleware: async (req, res, next) => {
            if (req.method === 'GET' && req.path.endsWith('/HealthcareService')) {
                if (holdSearch) await holdSearch;
                if (failSearch) return res.status(503).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'transient', diagnostics: 'Owned service search unavailable' }] });
            }
            next();
        }
    });
    setup = require(path.join(root, 'test-support/services-list-fixture')).installServicesListFixture(fixture);
    const express = require('node:module').createRequire(path.join(root, 'package.json'))('express'), app = express();
    app.use('/team/doctor', require(path.join(root, 'src/sp-client/src/index')).app);
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/team/doctor`;
    fixture.config.publicBaseUrls.spClient = base; fixture.config.publicBaseUrls.pcmUi = fixture.base;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
    await fetch(base + '/reset', { method: 'POST', redirect: 'manual' });
});
test.afterAll(async () => {
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    setup?.restore(); await fixture?.close();
});
/** Drive actual native controls with keyboard or touch, collecting public-only outgoing traffic. */
async function open(browser, info) {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?identity=hospital-a');
    return { context, page, errors, click: target => mobile ? target.tap() : target.click() };
}
const ordinary = 'http://fhir.health.gov.il/identifier/il-national-id|000000018';
const standard = 'http://fhir.health.gov.il/identifier/il-hdp-test-id|1';
const composer = page => page.locator('form[action$="/create-consent"]');
const create = page => composer(page).getByRole('button', { name: 'Create consent request', exact: true });
/** Assert the actual wire contract, including the absence of any displayed scope or permission edits. */
function assertContract(body, patient, serviceId) {
    expect(body).toEqual(require(path.join(root, 'src/sp-client/src/fhir-builders')).buildConsentSubmit({ system: patient.split('|')[0], value: patient.split('|')[1] }, serviceId));
    expect(JSON.stringify(body)).not.toMatch(/patient\/|snapshot|compiled|authoring|scopeSelection/);
}

test('REQUEST patient → selected public summary → create uses exact PCM contract and isolated equal-name assignments', async ({ browser }, info) => {
    const { page, context, errors, click } = await open(browser, info);
    try {
        const a = setup.registrationsA[0], b = setup.registrationsB[0];
        expect(a.name).toBe(b.name);
        await expect(page.locator('#service-id option[value]')).toHaveCount(6);
        await expect(page.locator(`#service-id option[value="${b.id}"]`)).toHaveCount(0);
        await page.locator('#configured-patient').selectOption(ordinary);
        await page.locator('#service-id').selectOption(a.id);
        await expect(composer(page).locator('[data-selected-service-summary]')).toBeVisible();
        await expect(composer(page).locator('[data-service-details]')).not.toHaveAttribute('open');
        const beforePassive = fixture.requests.length;
        await composer(page).getByText('Service details', { exact: true }).focus(); await page.keyboard.press('Enter');
        await expect(composer(page)).toContainText('Granted permissions not yet obtained');
        expect(fixture.requests.length).toBe(beforePassive);
        await page.locator('#service-id').selectOption(setup.registrationsA[1].id);
        await expect(composer(page).locator('[data-selected-service-summary]')).toHaveCount(1);
        await expect(composer(page).locator('[data-service-fact="name"]')).toHaveText(setup.registrationsA[1].name);
        await expect(composer(page).locator('[data-service-details]')).not.toHaveAttribute('open');
        await page.locator('#service-id').selectOption('');
        await expect(composer(page).locator('[data-selected-service-summary]')).toBeHidden();
        await expect(page.locator('#service-selection-status')).toContainText('Choose a connected service');
        await expect(create(page)).toBeDisabled();
        await page.locator('#service-id').selectOption(a.id);
        const before = new Set(fixture.store.getAll('Consent').map(consent => consent.id));
        await click(create(page)); await expect(page.locator('[data-help-key="common.feedback"]')).toContainText('Consent request created.');
        const added = fixture.store.getAll('Consent').find(consent => !before.has(consent.id));
        expect(added.status).toBe('proposed'); expect(added.patient.identifier.value).toBe('000000018');
        const ordinaryWire = fixture.requests.filter(row => row.method === 'POST' && row.path.endsWith('/Consent')).at(-1);
        expect(ordinaryWire.status).toBe(201); assertContract(ordinaryWire.body, ordinary, a.id);
        // The fixture uses PCM's existing separate patient-decision owner; Doctor still reads only public FHIR.
        const approved = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle')).approveConsent({ ...fixture, consent: added, scopeChoice: 'service-provided', sourceOrganizationIds: [fixture.config.healthOrganizations[0].dataSourceOrganization.id] });
        await page.reload(); await expect(page.locator(`[data-consent-card="${approved.id}"]`)).toContainText('Recorded: active');
        const immutable = JSON.stringify(fixture.store.get('Consent', approved.id));
        await page.locator('#configured-patient').selectOption(standard); await page.locator('#service-id').selectOption(a.id);
        await click(create(page)); await expect(page.locator('[data-help-key="common.feedback"]')).toContainText('Consent request created.');
        const testWire = fixture.requests.filter(row => row.method === 'POST' && row.path.endsWith('/Consent')).at(-1);
        expect(testWire.status).toBe(201); assertContract(testWire.body, standard, a.id);
        const auto = fixture.store.getAll('Consent').find(consent => !before.has(consent.id) && consent.id !== added.id);
        expect(auto.status).toBe('active');
        expect(JSON.stringify(fixture.store.get('Consent', approved.id))).toBe(immutable);
        await expect(page.locator(`[data-consent-card="${approved.id}"]`)).toContainText('000000018');
        await expect(page.locator(`[data-consent-card="${approved.id}"]`)).toContainText('Recorded: active');
        await page.locator('#doctor-identity').selectOption('hospital-b');
        await expect(page.locator('#service-id option[value]')).toHaveCount(3);
        await expect(page.locator(`#service-id option[value="${a.id}"]`)).toHaveCount(0);
        await expect(page.locator(`#service-id option[value="${b.id}"]`)).toBeEnabled();
        await expect(composer(page)).toContainText('Services connected to');
        await click(page.getByRole('button', { name: 'Tools', exact: true }));
        await expect(page.getByRole('link', { name: 'Manage services in PCM', exact: true })).toHaveAttribute('href', /\/request20\/admin\/services\?providerRole=hospitalBServiceProvider$/);
        await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
        await click(page.getByRole('link', { name: 'Manage services in PCM', exact: true }));
        await expect(page.locator('[data-services-fragment="doctor-return"]')).toHaveAttribute('href', base + '/?identity=hospital-b');
        await click(page.getByRole('link', { name: 'Provider assignments', exact: true }));
        await expect(page.locator('[data-services-fragment="doctor-return"]')).toHaveAttribute('href', base + '/?identity=hospital-b');
        expect(new URL(page.url()).searchParams.get('providerRole')).toBe('hospitalBServiceProvider');
        await click(page.locator('[data-service-load]').getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('[data-services-loading]')).toBeHidden();
        await expect(page.locator('[data-services-fragment="doctor-return"]')).toHaveAttribute('href', base + '/?identity=hospital-b');
        await click(page.getByRole('link', { name: 'Service catalog', exact: true }));
        await click(page.locator('[data-services-fragment="doctor-return"]'));
        await expect(page.locator('#doctor-identity')).toHaveValue('hospital-b');
        await click(page.getByRole('button', { name: 'Tools', exact: true }));

        await click(page.getByRole('button', { name: 'Close tools', exact: true }));
        await page.locator('#doctor-identity').selectOption('untrusted');
        await expect(page.locator('#service-id option[value]')).toHaveCount(1); await expect(create(page)).toBeDisabled();
        await click(page.getByRole('button', { name: 'Tools', exact: true }));
        await expect(page.getByRole('link', { name: 'Manage services in PCM', exact: true })).toHaveCount(0);
        expect(fixture.requests.filter(row => row.path.includes('introspect') || row.path.includes('/source-') || /private|permission|approval/.test(row.path))).toEqual([]);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('real-pcm-creation.json'), JSON.stringify({ actualPCM: true, ordinaryWire, testWire, approvedId: approved.id, automaticId: auto.id, unchangedExistingConsent: true, requests: fixture.requests, errors }, null, 2));
        await page.screenshot({ path: info.outputPath('diagnostic-no-fallback.png'), fullPage: true });
    } finally { await context.close(); }
});

test('REQUEST loading/stale/error and metadata races block creation, preserve draft, and recover only after successful review', async ({ browser }, info) => {
    const { page, context, errors, click } = await open(browser, info);
    let release;
    try {
        const service = setup.registrationsA[0];
        await page.locator('#configured-patient').selectOption(ordinary); await page.locator('#service-id').selectOption(service.id);
        const fields = await composer(page).evaluate(form => Object.fromEntries(new FormData(form)));
        // Fresh exact read detects metadata changed since the rendered review; no Consent is written.
        const definition = fixture.store.get('HealthcareService', setup.definitions[0].id);
        fixture.store.update({ ...definition, extraDetails: 'Updated purpose — review this changed service.' });
        const before = fixture.store.getAll('Consent').length;
        await page.request.post(base + '/create-consent', { form: fields });
        expect(fixture.store.getAll('Consent')).toHaveLength(before);
        await page.reload(); await expect(composer(page)).toContainText('Updated purpose — review this changed service.');
        expect(errors).toEqual([]);
        let captureLoading;
        const loadingObserved = new Promise(resolve => { captureLoading = resolve; });
        await page.exposeBinding('captureDoctorLoading', (_source, state) => captureLoading(state));
        await page.evaluate(() => {
            document.querySelector('#refresh-services').addEventListener('submit', () => {
                // Capture after the real controller's handlers, before native navigation destroys this document.
                window.captureDoctorLoading({ text: document.querySelector('#service-list-status').textContent,
                    busy: document.querySelector('#refresh-services').getAttribute('aria-busy'), disabled: document.querySelector('[data-request-consent]').disabled });
            });
        });
        holdSearch = new Promise(resolve => { release = resolve; }); failSearch = true;
        const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true });
        await refreshButton.scrollIntoViewIfNeeded();
        const refreshing = refreshButton.click({ noWaitAfter: true });
        const loadingState = await loadingObserved;
        expect(loadingState.text).toContain('Loading services'); expect(loadingState.busy).toBe('true'); expect(loadingState.disabled).toBe(true);
        fs.writeFileSync(info.outputPath('loading-state.json'), JSON.stringify(loadingState, null, 2));
        release(); holdSearch = null; await refreshing;
        await expect(page.locator('#service-list-status')).toContainText('Stale — refresh failed'); await expect(create(page)).toBeDisabled();
        await expect(page.locator('#patient-id')).toHaveValue('000000018');
        await expect(page.locator('#service-selection-status')).toContainText('Refresh');
        await page.request.post(base + '/create-consent', { form: fields }); expect(fixture.store.getAll('Consent')).toHaveLength(before);
        await page.screenshot({ path: info.outputPath('stale-error.png'), fullPage: true });
        for (const [width, zoom] of [[320, 1], [1024, 2]]) {
            await page.setViewportSize({ width, height: 1000 }); await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await expect(create(page)).toBeDisabled();
            await page.screenshot({ path: info.outputPath(`stale-error-${width}-${zoom * 100}.png`), fullPage: true });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        await page.setViewportSize({ width: info.project.name.includes('mobile') ? 390 : 1440, height: 1000 });
        failSearch = false; await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator('#service-list-status')).toContainText('Complete'); await expect(create(page)).toBeEnabled();
        await expect(page.locator('#patient-id')).toHaveValue('000000018');
        // A newly paused selection stays visible with a concrete disabled reason.
        require(path.join(root, 'src/pcm-core/src/sandbox-service-command')).applyServiceCommand({ ...fixture, id: service.id, action: 'disable', expectedVersion: fixture.store.get('HealthcareService', service.id).meta.versionId, operator: 'request20-fixture', audit() {} });
        await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(page.locator(`#service-id option[value="${service.id}"]`)).toBeDisabled(); await expect(create(page)).toBeDisabled();
        await expect(composer(page)).toContainText('Registration suspended');
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('refresh-race.json'), JSON.stringify({ actualPCM: true, rejectedStaleSubmit: true, patientDraft: await page.locator('#patient-id').inputValue(), errors }, null, 2));
    } finally {
        release?.(); failSearch = false; holdSearch = null;
        const service = setup.registrationsA[0], current = fixture.store.get('HealthcareService', service.id);
        if (current && !current.active) require(path.join(root, 'src/pcm-core/src/sandbox-service-command')).applyServiceCommand({ ...fixture, id: service.id, action: 'enable', expectedVersion: current.meta.versionId, operator: 'request20-fixture', audit() {} });
        await context.close();
    }
});

test('REQUEST default/expanded long public facts wrap at desktop/mobile/200% with passive keyboard and touch details/help', async ({ browser }, info) => {
    const { page, context, errors, click } = await open(browser, info);
    try {
        const service = setup.registrationsA[0];
        await page.locator('#configured-patient').selectOption(ordinary); await page.locator('#service-id').selectOption(service.id);
        const definition = fixture.store.get('HealthcareService', setup.definitions[0].id);
        fixture.store.update({ ...definition, extraDetails: 'Long public purpose and complete identifier text '.repeat(12), identifier: [...definition.identifier, { system: 'https://pcm.example/public-business-identifier/' + 'Long-CaSe-'.repeat(24), value: '000-' + 'Complete-ID-'.repeat(16) }] });
        await click(page.getByRole('button', { name: 'Refresh', exact: true }));
        await expect(composer(page).locator('[data-service-details]')).not.toHaveAttribute('open');
        await expect(create(page)).toBeEnabled();
        await expect(composer(page).locator('[data-service-fact="fullPurpose"]')).toContainText('Long public purpose');
        await expect(composer(page).locator('[data-service-fact="identifiers"]')).toContainText('Complete-ID-');
        await expect(composer(page).locator('[data-service-fact="intent"]')).toContainText('patient/DiagnosticReport.rs');
        const dimensions = [];
        for (const width of [1440, 1024, 390, 320]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await composer(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`default-${width}.png`), fullPage: true });
            const before = fixture.requests.length;
            const summary = composer(page).getByText('Service details', { exact: true });
            if (info.project.name.includes('mobile')) await click(summary); else { await summary.focus(); await page.keyboard.press('Enter'); }
            await expect(composer(page).locator('[data-service-details]')).toHaveAttribute('open');
            expect(fixture.requests.length).toBe(before);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`expanded-${width}.png`), fullPage: true });
            await click(summary);
            dimensions.push({ width, noOverflow: true });
        }
        await page.setViewportSize({ width: 1024, height: 1000 }); await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        await click(composer(page).getByText('Service details', { exact: true }));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('expanded-200-percent.png'), fullPage: true });
        const before = fixture.requests.length;
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const target = composer(page).getByText('Service details', { exact: true }); await target.focus();
        await expect(page.getByRole('tooltip')).toContainText('Service details');
        await page.keyboard.press('Escape'); await expect(target).toBeFocused();
        expect(fixture.requests.length).toBe(before); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('responsive-passive.json'), JSON.stringify({ dimensions, zoom: '200% CSS zoom', passivePublicRequests: 0, errors }, null, 2));
    } finally { await context.close(); }
});
