'use strict';
/** Real service-grouped provider journeys use owned PCM OAuth/FHIR, private commands and mounted assets. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const lifecycle = require(path.join(root, 'src/pcm-core/src/fhir/healthcare-service-lifecycle'));
const commands = require(path.join(root, 'src/pcm-core/src/sandbox-service-command'));
const model = require(path.join(root, 'src/pcm-core/src/services-admin-model'));
let fixture, setup, zero;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/services-fixture')).startServicesFixture('connectathon-mtls', { browserBase: '/directory' }); });
test.afterAll(async () => { await fixture?.close(); });
/** Provider identity is real persisted FHIR; missing credentials are deliberate and never borrowed. */
function extraProvider(id) {
    const owner = fixture.store.get('Organization', fixture.config.organizations.serviceProvider.id);
    return fixture.store.add({ ...owner, id, name: `Directory provider ${id}`, identifier: [{ ...owner.identifier[0], value: `PCM-${id}` }] });
}
/** Fixture setup uses the same existing private command, preserving its operational prerequisites. */
function apply(id, action) {
    return commands.applyServiceCommand({ ...fixture, id, action, expectedVersion: fixture.store.get('HealthcareService', id).meta.versionId, operator: 'owned-browser', audit: event => fixture.events.push(event) });
}
test.beforeEach(() => {
    setup = require(path.join(root, 'test-support/services-list-fixture')).installServicesListFixture(fixture);
    extraProvider('registered-third');
    zero = model.createCatalog({ ...fixture, definition: { ...require(path.join(root, 'src/pcm-core/src/service-templates')).loadTemplates()[0].definition, name: 'Zero-provider directory service' }, expectedRevision: fixture.store.privateState.revision, operator: 'owned-browser', audit() {} });
    apply(zero.id, 'activate');
});
test.afterEach(() => { setup.restore(); });

