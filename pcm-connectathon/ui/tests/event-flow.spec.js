'use strict';

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const sp = process.env.PCM_UI_SP_URL;
const pcm = process.env.PCM_UI_PCM_URL;
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { enablePageHelp } = require('./helpers/help-bindings');

/** Reach the one current owning Admin workspace without substituting a source. */
function adminUrl(section, source, view) {
    const url = new URL(`${pcm}/admin`); url.searchParams.set('section', section);
    if (source) url.searchParams.set('source', source);
    if (view) url.searchParams.set('view', view);
    return url.href;
}

test.beforeEach(async ({ page }) => {
    if (process.env.PCM_UI_ADMIN_PASSWORD) await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
});

function observe(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(`page: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', request => {
        if (!request.url().startsWith('data:')) errors.push(`request: ${request.url()} ${request.failure()?.errorText}`);
    });
    return errors;
}

async function assertUsable(page, url) {
    const errors = observe(page);
    await page.goto(url, { waitUntil: 'networkidle' });
    expect(await page.locator('html').getAttribute('lang')).toBeTruthy();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${url} overflows the viewport by ${overflow}px`).toBeLessThanOrEqual(1);
    const accessibility = await new AxeBuilder({ page }).analyze();
    const blocking = accessibility.violations.filter(item => ['critical', 'serious'].includes(item.impact));
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    expect(errors).toEqual([]);
}

test('critical pages are responsive and accessible @smoke', async ({ page }) => {
    // The Admin page performs exact paginated checks against all three HAPIs;
    // allow the bounded cross-browser scan to include that live inventory.
    test.setTimeout(180000);
    for (const url of [`${sp}/`, `${sp}/manage`, `${sp}/logs-view`, `${pcm}/ui`, `${pcm}/logs-view`, `${pcm}/admin`]) {
        // Isolate live polling from the next page's error observer during navigation.
        const checkedPage = await page.context().newPage();
        try { await assertUsable(checkedPage, url); }
        finally { await checkedPage.close(); }
    }
});

test('external assets can be blocked while the Doctor flow remains styled', async ({ page }) => {
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (!['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname)) return route.abort('blockedbyclient');
        return route.continue();
    });
    await page.goto(`${sp}/`);
    await expect(page.locator('link[href="/assets/connectathon.css"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Create consent request' })).toBeVisible();
    const width = await page.getByRole('button', { name: 'Create consent request' }).evaluate(node => getComputedStyle(node).borderRadius);
    expect(width).not.toBe('0px');
});

test('Chromium completes consent approval, discovery, and token-backed fetch', async ({ page }, testInfo) => {
    const inventory = require('./fixture-facts').selectedFixtureFacts();
    if (process.env.PCM_UI_REQUIRE_CLINICAL === 'true') expect(inventory.patients.length, 'required verified clinical fixture').toBeGreaterThan(0);
    else test.skip(!inventory.patients.length, 'no selected verified clinical fixture');
    await page.goto(`${sp}/`);
    await enablePageHelp(page, expect);
    // The offline picker defaults to a standard test patient; the clinical fixture is a separate ordinary patient.
    const patient = inventory.patients.find(item => item.idSystem === 'http://fhir.health.gov.il/identifier/il-national-id' && item.idValue === '000000018');
    expect(patient, 'verified positive clinical fixture patient').toBeTruthy();
    await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click(); await page.locator('#patient-id').fill(`${patient.idSystem}|${patient.idValue}`);
    await page.locator('#service-id').selectOption(await page.locator('#service-id option').filter({ hasText: 'Laboratory follow-up' }).getAttribute('value'));
    // Snapshot this selection after its saved context is rendered. Previous GUID or
    // service selections can hide existing cards; revealing them is not a new request.
    await page.waitForLoadState('networkidle');
    await page.reload();
    const storedIds = await page.locator('.card:has(button[formaction="/discover"]) input[name="consentId"]')
        .evaluateAll(inputs => inputs.map(input => input.value));
    await page.getByRole('button', { name: 'Create consent request', exact: true }).click();
    await expect(page.getByText(/Consent request created\./)).toBeVisible();
    // Retained teams can contain stale Doctor cards after PCM reset/restore.
    // Follow the consent created by this journey rather than an existing first card.
    const currentIds = await page.locator('.card:has(button[formaction="/discover"]) input[name="consentId"]')
        .evaluateAll(inputs => inputs.map(input => input.value));
    const createdIds = currentIds.filter(id => !storedIds.includes(id));
    expect(createdIds).toHaveLength(1);
    const consentId = createdIds[0];
    expect(consentId).toMatch(/^[A-Za-z0-9.-]+$/);
    await page.goto(`${pcm}/ui`);
    const review = page.locator(`a[href="/ui/approve/${consentId}"]`);
    if (await review.count()) {
        await review.click();
        await enablePageHelp(page, expect);
        await page.locator('input[data-help-key^="scope."]').first().focus();
        await expect(page.getByRole('tooltip')).toBeVisible();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /Approve/, exact: false }).filter({ hasText: 'Approve request' }).click();
        await expect(page).toHaveURL(/\/ui$/);
    }
    await page.goto(`${sp}/`);
    // Easy mode may discover more than one stored consent; keep every assertion
    // attached to the same card whose discovery and fetch actions we exercise.
    const consentCard = page.locator(`.card:has(input[name="consentId"][value="${consentId}"])`);
    await consentCard.locator('button[formaction="/discover"]').click();
    await expect(consentCard.getByText('Data source', { exact: true })).toBeVisible();
    await consentCard.locator('button[formaction="/fetch-data"]').click();
    await expect(consentCard.getByRole('region', { name: 'Fetched FHIR data', exact: true })).toContainText('First-page preview');
    const result = JSON.parse(await consentCard.getByRole('region', { name: 'Fetched FHIR data' }).locator('pre').textContent());
    expect(result.resourceType === 'Observation' || result.entry?.some(entry => entry.resource?.resourceType === 'Observation')).toBeTruthy();
});

