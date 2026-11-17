'use strict';
/** Running-UI cognitive/interaction probes. Execute with run-ui-walkthrough.js on an explicitly disposable team. */
const fs = require('node:fs');
const { chromium, expect } = require('/suite/node_modules/@playwright/test');
const AxeBuilder = require('/suite/node_modules/@axe-core/playwright').default;
const config = JSON.parse(fs.readFileSync('/config.json'));
const sp = config.publicBaseUrls.spClient, pcm = config.publicBaseUrls.pcmUi;
const source = config.publicBaseUrls.healthOrganizations['ho-a'];
const sourceId = id => config.healthOrganizations.find(source => source.id === id).dataSourceOrganization.id;
const selectSource = (card, id) => card.locator('[data-source-choice]').selectOption(config.healthOrganizations.find(source => source.id === id).endpoint);
/** Open deliberately supported technical edits before changing a diagnostic request. */
async function openOverrides(card) { const detail = card.getByText('Technical request overrides', { exact: true }).locator('..'); if (!await detail.evaluate(node => node.open)) await detail.locator(':scope > summary').click(); }
const facts = { kind: 'real-HAPI-running-UI', projects: [], observations: [] };
/** Assert a condition with a useful task-oriented failure. */
function check(value, message) { if (!value) throw new Error(message); }
/** Capture an actual ready-content screen and all accessibility dispositions. */
async function screen(page, name) {
    await page.screenshot({ path: `/artifacts/${name}.png`, fullPage: false });
    const result = await new AxeBuilder({ page }).analyze();
    const serious = result.violations.filter(value => ['serious', 'critical'].includes(value.impact));
    check(!serious.length, `${name}: blocking accessibility ${JSON.stringify(serious)}`);
    facts.observations.push({ screen: name, violations: result.violations.map(value => ({ id: value.id, impact: value.impact, nodes: value.nodes.map(node => node.target) })) });
}
/** Synchronize a real owned-source outage with the host runner, never a browser network mock. */
async function sourceState(page, state, label) {
    const request = `/artifacts/${label}-${state}.request`, done = `/artifacts/${label}-${state}.done`;
    fs.writeFileSync(request, state);
    await expect.poll(() => fs.existsSync(done), { timeout: 60000 }).toBe(true);
}
/** Establish only the selected PCM Admin cookie; never send its secret to Doctor or sources. */
async function loginAdmin(page) {
    check(Boolean(process.env.PCM_UI_ADMIN_PASSWORD), 'Explicit selected-team Admin login fixture is required');
    const response = await page.request.post(`${pcm}/admin/login`, { form: { adminPassword: process.env.PCM_UI_ADMIN_PASSWORD } });
    check(response.ok(), 'Selected-team Admin login rejected');
}
/** Import via the actual Admin file input and wait for persisted verification across a reload. */
async function importBundle(page, file, label) {
    await page.goto(`${pcm}/admin`);
    const card = page.locator('[data-managed-fhir-server="ho-a"]');
    await card.locator('#bundle-ho-a').setInputFiles(file);
    await card.locator('#replace-ho-a').check();
    await card.getByRole('button', { name: 'Check bundle and import', exact: true }).click();
    await expect(card.locator('#data-operation-ho-a')).toContainText(/Import|Checking|Waiting|accepted|verified/i);
    await page.reload();
    await expect(card.locator('#data-operation-ho-a')).toContainText('Import complete', { timeout: 120000 });
    await card.locator('#data-operation-ho-a').scrollIntoViewIfNeeded();
    await screen(page, `${label}-admin-import-ready`);
}
(async () => {
    const browser = await chromium.launch();
    let original;
    try {
        const setupContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const setup = await setupContext.newPage();
        await loginAdmin(setup);
        original = JSON.parse(fs.readFileSync('/original.json'));
        await importBundle(setup, '/preview.source.transaction.json', 'desktop');
        const changed = await setup.request.post(`${pcm}/admin/config/simulation`, { data: { preset: 'connectathon-balanced' } });
        check(changed.ok(), `Enabled-policy setup rejected: ${await changed.text()}`);
        await setupContext.close();
        for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
            const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
            const page = await context.newPage();
            await loginAdmin(page);
            await page.request.post(`${sp}/reset`);
            await page.goto(sp);
            await expect(page.getByRole('button', { name: 'Create consent request', exact: true })).toBeVisible();
            await screen(page, `${label}-doctor-start`);
            await page.getByRole('button', { name: 'Choose patient', exact: true }).click();
            await page.locator('#configured-patient').selectOption('http://fhir.health.gov.il/identifier/il-national-id|000000018');
            await page.locator('#service-id').selectOption(await page.locator('#service-id option').filter({ hasText: 'Laboratory follow-up' }).getAttribute('value'));
            await page.getByRole('button', { name: 'Create consent request', exact: true }).click();
            await expect(page.getByText(/Consent request created\./)).toBeVisible();
            const id = await page.locator('.card:has([data-help-key="doctor.consent-card"])').last().locator('input[name="consentId"]').inputValue();
            const card = page.locator(`.card:has(input[name="consentId"][value="${id}"])`);
            await openOverrides(card); await card.locator('[name="endpointUrl"]').fill(source);
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(card.locator('[data-help-key="doctor.card-error"]')).toContainText(/Awaiting approval|Denied/);
            await expect(card.locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
            await card.locator('[data-help-key="doctor.card-error"]').scrollIntoViewIfNeeded();
            await screen(page, `${label}-unapproved-denied`);
            await page.goto(`${pcm}/ui`);
            const review = page.locator(`a[href="/ui/approve/${id}"]`);
            await review.scrollIntoViewIfNeeded();
            check(await review.isVisible(), 'The next Consent action must be visible without horizontal panning');
            await screen(page, `${label}-consent-registry`);
            await review.click();
            for (const choice of await page.locator('input[name="sources"]').all()) await choice.uncheck();
            await page.locator(`input[name="sources"][value="${sourceId('ho-a')}"]`).check();
            await page.locator(`input[name="sources"][value="${sourceId('ho-b')}"]`).check();
            await page.locator('#scope-service-provided').check();
            await page.getByRole('button', { name: 'Approve request', exact: true }).click();
            await page.goto(`${pcm}/ui/approve/${id}`);
            await expect(page.locator('[data-consent-status]')).toContainText('PCM records this consent as active');
            await screen(page, `${label}-consent-approved`);
            await page.goto(sp);
            await card.locator('[formaction="/discover"]').click();
            await selectSource(card, 'ho-b');
            await openOverrides(card); await card.locator('[name="requestedScope"]').fill('patient/DiagnosticReport.rs');
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(card.locator('[aria-label="Fetched FHIR data"]')).toContainText('Successful empty first page');
            await screen(page, `${label}-successful-empty`);
            await selectSource(card, 'ho-a');
            await openOverrides(card); await card.locator('[name="requestedScope"]').fill('patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs');
            await card.locator('[formaction="/fetch-data"]').click();
            const preview = card.locator('[aria-label="Fetched FHIR data"]');
            await expect(preview).toContainText('Up to 10');
            const data = JSON.parse(await preview.locator('pre').textContent());
            check(data.preview.types.find(type => type.type === 'Observation')?.count === 10, 'Actual >10 Observation matches must be limited to ten');
            check(data.preview.types.filter(type => type.count > 0).length >= 3, 'Actual HAPI preview must include multiple matching resource types');
            check(data.preview.types.find(type => type.type === 'Observation')?.boundary === 'more', 'Actual HAPI must indicate omitted Observation matches');
            await preview.scrollIntoViewIfNeeded();
            await screen(page, `${label}-bounded-preview`);
            facts.projects.push({ label, viewport, consentId: id, preview: data.preview });
            await openOverrides(card); await card.locator('[name="requestedScope"]').fill('patient/Condition.rs');
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(card.locator('[data-help-key="doctor.card-error"]')).toContainText(/Denied/);
            await card.locator('[data-help-key="doctor.card-error"]').scrollIntoViewIfNeeded();
            await screen(page, `${label}-scope-denied`);
            await openOverrides(card); await card.locator('[name="requestedScope"]').fill('patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs');
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(preview).toBeVisible();
            // A different tab must clear the already-visible result immediately.
            const other = await context.newPage(); await other.goto(sp);
            await other.getByRole('button', { name: 'Enter or edit identifier', exact: true }).click(); await other.locator('#patient-id').fill('000000026');
            await expect(preview).toHaveCount(0);
            const savedSelection = other.waitForResponse(response => response.url().endsWith('/selection') && response.request().postDataJSON().patientId === '000000018');
            await other.getByRole('button', { name: 'Choose patient', exact: true }).click();
            await other.locator('#configured-patient').selectOption('http://fhir.health.gov.il/identifier/il-national-id|000000018');
            await savedSelection;
            await other.close(); await page.reload();
            await expect(card.locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
            await card.locator('[formaction="/discover"]').click();
            await selectSource(card, 'ho-a');
            await sourceState(page, 'stop', label);
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(card.locator('[data-help-key="doctor.card-error"]')).toContainText(/Unavailable|failed/i);
            await card.locator('[data-help-key="doctor.card-error"]').scrollIntoViewIfNeeded();
            await screen(page, `${label}-source-unavailable`);
            await sourceState(page, 'start', label);
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(card.locator('[aria-label="Fetched FHIR data"]')).toBeVisible();
            await screen(page, `${label}-source-recovered`);
            await page.getByRole('checkbox', { name: 'Explain this page' }).check();
            await page.locator('#patient-id').focus();
            await expect(page.getByRole('tooltip')).toContainText('national identifier');
            await page.keyboard.press('Escape');
            await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
            await page.locator('[data-help-key="common.nav-consents"]').click();
            await page.goBack(); await page.goForward();
            await expect(page).toHaveURL(/\/ui$/);
            await page.goto(`${pcm}/ui/approve/${id}`);
            page.once('dialog', dialog => dialog.dismiss());
            await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).click();
            await expect(page.locator('[data-consent-status]')).toContainText('Active');
            page.once('dialog', dialog => dialog.accept());
            await page.getByRole('button', { name: 'Permanently cancel consent', exact: true }).click();
            await expect(page.locator('[data-consent-status]')).toContainText('Service Provider cancelled');
            await screen(page, `${label}-consent-cancelled`);
            await page.goto(sp); await card.locator('[formaction="/discover"]').click();
            await expect(card.locator('[aria-label="Fetched FHIR data"]')).toHaveCount(0);
            await openOverrides(card); await card.locator('[name="endpointUrl"]').fill(source);
            await card.locator('[formaction="/fetch-data"]').click();
            await expect(card.locator('[data-help-key="doctor.card-error"]')).toContainText(/Denied/);
            await card.locator('[data-help-key="doctor.card-error"]').scrollIntoViewIfNeeded();
            await screen(page, `${label}-revoked-denied`);
            await page.goto(`${pcm}/logs-view`);
            await expect(page.locator('.log-row').first()).toBeVisible();
            await page.locator('.log-row').first().click();
            await expect(page.locator('#details-pane pre[data-help-key="logs.payload"]')).toBeVisible();
            await expect(page.locator('#event-metadata')).not.toContainText('Loading event metadata');
            await screen(page, `${label}-logs-investigation`);
            await page.setViewportSize({ width: 320, height: 640 });
            await page.goto(sp);
            check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Narrow Doctor layout must not overflow');
            await page.evaluate(() => { document.documentElement.style.zoom = '200%'; });
            await screen(page, `${label}-zoom`);
            await context.close();
        }
        const cleanupContext = await browser.newContext({ ignoreHTTPSErrors: true });
        const cleanup = await cleanupContext.newPage();
        await loginAdmin(cleanup);
        const before = await (await cleanup.request.get(`${pcm}/admin/api/fhir-servers/ho-b/data`)).json();
        await cleanup.goto(`${pcm}/admin`);
        const target = cleanup.locator('[data-managed-fhir-server="ho-a"]');
        await target.locator('#delete-ho-a').check();
        cleanup.once('dialog', dialog => dialog.dismiss());
        await target.getByRole('button', { name: 'Delete all data', exact: true }).click();
        await expect(target.locator('#delete-ho-a')).not.toBeChecked();
        await target.locator('#delete-ho-a').check();
        cleanup.once('dialog', dialog => dialog.accept());
        const resetReload = cleanup.waitForEvent('framenavigated', frame => frame === cleanup.mainFrame());
        await target.getByRole('button', { name: 'Delete all data', exact: true }).click();
        await expect(target.locator('#data-delete-ho-a')).toContainText('All data and saved versions were deleted', { timeout: 120000 });
        await resetReload;
        await cleanup.waitForLoadState('networkidle');
        await expect(target.locator('#data-delete-ho-a')).toContainText('All data and saved versions were deleted');
        const after = await (await cleanup.request.get(`${pcm}/admin/api/fhir-servers/ho-b/data`)).json();
        check(JSON.stringify(before.counts) === JSON.stringify(after.counts), 'Reset must preserve the other source');
        await screen(cleanup, 'desktop-target-reset');
        await importBundle(cleanup, '/ci/ho-a.source.transaction.json', 'desktop-restored-ci');
        const restored = await cleanup.request.post(`${pcm}/admin/config/simulation`, { data: { preset: original.conformance.preset, controls: original.securitySimulation.global, perSource: original.securitySimulation.perSource } });
        check(restored.ok(), `Transport-profile restoration rejected: ${await restored.text()}`);
        await cleanupContext.close();
        facts.status = 'pass';
    } finally {
        fs.writeFileSync('/artifacts/walkthrough.json', JSON.stringify(facts, null, 2));
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