/** Native touch on mobile and ordinary keyboard-capable desktop share exact mounted routes. */
async function open(browser, info, target = zero.id) {
    const mobile = info.project.name.includes('mobile');
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, hasTouch: mobile, isMobile: mobile });
    await context.addCookies([{ name: 'ownedServicesLogin', value: 'yes', url: fixture.base }]);
    const page = await context.newPage(), errors = [], traffic = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/admin/services')) traffic.push({ method: response.request().method(), url: response.url(), status: response.status() }); });
    await page.goto(`${fixture.base}/admin/services?view=assignments&target=${target}`);
    const click = locator => mobile ? locator.tap() : locator.click();
    return { page, context, click, mobile, errors, traffic };
}
/** Provider rows remain inside their named service; no global acting identity exists. */
const group = (page, id) => page.locator(`[data-service-group="${id}"]`);
const pair = (page, id, provider) => group(page, id).locator(`[data-provider-pair="${provider}"]`);
const record = (page, id) => page.locator(`[data-services-fragment="list"] [data-service-id="${id}"]`);
async function ownerAction(page, click, id, name, accept = true) {
    page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
    await click(record(page, id).locator('[data-service-status-form]').getByRole('button', { name, exact: true }));
}
async function activate(page, click, id) {
    await click(record(page, id).locator('.services-admin-actions > summary'));
    page.once('dialog', dialog => dialog.accept()); await click(record(page, id).getByRole('button', { name: 'Activate', exact: true }));
    await expect(record(page, id)).toContainText('Connected');
}

 test('DIRECTORY every provider, explicit pending activation, ordinary Pause/Resume/Disconnect/reconnect/withdraw and responsive grouping', async ({ browser }, info) => {
    test.setTimeout(120000);
    const { page, context, click, mobile, errors, traffic } = await open(browser, info);
    try {
        const a = fixture.config.organizations.serviceProvider.id, b = fixture.config.organizations.hospitalBServiceProvider.id;
        expect(await page.locator('[data-service-group]').count()).toBeGreaterThanOrEqual(6);
        await expect(page.locator('#service-provider')).toHaveCount(0);
        await expect(group(page, zero.id)).toContainText('No providers connected');
        await expect(group(page, zero.id).locator('[data-provider-pair]')).toHaveCount(3);
        await expect(pair(page, zero.id, 'registered-third').getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
        await expect(pair(page, zero.id, 'registered-third')).toContainText('No unambiguous configured provider credentials');
        await click(page.locator('[data-service-new]')); const draft = page.locator('[data-service-create]');
        await draft.locator('[name="name"]').fill('Retained while managing multiple providers'); await click(page.locator('[data-service-cancel]'));
        const start = fixture.requests.length;
        for (const provider of [a, b]) {
            await click(pair(page, zero.id, provider).getByRole('button', { name: 'Connect', exact: true }));
            await expect(pair(page, zero.id, provider)).toContainText('Pending — waiting for activation');
            const pending = fixture.store.getAll('HealthcareService').find(item => lifecycle.basedOnId(item) === zero.id && lifecycle.ownerId(item) === provider && lifecycle.businessStatus(item) === 'pending');
            expect(pending).toBeTruthy(); expect(lifecycle.serviceIsOperational(fixture.store, pending)).toBe(false);
            await activate(page, click, pending.id);
        }
        const connection = fixture.store.getAll('HealthcareService').find(item => lifecycle.basedOnId(item) === zero.id && lifecycle.ownerId(item) === b);
        const writes = fixture.requests.filter(request => request.method === 'PUT').length;
        await ownerAction(page, click, connection.id, 'Pause', false); expect(fixture.requests.filter(request => request.method === 'PUT').length).toBe(writes);
        await ownerAction(page, click, connection.id, 'Pause'); await expect(record(page, connection.id)).toContainText('Paused');
        await ownerAction(page, click, connection.id, 'Resume'); await expect(record(page, connection.id)).toContainText('Connected');
        await ownerAction(page, click, connection.id, 'Disconnect'); await expect(record(page, connection.id)).toContainText('Pause and End independently confirmed');
        await expect(record(page, connection.id)).toContainText('Ended');
        await expect(record(page, connection.id).locator('[data-service-status-form]')).toHaveCount(0);
        await click(pair(page, zero.id, b).getByRole('button', { name: 'Connect', exact: true }));
        const pending = fixture.store.getAll('HealthcareService').find(item => lifecycle.basedOnId(item) === zero.id && lifecycle.ownerId(item) === b && lifecycle.businessStatus(item) === 'pending');
        expect(pending.id).not.toBe(connection.id); await expect(record(page, connection.id)).toContainText('Ended');
        await expect(record(page, pending.id)).toContainText('Pending — waiting for activation');
        await ownerAction(page, click, pending.id, 'Withdraw request'); await expect(record(page, pending.id)).toContainText('Ended');
        expect(lifecycle.businessStatus(fixture.store.get('HealthcareService', connection.id))).toBe('cancelled');
        await expect(draft.locator('[name="name"]')).toHaveValue('Retained while managing multiple providers');
        const first = fixture.store.getAll('HealthcareService').find(item => lifecycle.basedOnId(item) === zero.id && lifecycle.ownerId(item) === a);
        const details = record(page, first.id).locator('[data-service-expansion] > summary');
        await details.focus(); await page.keyboard.press('Enter'); await expect(record(page, first.id).locator('pre')).toContainText(a);
        await expect(record(page, first.id).locator('pre')).toContainText(zero.id);
        await click(page.locator('[data-service-peer="catalog"]')); await page.goBack(); await expect(page.locator('#services-view-heading')).toBeVisible();
        await page.getByLabel('Filter loaded services by name').fill('no matching group');
        await expect(page.locator('[data-service-no-match]')).toBeVisible();
        await page.getByLabel('Filter loaded services by name').fill('');
        await page.getByLabel('Filter loaded services by status').selectOption('active');
        await expect(group(page, zero.id)).toBeVisible(); await page.getByLabel('Filter loaded services by status').selectOption('');
        const geometry = [];
        for (const width of mobile ? [390, 320] : [1440, 1024]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            const current = group(page, zero.id);
            geometry.push(await current.evaluate(node => ({ width: innerWidth, bar: getComputedStyle(node).borderInlineStartWidth, groupHeight: node.getBoundingClientRect().height, rowsContained: [...node.querySelectorAll('tbody')].every(row => row.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom) })));
            await current.screenshot({ path: info.outputPath(`directory-${width}.png`) });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await group(page, zero.id).screenshot({ path: info.outputPath('directory-200-percent.png') });
        expect(geometry.every(item => item.bar === '3px' && item.rowsContained)).toBe(true);
        const requests = fixture.requests.slice(start), ordinaryCreates = requests.filter(item => item.method === 'POST' && item.path.endsWith('/HealthcareService'));
        expect(new Set(ordinaryCreates.map(item => item.organization)).size).toBe(2); expect(new Set(ordinaryCreates.map(item => item.certificate)).size).toBe(2);
        expect(ordinaryCreates.every(item => !item.body.providedBy && !item.body.active)).toBe(true);
        const bWrites = requests.filter(item => item.method === 'PUT' && [connection.id, pending.id].some(id => item.path.endsWith('/' + id)));
        expect(bWrites).toHaveLength(5); expect(bWrites.every(item => item.organization === b && item.certificate)).toBe(true);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('identity-lifecycle-visual-receipt.json'), JSON.stringify({ traffic, requests, geometry, privateEvents: fixture.events.filter(event => event.operation === 'admin-service-command' && [first.id, connection.id].some(id => event.target === `HealthcareService/${id}`)), errors }, null, 2));
    } finally { await context.close(); }
});

 test('DIRECTORY partial Disconnect, unavailable credentials and passive disabled Help retain exact state without replay', async ({ browser }, info) => {
    const id = setup.registrationsB[0].id;
    const { page, context, click, mobile, errors, traffic } = await open(browser, info, id);
    try {
        let attempts = [];
        await page.route(`**/admin/services/${id}/status`, async route => {
            const body = route.request().postDataJSON(); attempts.push(body.state);
            if (body.state === 'cancelled') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Owned End refusal' }) }); else await route.continue();
        });
        await ownerAction(page, click, id, 'Disconnect');
        const current = record(page, id);
        await expect(current.locator('[data-service-status-form] [data-service-result]')).toContainText('Partial Disconnect: Pause confirmed; End is not confirmed');
        await expect(current.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
        expect(lifecycle.businessStatus(fixture.store.get('HealthcareService', id))).toBe('suspended'); expect(attempts).toEqual(['suspended', 'cancelled']);
        const before = { resources: JSON.stringify(fixture.store.getAll('HealthcareService')), requests: fixture.requests.length, tokens: fixture.tokens.size };
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const help = current.locator('[data-help-for="services.lifecycle"]').first();
        if (mobile) {
            const disabled = current.getByRole('button', { name: 'Disconnect', exact: true }); await disabled.scrollIntoViewIfNeeded();
            const box = await disabled.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else await help.focus();
        await expect(page.getByRole('tooltip')).toContainText('not atomic'); await expect(page.getByRole('button', { name: 'Dismiss explanation' })).toBeVisible();
        await page.getByRole('button', { name: 'Dismiss explanation' }).click(); await expect(mobile ? page.getByRole('checkbox', { name: 'Explain this page' }) : help).toBeFocused();
        expect(attempts).toEqual(['suspended', 'cancelled']);
        expect(JSON.stringify(fixture.store.getAll('HealthcareService'))).toBe(before.resources); expect(fixture.requests.length).toBe(before.requests); expect(fixture.tokens.size).toBe(before.tokens);
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.route(/\/admin\/services(?:\?.*)?$/, route => route.abort());
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toContainText('Stale results');
        await expect(current.getByRole('button', { name: 'Disconnect', exact: true })).toBeDisabled();
        await page.unroute(/\/admin\/services(?:\?.*)?$/); await page.unroute(`**/admin/services/${id}/status`);
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        await expect(record(page, id)).toContainText('Paused');
        await ownerAction(page, click, id, 'Disconnect'); await expect(record(page, id)).toContainText('End confirmed for the paused registration');
        await record(page, id).screenshot({ path: info.outputPath('partial-failure-inspected.png') });
        expect(errors).toEqual([]); fs.writeFileSync(info.outputPath('partial-and-passive-help.json'), JSON.stringify({ attempts, traffic, state: lifecycle.businessStatus(fixture.store.get('HealthcareService', id)), passiveRequests: 0, errors }, null, 2));
    } finally { await context.close(); }
});

 test('DIRECTORY global disable/enable preserves connected, paused and ended choices with immutable approvals', async ({ browser }, info) => {
    const service = setup.definitions[0], a = setup.registrationsA[0], b = setup.registrationsB[0];
    const owner = fixture.store.get('Organization', 'registered-third');
    const third = lifecycle.registerHealthcareService({ store: fixture.store, callerOrganization: owner, request: require(path.join(root, 'src/pcm-core/src/service-definition-form')).existingRegistration(service.id) }).instance;
    apply(third.id, 'activate'); apply(third.id, 'disable');
    lifecycle.transitionHealthcareService({ store: fixture.store, callerOrganization: owner, existing: fixture.store.get('HealthcareService', third.id), request: { extension: [lifecycle.statusExtension('cancelled')] } });
    const { createConsent, approveConsent } = require(path.join(root, 'src/pcm-core/src/fhir/consent-lifecycle'));
    const { EXTENSIONS } = require(path.join(root, 'src/shared/pcm-contract'));
    const request = structuredClone(require(path.join(root, 'docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
    request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${a.id}`;
    const pending = createConsent({ ...fixture, callerOrganization: fixture.store.get('Organization', lifecycle.ownerId(a)), request });
    const approved = approveConsent({ ...fixture, consent: pending, scopeChoice: 'service-provided', sourceOrganizationIds: fixture.config.healthOrganizations.map(item => item.dataSourceOrganization.id) });
    const snapshot = JSON.stringify(fixture.store.privateRecords.approvals.getDecision(approved.id).snapshot);
    apply(b.id, 'disable');
    const { page, context, click, errors } = await open(browser, info, service.id);
    try {
        const ids = [a.id, b.id, third.id], states = () => ids.map(id => lifecycle.businessStatus(fixture.store.get('HealthcareService', id)));
        expect(states()).toEqual(['active', 'suspended', 'cancelled']);
        await click(group(page, service.id).getByRole('link', { name: 'Review catalog definition', exact: true }));
        const catalog = page.locator(`[data-catalog-id="${service.id}"]`);
        page.once('dialog', dialog => dialog.accept()); await click(catalog.getByRole('button', { name: 'Disable', exact: true }));
        await expect(catalog.locator('[data-service-result]')).toContainText('Sandbox change saved');
        await click(page.locator('[data-service-peer="assignments"]'));
        await expect(record(page, a.id)).toContainText('Connected'); await expect(record(page, a.id)).toContainText('shared service definition is unavailable or inactive');
        expect(ids.map(id => lifecycle.serviceIsOperational(fixture.store, fixture.store.get('HealthcareService', id)))).toEqual([false, false, false]);
        expect(states()).toEqual(['active', 'suspended', 'cancelled']);
        await click(group(page, service.id).getByRole('link', { name: 'Review catalog definition', exact: true }));
        page.once('dialog', dialog => dialog.accept()); await click(catalog.getByRole('button', { name: 'Enable', exact: true }));
        await expect(catalog.locator('[data-service-result]')).toContainText('Sandbox change saved');
        await click(page.locator('[data-service-peer="assignments"]'));
        expect(states()).toEqual(['active', 'suspended', 'cancelled']);
        expect(ids.map(id => lifecycle.serviceIsOperational(fixture.store, fixture.store.get('HealthcareService', id)))).toEqual([true, false, false]);
        await expect(record(page, b.id)).toContainText('Paused'); await expect(record(page, third.id)).toContainText('Ended');
        expect(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(approved.id).snapshot)).toBe(snapshot);
        await group(page, service.id).screenshot({ path: info.outputPath('global-choice-matrix.png') });
        fs.writeFileSync(info.outputPath('global-choice-matrix.json'), JSON.stringify({ service: service.id, ids, stored: states(), effective: ids.map(id => lifecycle.serviceIsOperational(fixture.store, fixture.store.get('HealthcareService', id))), approvalUnchanged: true, errors }, null, 2)); expect(errors).toEqual([]);
    } finally { await context.close(); }
});

 test('DIRECTORY named provider paging, stale/read failures and late responses never infer absent pairs', async ({ browser }, info) => {
    for (let index = 0; index < 27; index++) extraProvider(`page-${String(index).padStart(2, '0')}`);
    const { page, context, click, errors } = await open(browser, info);
    try {
        const current = group(page, zero.id);
        await expect(current.locator('[data-provider-completeness]')).toContainText('Partial provider snapshot');
        await expect(current.locator('[data-provider-pair="registered-third"]')).toHaveCount(0);
        const next = current.locator('[data-provider-next]');
        await click(next); await expect(page.locator('[data-services-loading]')).toBeHidden();
        await expect(current.locator('[data-provider-pair="registered-third"]')).toBeVisible();
        await expect(current.locator('[data-provider-pair="page-00"]')).toHaveCount(0);
        await expect(current.locator('[data-provider-completeness]')).toContainText('unloaded pairs are unknown');
        await click(current.getByRole('link', { name: `First providers for Zero-provider directory service`, exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        // A stale snapshot response fails; current rows/view stay intact with no mutation.
        extraProvider('page-new'); await click(next); await expect(page.locator('[data-services-loading]')).toContainText('Stale results');
        await expect(current.locator('[data-provider-pair="page-00"]')).toBeVisible();
        await click(page.getByRole('button', { name: 'Refresh', exact: true })); await expect(page.locator('[data-services-loading]')).toBeHidden();
        let held, release; const wait = new Promise(resolve => { release = resolve; });
        await page.route('**/admin/services?**providerOffset=25**', async route => { const response = await route.fetch(); held = true; await wait; await route.fulfill({ response }).catch(() => {}); });
        await click(next); await expect.poll(() => held).toBe(true);
        await click(page.locator('[data-service-peer="catalog"]')); await expect(page.locator('#catalog-heading')).toBeVisible(); release();
        await expect(page.locator('[data-service-peer="catalog"]')).toHaveAttribute('aria-current', 'page');
        expect(errors).toEqual([]); fs.writeFileSync(info.outputPath('paging-fences.json'), JSON.stringify({ totalProviders: 31, partialHonest: true, stalePreserved: true, obsoleteProviderReplyIgnored: true, errors }, null, 2));
    } finally { await context.close(); }
});

/** Removing the last missing-owner row still reports its exact result within the named service. */
test('DIRECTORY missing-owner terminal cleanup retains a named inline result after the pair disappears', async ({ browser }, info) => {
    const owner = fixture.store.get('Organization', 'registered-third');
    const pending = lifecycle.registerHealthcareService({ store: fixture.store, callerOrganization: owner, request: require(path.join(root, 'src/pcm-core/src/service-definition-form')).existingRegistration(zero.id) }).instance;
    const ended = lifecycle.transitionHealthcareService({ store: fixture.store, callerOrganization: owner, existing: pending, request: { extension: [lifecycle.statusExtension('cancelled')] } });
    fixture.store.remove('Organization', owner.id);
    const { page, context, click, errors } = await open(browser, info, ended.id);
    try {
        await expect(record(page, ended.id)).toContainText('Unavailable provider');
        const before = fixture.requests.length;
        await click(record(page, ended.id).getByText('Admin actions', { exact: true }));
        page.once('dialog', dialog => dialog.accept()); await click(record(page, ended.id).getByRole('button', { name: 'Delete registration', exact: true }));
        await expect(record(page, ended.id)).toHaveCount(0);
        await expect(group(page, zero.id).locator('[data-group-result]')).toHaveText('Organization/registered-third: Deleted from this runtime. Restart/reset follows the configured bootstrap; no seed files were changed.');
        await expect(group(page, zero.id).locator('[data-group-result]')).toBeFocused();
        expect(fixture.requests.length).toBe(before); expect(fixture.store.get('HealthcareService', ended.id)).toBeNull();
        expect(fixture.events.some(event => event.operation === 'admin-service-command' && event.action === 'delete' && event.target === `HealthcareService/${ended.id}` && event.visibility === 'diagnostic')).toBe(true);
        expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('missing-owner-cleanup.json'), JSON.stringify({ catalog: zero.id, removedRegistration: ended.id, removedProvider: owner.id, inlineReceiptFocused: true, ordinaryTraffic: 0, errors }, null, 2));
    } finally { await context.close(); }
});