test('Chromium exercises the bounded Admin operator lifecycle', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'operator lifecycle is the bounded Chromium desktop matrix');
    test.setTimeout(180000);
    const jsonHeaders = { Accept: 'application/json' };

    const status = await page.request.get(`${pcm}/admin/status`, { headers: jsonHeaders });
    expect(status.ok()).toBeTruthy();
    const initialStatus = await status.json();
    expect(initialStatus.teamId).toBeTruthy();

    const inventoryResponse = await page.request.get(`${pcm}/admin/api/fhir-servers`, { headers: jsonHeaders });
    expect(inventoryResponse.ok()).toBeTruthy();
    const inventory = await inventoryResponse.json();
    expect(inventory.servers).toHaveLength(3);
    expect(inventory.excludedSources).toContainEqual(expect.objectContaining({ id: 'legacy-ds' }));
    const selectedServer = inventory.servers[0];
    const serverId = selectedServer.id;
    const dataStatus = await page.request.get(`${pcm}/admin/api/fhir-servers/${serverId}/data`, { headers: jsonHeaders });
    expect(dataStatus.ok(), await dataStatus.text()).toBeTruthy();
    const rejectedDelete = await page.request.delete(`${pcm}/admin/api/fhir-servers/${serverId}/data`, {
        headers: jsonHeaders,
        data: { confirmation: 'wrong-target-token' }
    });
    expect(rejectedDelete.status()).toBe(409);
    if (process.env.PCM_UI_REQUIRE_CLINICAL === 'true') {
        await page.goto(adminUrl('sources', selectedServer.sourceId || initialStatus.config.healthOrganizations.find(ho => ho.id === serverId).dataSourceOrganization.id, 'data'));
        const recovery = page.locator(`[data-managed-fhir-server="${serverId}"] form[action$="/recover"]`);
        await expect(recovery).toHaveCount(1);
        await recovery.locator('[name="workersStopped"]').check();
        page.once('dialog', dialog => dialog.accept());
        await recovery.getByRole('button').click();
        expect(new URL(page.url()).pathname).toBe('/admin');
        const bundle = fs.readFileSync(`/ci/${serverId}.source.transaction.json`);
        const upload = () => page.request.post(`${pcm}/admin/api/fhir-servers/${serverId}/imports`, {
            headers: jsonHeaders, multipart: { replace: 'true', bundle: { name: `${serverId}.source.transaction.json`, mimeType: 'application/json', buffer: bundle } }
        });
        const attempts = await Promise.all([upload(), upload()]);
        expect(attempts.map(item => item.status()).sort()).toEqual([202, 409]);
        const operation = await attempts.find(item => item.status() === 202).json();
        await expect.poll(async () => {
            const response = await page.request.get(`${pcm}/admin/api/data-operations/${operation.id}`, { headers: jsonHeaders });
            return (await response.json()).phase;
        }, { timeout: 120000 }).toBe('succeeded');
        await page.goto(`${pcm}/admin`);
        // Retired clinical controls cannot be reintroduced by an old operator command.
        const beforeRetired = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
        const retired = await page.request.post(`${pcm}/admin/config/simulation`, { headers: jsonHeaders,
            data: { preset: initialStatus.config.conformance.preset, controls: { history: false, paging: true } } });
        expect(retired.status()).toBe(400);
        expect((await retired.json()).error).toMatch(/securitySimulation\.global\.(?:history|paging).*not allowed|unknown security simulation control/i);
        expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config).toEqual(beforeRetired);
    }
    const bootstrap = await page.request.post(`${pcm}/admin/config/fhir-servers/${serverId}/bootstrap`, {
        headers: jsonHeaders,
        data: {
            policy: selectedServer.bootstrap.policy,
            bundleReference: selectedServer.bootstrap.bundleReference,
            expectedSource: selectedServer.bootstrap.expectedSource
        }
    });
    expect(bootstrap.ok(), await bootstrap.text()).toBeTruthy();

    const sanity = await page.request.post(`${pcm}/admin/sanity-check`, { headers: jsonHeaders, data: {} });
    const sanityBody = await sanity.json();
    expect(sanity.ok(), JSON.stringify(sanityBody)).toBeTruthy();
    expect(sanityBody.result?.status).toBe('pass');

    const logs = await page.request.get(`${pcm}/admin/logs`, { headers: jsonHeaders });
    expect(logs.ok()).toBeTruthy();
    const backupResponse = await page.request.get(`${pcm}/admin/backup`, { headers: jsonHeaders });
    expect(backupResponse.ok()).toBeTruthy();
    const backup = await backupResponse.json();
    for (const endpoint of ['/admin/certs/download-bundle', '/admin/certs/download-zip']) {
        const download = await page.request.get(`${pcm}${endpoint}`);
        expect(download.ok(), endpoint).toBeTruthy();
    }

    const reset = await page.request.post(`${pcm}/admin/reset`, { headers: jsonHeaders, data: {} });
    expect(reset.ok(), await reset.text()).toBeTruthy();
    const reviewedRestore = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    const restore = await page.request.post(`${pcm}/admin/restore`, {
        headers: jsonHeaders,
        data: { backupJson: JSON.stringify(backup), expectedRevision: String(reviewedRestore.runtime.revision) }
    });
    expect(restore.ok(), await restore.text()).toBeTruthy();

    const sourceState = await (await page.request.get(`${pcm}/admin`, {headers:jsonHeaders})).json();
    const created = await page.request.post(`${pcm}/admin/config/data-sources/add`, {
        headers: jsonHeaders,
        data: {
            expectedRevision: (sourceState.config || sourceState).runtime.revision || 0,
            name: 'Browser diagnostic source',
            endpoint: 'https://browser-diagnostic.invalid/fhir',
            // A focused rerun must create a new identity rather than revive a removed registration.
            clientId: `browser-diagnostic-source-${Date.now()}`,
            generateCertificate: true,
            serverTrustMode: 'system-ca'
        }
    });
    const createdBody = await created.json();
    expect(created.status(), JSON.stringify(createdBody)).toBe(201);
    const source = createdBody.dataSource;
    expect(source.id).toBeTruthy();
    for (const suffix of ['client-bundle', 'client-bundle.zip']) {
        const bundle = await page.request.get(`${pcm}/admin/config/data-sources/${source.id}/${suffix}`);
        expect(bundle.ok(), suffix).toBeTruthy();
    }
    const diagnostic = await page.request.post(`${pcm}/admin/config/data-sources/${source.id}/test`, {
        headers: jsonHeaders,
        data: { timeoutMilliseconds: 250 }
    });
    expect(diagnostic.status()).toBe(502);
    const diagnosticBody = await diagnostic.json();
    expect(diagnosticBody.label).toMatch(/NOT A CONFORMANCE VERDICT/);
    expect(diagnosticBody.phases.at(-1).classification).toBe('dns');

    for (const target of inventory.servers) {
        const sourceId = initialStatus.config.healthOrganizations.find(ho => ho.id === target.id).dataSourceOrganization.id;
        await page.goto(adminUrl('sources', sourceId, 'data'));
        await expect(page.locator('input[type="file"][name="bundle"]')).toHaveCount(1);
        await expect(page.locator(`form[action="/admin/config/fhir-servers/${target.id}/bootstrap"]`)).toHaveCount(1);
    }
    await page.goto(adminUrl('security'));
    await expect(page.getByText(/AWS credential isolation.*always on/i).first()).toBeVisible();
    // R8 renewal is a passive instruction action; unsafe live regeneration still refuses.
    const beforeRenewal = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    await page.goto(adminUrl('certificates'));
    await expect(page.locator('form[action^="/admin/certs/regenerate"]')).toHaveCount(0);
    const renewalWrites = [];
    const observeRenewal = request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) renewalWrites.push(request.method()); };
    page.on('request', observeRenewal);
    await page.getByRole('button', { name: 'How to renew certificates', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Controlled certificate renewal' })).toContainText('No credentials were changed');
    await page.getByRole('button', { name: 'Close instructions', exact: true }).click();
    page.off('request', observeRenewal); expect(renewalWrites).toEqual([]);
    const refusedRenewal = await page.request.post(`${pcm}/admin/certs/regenerate`, { headers: jsonHeaders, data: {} });
    expect(refusedRenewal.status()).toBe(409);
    expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config).toEqual(beforeRenewal);
    for (const [area, selector] of [['logs','form[action="/admin/logs/clear"]'],
        ['maintenance','form[action="/admin/reset"]'], ['maintenance','form[action^="/admin/restore"]'], ['sources','form[action="/admin/config/data-sources/remove"]']]) {
        await page.goto(adminUrl(area, area === 'sources' ? source.id : '', area === 'sources' ? 'registration' : ''));
        const forms = page.locator(selector);
        const destructive = area === 'sources' ? forms.filter({ has: page.getByRole('button', { name: 'Remove source', exact: true }) }) : forms;
        await expect(destructive.first()).toHaveAttribute('data-confirm', /.+/);
    }
    await page.goto(adminUrl('maintenance'));
    await expect(page.locator('#admin-operation-state')).toHaveAttribute('aria-live', 'polite');

    for (const action of ['disable','remove']) {
        const state=await (await page.request.get(`${pcm}/admin`,{headers:jsonHeaders})).json();
        const removed=await page.request.post(`${pcm}/admin/config/data-sources/remove`,{headers:jsonHeaders,data:{id:source.id,action,expectedRevision:(state.config||state).runtime.revision||0}});
        expect(removed.ok(),await removed.text()).toBeTruthy();
    }
    // Preserve the real clinical audit records before testing the supported clear action.
    const exportedLogs = await page.request.get(`${pcm}/admin/logs/download`);
    expect(exportedLogs.ok()).toBeTruthy();
    await testInfo.attach('admin-logs-before-required-clear', {
        body: await exportedLogs.body(), contentType: 'application/json'
    });
    const cleared = await page.request.post(`${pcm}/admin/logs/clear`, { headers: jsonHeaders, data: {} });
    expect(cleared.ok(), await cleared.text()).toBeTruthy();
});

test('delayed import progress survives reload and separates response from verification @smoke', async ({ page }, testInfo) => {
    // The owned Admin HTML and controlled status routes work across all engines.
    const serverId = 'ho-a';
    const operationId = '00000000-0000-4000-8000-000000000003';
    const createdAt = new Date(Date.now() - 4000).toISOString();
    const waitingAt = new Date(Date.now() - 3000).toISOString();
    const deadlineAt = new Date(Date.now() + 30000).toISOString();
    const progressEvents = [
        { event: 'upload-received', at: createdAt },
        { event: 'bundle-check-started', at: createdAt },
        { event: 'bundle-check-complete', at: createdAt },
        { event: 'target-preflight-started', at: createdAt },
        { event: 'target-preflight-complete', at: waitingAt },
        { event: 'transaction-waiting', at: waitingAt }
    ];
    let phase = 'loading';
    let currentStage = 'transaction-waiting';
    let verifiedTypes = [];
    let responseAt;
    let deadline = deadlineAt;
    let observedAt;
    let failPoll = false;
    let submitted = false;
    const status = () => ({
        id: operationId, serverId, kind: 'import', phase,
        status: phase === 'succeeded' ? 'completed' : 'running',
        createdAt, observedAt: observedAt || new Date().toISOString(), bundleName: 'ho-a.source.transaction.json',
        entries: 12, bytes: 2048, verificationTypeTotal: 2, currentStage,
        stageTimestamps: { 'upload-received': createdAt, 'transaction-waiting': waitingAt,
            ...(responseAt ? { 'response-received': responseAt, 'transaction-accepted': responseAt,
                'verification-started': responseAt } : {}) },
        progressEvents, verifiedTypes, lastCompletedStage: phase === 'succeeded' ? 'completed' : 'target-preflight-complete',
        transactionDeadlineAt: deadline,
        deadlines: { verificationMs: 5000 },
        elapsedMilliseconds: phase === 'succeeded' ? 7000 : Date.now() - Date.parse(createdAt),
        stageElapsedMilliseconds: phase === 'succeeded' ? 0 : Date.now() - Date.parse(waitingAt),
        waitMilliseconds: (responseAt ? Date.parse(responseAt) : Date.now()) - Date.parse(waitingAt),
        ...(phase === 'succeeded' ? { completedAt: new Date(Date.parse(createdAt) + 7000).toISOString() } : {})
    });
    await page.route(`**/admin/api/data-operations/${operationId}`, async route => {
        if (failPoll) { failPoll = false; await route.fulfill({ status: 503, body: 'temporary status failure' }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status()) });
    });
    await page.route(`**/admin/api/fhir-servers/${serverId}/imports`, route => {
        submitted = true;
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(status()) });
    });
    await page.route('**/admin', async route => {
        const response = await route.fetch();
        const original = await response.text();
        const html = submitted ? original.replace(
            /(<section id="data-operation-ho-a"[^>]*data-operation-id=")[^"]*(")/,
            `$1${operationId}$2`
        ) : original;
        await route.fulfill({ response, body: html });
    });

    await page.goto(`${pcm}/admin`);
    await expect(page.getByRole('button', { name: 'Check bundle and import' }).first()).toBeVisible();
    await expect(page.getByText('Full FHIR profile validation is not performed.').first()).toBeVisible();
    const block = page.locator(`[data-managed-fhir-server="${serverId}"]`);
    const output = block.locator(`#data-operation-${serverId}`);
    await block.locator('input[type="file"]').setInputFiles({
        name: 'ho-a.source.transaction.json', mimeType: 'application/json', buffer: Buffer.from('{}')
    });
    await block.getByRole('button', { name: 'Check bundle and import' }).click();
    await expect(block.getByRole('link', { name: 'Inspect import diagnostics' }))
        .toHaveAttribute('href', new RegExp(`operationId=${operationId}`));
    await expect(output).toContainText('Waiting for HAPI transaction response');
    await expect(output).toContainText('latest deadline');
    await expect(output).toContainText('12 entries');
    await expect(output).not.toContainText('%');
    await output.locator('summary').click();
    await expect(output.locator('ol')).toBeVisible();
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-import-progress-waiting.png` });

    failPoll = true;
    await expect(output).toContainText('Status updates were interrupted', { timeout: 5000 });
    await expect(output).toContainText('Waiting for HAPI transaction response');
    await page.reload();
    await expect(output).toContainText('Waiting for HAPI transaction response');
    deadline = new Date(Date.now() - 1000).toISOString();
    await expect(output).toContainText('The response deadline passed. The import may still be running.');

    responseAt = new Date().toISOString();
    // The accepted response beat its deadline, then verification outlasted that deadline.
    deadline = new Date(Date.parse(responseAt) + 1000).toISOString();
    observedAt = new Date(Date.parse(responseAt) + 2000).toISOString();
    phase = 'verifying';
    currentStage = 'verification-started';
    verifiedTypes = [{ type: 'Patient', count: 12 }];
    progressEvents.push({ event: 'response-received', at: responseAt },
        { event: 'transaction-accepted', at: responseAt },
        { event: 'verification-started', at: responseAt },
        { event: 'type-verified', at: responseAt, type: 'Patient', count: 12 });
    await expect(output).toContainText('Post-load type checks 1/2');
    await output.locator('summary').click();
    await expect(output.locator('table')).toBeVisible();
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-import-progress-verifying.png` });
    await expect(output).toContainText('HAPI response received');
    await expect(output).toContainText('HAPI transaction response accepted');
    await expect(output).toContainText('Read-only verification · latest deadline');
    await expect(output).not.toContainText('response deadline passed');
    await expect(output).not.toContainText('Ask the local operator to check before recovery.');

    observedAt = new Date(Date.parse(responseAt) + 6000).toISOString();
    await expect(output).toContainText('read-only verification deadline passed');
    await expect(output).not.toContainText('response deadline passed');

    phase = 'succeeded';
    currentStage = 'completed';
    progressEvents.push({ event: 'inventory-publication-started', at: responseAt },
        { event: 'completed', at: responseAt });
    await expect(output).toContainText('Import complete. The saved data was checked');
    await expect(output.locator('details')).toHaveAttribute('open', '');
    await page.reload();
    await expect(output).toContainText('Import complete. The saved data was checked');
    await expect(output).toContainText('elapsed 0.12 minutes (7 seconds)');
});

test('Admin import diagnostics link opens bounded filters and preserves JSON export', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'focused Admin diagnostic view is checked in Chromium');
    const jsonHeaders = { Accept: 'application/json' };
    await page.goto(`${pcm}/admin`);
    await page.getByRole('link', { name: 'Browse import diagnostics' }).click();
    await expect(page.getByRole('heading', { name: 'Import diagnostics' })).toBeVisible();
    await expect(page.getByLabel('Operation ID')).toBeVisible();
    await expect(page.getByLabel('Target HO')).toBeVisible();
    await expect(page.getByLabel('Component')).toBeVisible();
    await expect(page.getByLabel('Stage')).toBeVisible();
    await expect(page.getByLabel('Severity')).toBeVisible();
    await expect(page.getByLabel('From time')).toBeVisible();
    await expect(page.getByLabel('Through time')).toBeVisible();
    await page.getByLabel('Target HO').fill('ho-a');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/target=ho-a/);
    await expect(page.getByRole('status')).toContainText('bytes read');
    const raw = await page.request.get(`${pcm}/admin/logs/download`, { headers: jsonHeaders });
    expect(raw.ok()).toBeTruthy();
    expect((await raw.json()).logs).toHaveProperty('ho-a-hapi');
});

test('Admin authentication never submits a password in a URL @smoke', async ({ page }) => {
    await page.goto(`${pcm}/admin`);
    if (await page.getByLabel('Admin password').count()) {
        await expect(page.locator('form[action="/admin/login"]')).toHaveAttribute('method', /post/i);
    }
    expect(page.url()).not.toContain('adminPassword=');
});

test('destructive operations require confirmation', async ({ page }) => {
    await page.goto(`${pcm}/admin`);
    const reset = page.locator('form[action="/admin/reset"]');
    await expect(reset).toHaveAttribute('data-confirm', /reset/i);
    let message = '';
    await Promise.all([
        page.waitForEvent('dialog').then(async confirmation => {
            message = confirmation.message();
            await confirmation.dismiss();
        }),
        reset.getByRole('button').click()
    ]);
    expect(message).toMatch(/reset/i);
    await expect(page).toHaveURL(/\/admin$/);
});

/** Probe only the selected disposable team's public source TLS listener. */
function gatewayTlsProbe(config, sourceIndex, identity, requestPath = '/healthz') {
    const url = new URL(config.publicBaseUrls.referenceDataSource);
    url.port = String(config.healthOrganizations[sourceIndex].gatewayPort);
    url.pathname = requestPath;
    url.search = '';
    return publicTlsProbe(config, url, identity);
}

/** Follow an advertised public diagnostic with the same explicit team trust role. */
function publicTlsProbe(config, url, identity) {
    const certificates = process.env.PCM_UI_CERTS_DIR || '/certs';
    const role = identity ? config.certificateRoles[identity].mtls : null;
    return new Promise(resolve => {
        const request = https.get(url, {
            ca: fs.readFileSync(path.join(certificates, config.certificates.rootCaCert)),
            ...(role ? { cert: fs.readFileSync(path.join(certificates, role.cert)), key: fs.readFileSync(path.join(certificates, role.key)) } : {}),
            timeout: 10000
        }, response => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode }));
        });
        request.on('timeout', () => request.destroy(new Error('gateway TLS probe timed out')));
        request.once('error', error => resolve({ error: error.code || error.message }));
    });
}

/** Distinguish a certificate rejection from an unavailable or failing gateway. */
function certificateRejected(result) {
    return result.status === 400 || /CERT|TLS|SSL|ECONNRESET|EPIPE/i.test(result.error || '');
}

// Mutations are serial and restore the original policy before later journeys.
test('simulation form applies preset defaults and preserves explicit all-off controls', async ({ page }) => {
    test.setTimeout(180000);
    const original = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    await page.goto(adminUrl('security'));
    if (original.conformance.preset === 'strict') {
        await expect(page.locator('#simulation-publicClientMtls')).toBeDisabled();
        await expect(page.locator('#simulation-publicClientMtls')).toBeChecked();
        await expect(page.locator('#simulation-oauthBearer, #simulation-smartScopes')).toHaveCount(0);
        const rejected = await page.request.post(`${pcm}/admin/config/simulation`, { headers: { Accept: 'application/json' },
            data: { preset: 'strict', controls: { publicClientMtls: false } } });
        expect(rejected.status()).toBe(400);
        expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config).toEqual(original);
        await expect.poll(async () => (await gatewayTlsProbe(original, 0)).status, { timeout: 30000 }).toBe(200);
        await expect.poll(async () => (await gatewayTlsProbe(original, 0, 'serviceProvider', '/fhir/Observation')).status, { timeout: 30000 }).toBe(401);
        await expect.poll(async () => certificateRejected(await gatewayTlsProbe(original, 0, 'untrustedClient', '/fhir/Observation')), { timeout: 30000 }).toBeTruthy();
        return;
    }
    const form = page.locator('[data-simulation-form]');
    const save = async () => {
        await form.getByRole('button', { name: /^Save (global|source) controls$/ }).click();
        expect(new URL(page.url()).pathname).toBe('/admin');
        expect(new URL(page.url()).searchParams.get('section')).toBe('security');
        return (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    };
    const defaults = async preset => {
        await form.locator('[name="preset"]').selectOption(preset);
        await form.getByRole('button', { name: 'Preview selected preset defaults', exact: true }).click();
        await form.getByRole('button', { name: 'Use previewed defaults', exact: true }).click();
    };
    try {
        for (const preset of ['connectathon-balanced', 'connectathon-easy', 'connectathon-mtls']) {
            await defaults(preset);
            const saved = await save(), expected = preset !== 'connectathon-easy';
            for (const [name, enabled] of Object.entries(saved.securitySimulation.global)) {
                expect(enabled, `${preset} ${name}`).toBe(name === 'publicClientMtls' ? preset === 'connectathon-mtls' : expected);
            }
            expect(saved.securitySimulation.perSource).toEqual({});
            await expect.poll(async () => (await gatewayTlsProbe(saved, 0, 'serviceProvider', '/fhir/Observation')).status, { timeout: 30000 }).toBe(401);
            await expect.poll(async () => (await gatewayTlsProbe(saved, 0)).status, { timeout: 30000 }).toBe(200);
            if (preset === 'connectathon-mtls') {
                await expect.poll(async () => (await gatewayTlsProbe(saved, 0, 'serviceProvider')).status, { timeout: 30000 }).toBe(200);
                await expect.poll(async () => certificateRejected(await gatewayTlsProbe(saved, 0, 'untrustedClient')), { timeout: 30000 }).toBeTruthy();
            }
        }
        await defaults('connectathon-easy');
        await form.locator('[name="control.publicClientMtls"]').check();
        const certificateOnly = await save();
        expect(certificateOnly.securitySimulation.global.publicClientMtls).toBe(true);
        expect(certificateOnly.securitySimulation.global).not.toHaveProperty('oauthBearer');
        await expect(page.locator('#simulation-oauthBearer, #simulation-smartScopes')).toHaveCount(0);
        for (const participant of [null, 'serviceProvider']) await expect.poll(async () => (await gatewayTlsProbe(certificateOnly, 0, participant, '/fhir/Observation')).status, { timeout: 30000 }).toBe(401);
        await expect.poll(async () => certificateRejected(await gatewayTlsProbe(certificateOnly, 0, 'untrustedClient', '/fhir/Observation')), { timeout: 30000 }).toBeTruthy();
        const selected = original.healthOrganizations[0];
        await page.goto(adminUrl('security', selected.dataSourceOrganization.id));
        await form.locator('[name="control.publicClientMtls"]').selectOption('false');
        const named = await save();
        expect(named.securitySimulation.perSource[selected.id]).toEqual({ publicClientMtls: false });
        await expect(form.locator('[name="control.publicClientMtls"]')).toHaveValue('false');
        for (const index of [0, 1]) await expect.poll(async () => (await gatewayTlsProbe(named, index, null, '/fhir/Observation')).status, { timeout: 30000 }).toBe(401);
        await expect.poll(async () => (await gatewayTlsProbe(named, 0, 'untrustedClient', '/fhir/Observation')).status, { timeout: 30000 }).toBe(401);
        await expect.poll(async () => certificateRejected(await gatewayTlsProbe(named, 1, 'untrustedClient', '/fhir/Observation')), { timeout: 30000 }).toBeTruthy();
        await page.goto(adminUrl('security'));
        await defaults('connectathon-balanced');
        for (const input of await form.locator('input[type="checkbox"]').all()) await input.uncheck();
        const off = await save();
        expect(Object.values(off.securitySimulation.global).every(value => value === false)).toBeTruthy();
        expect(off.securitySimulation.perSource).toEqual({});
        await expect(page.getByText('Global source gateway authentication', { exact: true })).toBeVisible();
        await expect.poll(async () => (await gatewayTlsProbe(off, 0, null, '/fhir/Observation')).status, { timeout: 30000 }).toBe(401);
        const forged = await page.request.post(`${pcm}/admin/config/simulation`, { headers: { Accept: 'application/json' },
            data: { preset: 'connectathon-balanced', completeControls: 'true', 'control.smartScopes': 'true', perSourceJson: '{}' } });
        expect(forged.status()).toBe(400);
        expect((await forged.json()).error).toMatch(/Unknown security simulation control|not allowed/i);
        expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config).toEqual(off);
    } finally {
        const restored = await page.request.post(`${pcm}/admin/config/simulation`, { headers: { Accept: 'application/json' }, data: {
            preset: original.conformance.preset, controls: original.securitySimulation.global, perSource: original.securitySimulation.perSource
        } });
        expect(restored.ok(), await restored.text()).toBeTruthy();
    }
});


test('cross-mode simulation requests require recreation without changing saved state', async ({ page }) => {
    const before = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    const response = await page.request.post(`${pcm}/admin/config/simulation`, {
        headers: { Accept: 'application/json' }, data: { preset: before.conformance.mode === 'strict' ? 'connectathon-easy' : 'strict' }
    });
    expect(response.status()).toBe(409);
    const result = await response.json();
    expect(result.code).toBe('restart-required');
    expect(result.nextAction).toContain('reconfigure-local-team.js');
    expect((await (await page.request.get(`${pcm}/admin/status`)).json()).config).toEqual(before);
});

test('deployment navigation and both generated API documents work without hydration errors @smoke', async ({ page }) => {
    test.setTimeout(180000);
    const status = await (await page.request.get(`${pcm}/admin/status`)).json();
    await page.goto(`${pcm}/admin`);
    const disabled = status.config.publicBaseUrls.teamDataSource;
    if (status.config.organizations.teamDataSource.enabled === false && disabled) {
        await expect(page.locator(`a[href="${disabled}"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-endpoint]').first()).toBeVisible();
    const diagnosticLinks = await page.locator('[data-endpoint] a')
        .evaluateAll(links => [...new Set(links.map(link => link.href))]);
    expect(diagnosticLinks.length).toBeGreaterThanOrEqual(7);
    for (const url of diagnosticLinks) {
        if (url.startsWith('https:')) {
            expect(await publicTlsProbe(status.config, url, 'serviceProvider'), url).toMatchObject({ status: 200 });
        } else {
            expect((await page.request.get(url)).ok(), url).toBeTruthy();
        }
    }
    await page.goto(`${sp}/logs-view`);
    const navigation = page.getByRole('navigation', { name: 'Sandbox pages' });
    expect(await navigation.locator('a').allTextContents()).toEqual(['Doctor', 'Consents', 'Services', 'Admin', 'Local logs']);
    const destinations = await navigation.locator('a').evaluateAll(links => links.map(link => link.href));
    expect(destinations).toHaveLength(5);
    for (const url of destinations) {
        expect([new URL(pcm).origin, new URL(sp).origin]).toContain(new URL(url).origin);
        const response = await page.request.get(url);
        expect(response.ok(), url).toBeTruthy();
    }
    for (const route of ['/docs/api', '/docs/admin-api']) {
        const doc = await page.context().newPage();
        const errors = [];
        doc.on('pageerror', error => errors.push(error.message));
        doc.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
        try {
            await doc.goto(`${pcm}${route}`, { waitUntil: 'networkidle' });
            const content = doc.frameLocator('iframe');
            await expect(content.locator('#redoc h1')).toBeVisible();
            const section = content.locator('[role="menuitem"]').first();
            // The pinned renderer collapses its navigation on mobile and exposes
            // an unlabelled two-arrow toggle; avoid generated CSS class hashes.
            const mobileMenu = content.locator('#redoc .redoc-wrap > div:has(> div > svg + svg)');
            const collapsed = !await section.isVisible();
            if (collapsed) {
                await expect(mobileMenu).toHaveCount(1);
                await expect(mobileMenu).toBeVisible();
                // The real fixed toggle sits at the iframe viewport's bottom.
                // Scroll the owning page past its wrapper header before a native click.
                await doc.locator('iframe').evaluate(frame => frame.scrollIntoView({ block: 'end', inline: 'nearest' }));
                await mobileMenu.click();
                await expect(section).toBeVisible();
            }
            await section.click();
            if (collapsed && await section.isVisible()) await mobileMenu.click();
            const download = doc.waitForEvent('download');
            await content.locator('a[download]').first().click();
            expect((await download).suggestedFilename()).toMatch(/openapi.*json|openapi.*yaml/);
            expect(errors).toEqual([]);
        } finally { await doc.close(); }
    }
});

test('all three Admin upload forms publish verified Patient inventories', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop' || process.env.PCM_UI_REQUIRE_CLINICAL !== 'true', 'full populated desktop qualification');
    test.setTimeout(360000);
    const inventory = await (await page.request.get(`${pcm}/admin/api/fhir-servers`)).json();
    for (const server of inventory.servers) {
        const currentConfig = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
        await page.goto(adminUrl('sources', currentConfig.healthOrganizations.find(ho => ho.id === server.id).dataSourceOrganization.id, 'data'));
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const refreshButton = page.locator('[data-admin-refresh]');
        const refreshStatus = page.locator('[data-admin-refresh-status]');
        await expect(refreshButton).toBeEnabled();
        const retainedAttention = (await refreshStatus.textContent()).includes('needs attention');
        const section = page.locator(`[data-managed-fhir-server="${server.id}"]`);
        const form = section.locator('form[action$="/imports"]');
        const file = `/ci/${server.id}.source.transaction.json`;
        const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
        const expectedSource = bundle.entry[0].resource.meta.tag.find(tag => tag.system === 'urn:hdp-test-bundle:synthetic-source')?.code;
        expect(expectedSource, 'CI source tag prerequisite').toBeTruthy();
        expect(server.bootstrap.expectedSource, 'configure the target source mapping before source-bound import qualification').toBe(expectedSource);
        const expectedCounts = bundle.entry.reduce((counts, entry) => {
            counts[entry.resource.resourceType] = (counts[entry.resource.resourceType] || 0) + 1;
            return counts;
        }, {});
        await form.locator('input[type="file"]').setInputFiles(file);
        await form.locator('[name="replace"]').check();
        const accepted = page.waitForResponse(response => response.url().endsWith(`/fhir-servers/${server.id}/imports`) && response.request().method() === 'POST');
        // A prior refused request deliberately keeps feedback on screen. Its
        // later successful neighbour needs explicit refresh rather than erasing it.
        const refreshed = retainedAttention ? null : page.waitForEvent('load', { timeout: 120000 });
        await form.getByRole('button', { name: 'Check bundle and import', exact: true }).click();
        const response = await accepted;
        expect(response.status()).toBe(202);
        const operation = await response.json();
        await expect.poll(async () => (await (await page.request.get(`${pcm}/admin/api/data-operations/${operation.id}`)).json()).phase,
            { timeout: 120000 }).toBe('succeeded');
        await expect(section.locator(`#data-operation-${server.id}`)).toContainText('Import complete.', { timeout: 15000 });
        if (retainedAttention) {
            await expect(refreshStatus).toContainText('needs attention');
            await expect(refreshButton).toBeEnabled();
            const explicitRefresh = page.waitForEvent('load', { timeout: 120000 });
            await refreshButton.click();
            await explicitRefresh;
        } else await refreshed;
        const state = await (await page.request.get(`${pcm}/admin/api/fhir-servers/${server.id}/data`)).json();
        expect(state.state).toBe('loaded');
        expect(state.actualResourceCount).toBe(bundle.entry.length);
        for (const [type, count] of Object.entries(expectedCounts)) expect(state.actualCounts[type]).toBe(count);
        const patients = await (await page.request.get(`${pcm}/admin/api/patients`)).json();
        const fixturePatient = bundle.entry.find(entry => entry.resource.resourceType === 'Patient').resource.identifier[0];
        expect(patients.patients.some(patient => patient.idSystem === fixturePatient.system && patient.idValue === fixturePatient.value
            && patient.sources.some(source => source.serverId === server.id))).toBeTruthy();
        // A non-replacing same-hash POST must not silently duplicate the verified data.
        const duplicate = await page.request.post(`${pcm}/admin/api/fhir-servers/${server.id}/imports`, { multipart: {
            bundle: { name: `${server.id}.source.transaction.json`, mimeType: 'application/json', buffer: fs.readFileSync(file) }
        } });
        expect(duplicate.status()).toBe(409);
        const unchanged = await (await page.request.get(`${pcm}/admin/api/fhir-servers/${server.id}/data`)).json();
        expect(unchanged.actualResourceCount).toBe(bundle.entry.length);
        await page.reload();
        await expect(page.locator(`#data-operation-${server.id}`)).toContainText('The import did not finish.');
        await expect(page.locator('[data-admin-refresh-status]')).toContainText('needs attention');
        await expect(page.locator('[data-admin-refresh]')).toBeEnabled();
    }
    const latestConfig = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    await page.goto(adminUrl('sources', latestConfig.healthOrganizations.find(ho => ho.id === 'ho-a').dataSourceOrganization.id, 'data'));
    const form = page.locator('[data-managed-fhir-server="ho-a"] form[action$="/imports"]');
    await form.locator('input[type="file"]').setInputFiles({ name: 'invalid.source.transaction.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
    const invalidResponse = page.waitForResponse(response => response.url().endsWith('/fhir-servers/ho-a/imports') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Check bundle and import', exact: true }).click();
    expect((await invalidResponse).status()).toBe(400);
    await expect(page.locator('#data-operation-ho-a')).toContainText('The request could not be completed.');
    await expect(page.locator('#data-operation-ho-a')).toHaveAttribute('data-help-key', 'admin.operation-uncertain');
    await expect(page.locator('#data-operation-ho-a details pre')).toContainText(/JSON/i);
    await page.locator('#data-operation-ho-a').focus();
    await expect(page.getByRole('tooltip')).toContainText('do not upload it again');
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-invalid-json-help.png` });
    await page.keyboard.press('Escape');
    let refused = await (await page.request.get(`${pcm}/admin/api/fhir-servers/ho-a/data`)).json();
    expect(refused.lastOperation.submittedOutcome).toBe('not-submitted');
    expect(refused.lastOperation.mutationSubmitted).toBeFalsy();
    expect(refused.lastOperation.needsReconciliation).toBe(false);
    await expect(page.locator('[data-managed-fhir-server="ho-a"] [data-recovery-controls]')).toHaveCount(0);
    // Reach source validation on the already populated target, past its replace guard.
    await form.locator('[name="replace"]').check();
    await form.locator('input[type="file"]').setInputFiles('/ci/ho-b.source.transaction.json');
    const wrongSourceResponse = page.waitForResponse(response => response.url().endsWith('/fhir-servers/ho-a/imports') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Check bundle and import', exact: true }).click();
    expect((await wrongSourceResponse).status()).toBe(400);
    await expect(page.locator('#data-operation-ho-a')).toContainText('The request could not be completed.');
    await page.locator('#data-operation-ho-a summary').click();
    await expect(page.locator('#data-operation-ho-a details pre')).toContainText(/source/i);
    await expect(page.locator('#data-operation-ho-a details pre')).toContainText('ho-a');
    await expect(page.locator('#data-operation-ho-a details pre')).toContainText('ho-b');
    refused = await (await page.request.get(`${pcm}/admin/api/fhir-servers/ho-a/data`)).json();
    expect(refused.lastOperation.submittedOutcome).toBe('not-submitted');
    expect(refused.lastOperation.mutationSubmitted).toBeFalsy();
    expect(refused.lastOperation.needsReconciliation).toBe(false);
    await expect(page.locator('[data-managed-fhir-server="ho-a"] [data-recovery-controls]')).toHaveCount(0);
    await page.screenshot({ path: `/artifacts/${testInfo.project.name}-wrong-source-before-submission.png` });
    // The operator can correct a known refusal directly; no recovery/reset of
    // an uncertain operation is required because no transaction was submitted.
    await form.locator('input[type="file"]').setInputFiles('/ci/ho-a.source.transaction.json');
    const retried = page.waitForResponse(response => response.url().endsWith('/fhir-servers/ho-a/imports') && response.request().method() === 'POST');
    await form.getByRole('button', { name: 'Check bundle and import', exact: true }).click();
    const retry = await retried; expect(retry.status()).toBe(202);
    const retryOperation = await retry.json();
    await expect.poll(async () => (await (await page.request.get(`${pcm}/admin/api/data-operations/${retryOperation.id}`)).json()).phase,
        { timeout: 120000 }).toBe('succeeded');
    await expect(page.locator('#data-operation-ho-a')).toContainText('Import complete.');
});

/** Exact-count UI distinguishes a pending/cancelled/failed read from a verified result. */
test('Admin target counts preserve pending cancellation errors and exact results', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop' || Boolean(process.env.PCM_OPS_FIXTURE_URL),
        'exact counts require a populated live HAPI team and run once per preset');
    test.setTimeout(210000);
    const currentConfig = (await (await page.request.get(`${pcm}/admin/status`)).json()).config;
    await page.goto(adminUrl('sources', currentConfig.healthOrganizations.find(ho => ho.id === 'ho-a').dataSourceOrganization.id, 'data'));
    const card = page.locator('[data-managed-fhir-server="ho-a"]');
    const link = card.locator('[data-target-counts]');
    const output = card.locator('[data-target-count-output]');
    const endpoint = `${pcm}/admin/api/fhir-servers/ho-a/data`;
    let pending;
    await page.route(endpoint, route => { pending = route; });
    try {
        await link.click();
        await expect(output).toContainText('Checking exact target counts');
        await expect(output).toContainText('2.92 minutes (175 seconds) server deadline');
        await expect.poll(() => Boolean(pending)).toBeTruthy();
        await link.click();
        await expect(output).toContainText('request cancelled or timed out');
        await expect(output).toContainText('No zero count or empty state is inferred');
    } finally {
        if (pending) await pending.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"cancelled fixture"}' }).catch(() => {});
        await page.unroute(endpoint);
    }
    await page.route(endpoint, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"count qualification failure"}' }));
    await link.click();
    await expect(output).toContainText('count qualification failure');
    await expect(output).toContainText('No zero count or empty state is inferred');
    await page.unroute(endpoint);
    const actualResponse = page.waitForResponse(endpoint, { timeout: 180000 });
    await link.click();
    const response = await actualResponse;
    expect(response.ok()).toBeTruthy();
    const actual = await response.json();
    if (process.env.PCM_UI_REQUIRE_CLINICAL === 'true') expect(actual.actualResourceCount).toBeGreaterThan(0);
    await expect(output).toContainText(`${actual.actualResourceCount} current resources`);
    for (const [type, count] of Object.entries(actual.actualCounts)) {
        const row = output.locator('tbody tr').filter({ has: page.getByRole('cell', { name: type, exact: true }) });
        await expect(row.getByRole('cell').last()).toHaveText(String(count));
    }
    await expect(output).not.toContainText('unavailable');
});
