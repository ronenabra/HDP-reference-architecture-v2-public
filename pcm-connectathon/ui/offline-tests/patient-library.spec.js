'use strict';
/** Actual Doctor/ordinary Contract sampler, exact draft return and passive structured browsing. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.DOCTOR_UI_ROOT || path.resolve(__dirname, '../../..');
const { SYSTEM, URI } = require(path.join(root, 'src/shared/sandbox-patients'));
const sampleView = page => page.locator('[data-library-view="sample"]');
const demoView = page => page.locator('[data-library-view="demo"]');
const rows = page => page.locator('#sample-results [data-patient-row]');
const sourceRequests = fixture => fixture.requests.filter(request => request.path.startsWith('/sample/'));
const save = fixture => fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
const act = (locator, info) => info.project.name === 'mobile' ? locator.tap() : locator.click();

/** Real source request observation avoids relying on an arbitrary loading delay. */
async function loadSample(page, fixture, state = 'loaded') {
    const before = sourceRequests(fixture).length;
    fixture.state.sampleMode = state;
    await page.locator('#sample-load').click();
    await expect.poll(() => sourceRequests(fixture).length).toBe(before + 1);
    await expect(page.locator('#sample-state')).toContainText({ loaded: 'Loaded', partial: 'Partial', empty: 'Empty', failed: 'Failed' }[state]);
    await expect(page.locator('#sample-cancel')).toBeHidden();
}

test('structured current sample: local filter, dynamic Explain, exact details, cached reload and draft return', async ({ page }, info) => {
    const fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer({ sampling: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(fixture.doctorBase + '/?identity=hospital-a');
        await page.locator('#service-id').selectOption(fixture.instance.id);
        await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click();
        await page.locator('#patient-id').fill('000000026');
        await expect(page.locator('#patient-feedback')).toContainText('Ordinary identifiers require explicit Consent review');
        await page.locator('#manual-testing summary').click();
        await page.locator('#manual-consent-id').fill('deliberate-non-secret-draft');
        await page.locator('[data-patient-library]').click();
        const entered = fixture.requests.length;
        await expect(demoView(page)).toHaveText('Demo & test patients (3)');
        await expect(page.locator('[data-library-group="demo"] [data-patient-row]')).toHaveCount(3);
        await expect(page.locator('#sample-cancel')).toBeHidden();
        await act(sampleView(page), info);
        await expect(page.locator('#sample-state')).toContainText('Not loaded');
        await loadSample(page, fixture);
        await expect(rows(page)).toHaveCount(3);
        await expect(sampleView(page)).toHaveText('Source sample (3)');
        await expect(page.locator('#sample-state')).toContainText('refreshed');
        expect(sourceRequests(fixture)).toHaveLength(1);
        expect(fixture.requests.slice(entered).some(request => request.authorizationBasis === 'Contract')).toBe(true);
        expect(sourceRequests(fixture)[0].query).toBe(URI.slice('/fhir/Patient'.length));
        const beforeBrowse = fixture.requests.length;
        await page.locator('#library-find').fill('Alex');
        await expect(page.locator('[data-library-group="sample"] [data-library-filter-status]')).toHaveText('1 of 3 patients matching “Alex”');
        const row = rows(page).filter({ hasText: 'Alex Example' });
        await expect(row).toBeVisible(); expect(await page.evaluate(() => window.injected)).toBeUndefined();
        await expect(row.locator('img')).toHaveCount(0);
        await act(row.locator('summary'), info);
        await expect(row.locator('details')).toHaveAttribute('open', '');
        await expect(row.locator('details')).toContainText(`${SYSTEM}|Ab123456-1234-5678-9012-000000000001`);
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        const use = row.getByRole('button', { name: 'Use patient', exact: true });
        const helpTarget = info.project.name === 'mobile' ? row.locator('summary') : use;
        if (info.project.name === 'mobile') await helpTarget.tap(); else await helpTarget.focus();
        await expect(page.getByRole('tooltip')).toContainText(info.project.name === 'mobile' ? 'exact System URI' : 'same editable patient entry');
        await page.keyboard.press('Escape');
        await expect(helpTarget).toBeFocused();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await act(demoView(page), info);
        await expect(page.locator('#library-find')).toHaveValue('Alex');
        await expect(page.locator('[data-library-group="demo"] [data-library-empty]')).toBeVisible();
        await expect(page.locator('[data-library-group="demo"] [data-library-filter-status]')).toHaveText('0 of 3 patients matching “Alex”');
        await act(sampleView(page), info);
        await expect(row.locator('details')).not.toHaveAttribute('open', '');
        await page.locator('#library-clear-filter').click();
        await expect(page.locator('#library-find')).toHaveValue('');
        await page.locator('#library-find').fill('no-such-patient');
        await expect(page.locator('[data-library-group="sample"] [data-library-empty]')).toBeVisible();
        await page.locator('#library-clear-filter').click();
        expect(fixture.requests.length).toBe(beforeBrowse);
        const sizes = info.project.name === 'mobile' ? [[390, 1], [320, 1]] : [[1440, 1], [1024, 1], [1440, 2]];
        const geometry = [];
        for (const [width, zoom] of sizes) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
            if (await row.locator('details').getAttribute('open') === null) await row.locator('summary').click();
            const before = await page.locator('[data-library-group="sample"]').evaluate(node => node.getBoundingClientRect().height);
            await page.getByRole('checkbox', { name: 'Explain this page' }).check();
            expect(await page.locator('[data-library-group="sample"]').evaluate(node => node.getBoundingClientRect().height)).toBe(before);
            await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
            const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
            expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
            await expect(row.getByRole('button', { name: 'Use patient' })).toBeVisible();
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: info.outputPath(`library-${width}-zoom-${zoom}.png`), fullPage: true });
            geometry.push({ width, zoom, overflow });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
        await page.reload(); await act(sampleView(page), info);
        await expect(rows(page)).toHaveCount(3); await expect(page.locator('#sample-state')).toContainText('Loaded');
        expect(sourceRequests(fixture)).toHaveLength(1);
        await expect(page.locator('[data-library-group="demo"]')).not.toContainText('Alex Example');
        // Back without choosing preserves the deliberate pair, service and supported diagnostic draft.
        await page.getByRole('link', { name: 'Back to request', exact: true }).click();
        await expect(page.locator('#patient-id')).toHaveValue('000000026');
        await expect(page.locator('#service-id')).toHaveValue(fixture.instance.id);
        await expect(page.locator('#manual-consent-id')).toHaveValue('deliberate-non-secret-draft');
        await page.locator('[data-patient-library]').click(); await act(sampleView(page), info);
        await rows(page).first().getByRole('button', { name: 'Use patient', exact: true }).click();
        await expect(page.locator('#configured-patient')).toHaveValue(`${SYSTEM}|Ab123456-1234-5678-9012-000000000001`);
        await expect(page.locator('#patient-system-uri')).toHaveValue(SYSTEM);
        await expect(page.locator('#patient-id')).toHaveValue('Ab123456-1234-5678-9012-000000000001');
        await expect(page.locator('#service-id')).toHaveValue(fixture.instance.id);
        await expect(page.locator('#doctor-identity')).toHaveValue('hospital-a');
        await expect(page.locator('#manual-consent-id')).toHaveValue('deliberate-non-secret-draft');
        expect(fixture.consents.size).toBe(2);
        expect(fixture.requests.filter(request => request.requestedScope?.startsWith('patient/') || request.method === 'POST' && request.path.endsWith('/Consent'))).toEqual([]);
        expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('receipt.json'), JSON.stringify({ geometry, requests: fixture.requests, errors, violations: fixture.violations }, null, 2));
    } finally { await fixture.close(); }
});

test('source states: explicit refresh, two-provider isolation, stale cancellation, partial/empty/failure, Strict and no source', async ({ page }, info) => {
    const fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer({ sampling: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let release;
    try {
        await page.goto(fixture.doctorBase + '/patients?identity=hospital-a'); await act(sampleView(page), info);
        await loadSample(page, fixture);
        await rows(page).first().locator('summary').click();
        const before = sourceRequests(fixture).length;
        await page.locator('#sample-source').selectOption('ho-b');
        await expect(rows(page)).toHaveCount(0); await expect(page.locator('#sample-state')).toContainText('Not loaded');
        expect(sourceRequests(fixture)).toHaveLength(before);
        await expect(page.locator('#sample-results details')).toHaveCount(0);
        fixture.state.sampleDelay = new Promise(resolve => { release = resolve; });
        await page.locator('#sample-load').click();
        await expect.poll(() => sourceRequests(fixture).length).toBe(before + 1);
        await expect(page.locator('#sample-cancel')).toBeVisible(); await expect(page.locator('#sample-load')).toBeDisabled();
        await act(page.locator('#sample-cancel'), info);
        await expect(page.locator('#sample-state')).toContainText('Cancelled'); await expect(page.locator('#sample-cancel')).toBeHidden();
        release(); fixture.state.sampleDelay = null;
        await page.reload(); await act(sampleView(page), info);
        await expect(rows(page)).toHaveCount(0); await expect(page.locator('#sample-state')).toContainText('Cancelled');
        await loadSample(page, fixture, 'partial');
        await expect(rows(page)).toHaveCount(3); await expect(page.locator('#sample-state')).toContainText('2 invalid');
        await page.screenshot({ path: info.outputPath('library-partial.png'), fullPage: true });
        await expect(page.locator('#sample-load')).toHaveText('Refresh sample');
        await loadSample(page, fixture, 'empty'); await expect(rows(page)).toHaveCount(0);
        await expect(page.locator('[data-library-group="sample"] [data-library-empty]')).toBeVisible();
        await loadSample(page, fixture, 'failed'); await expect(rows(page)).toHaveCount(0);
        await page.reload(); await act(sampleView(page), info); await expect(page.locator('#sample-state')).toContainText('Failed');
        await page.screenshot({ path: info.outputPath('library-failed.png'), fullPage: true });
        // A later response from the old source cannot refill rows after a source change.
        fixture.state.sampleMode = 'loaded'; fixture.state.sampleDelay = new Promise(resolve => { release = resolve; });
        const old = sourceRequests(fixture).length;
        await page.locator('#sample-load').click(); await expect.poll(() => sourceRequests(fixture).length).toBe(old + 1);
        await page.locator('#sample-source').selectOption('ho-a'); release(); fixture.state.sampleDelay = null;
        await expect(page.locator('#sample-state')).toContainText('Not loaded'); await expect(rows(page)).toHaveCount(0);
        await loadSample(page, fixture);
        // Distinct application caches and ordinary own-client sampler tokens.
        await page.goto(fixture.doctorBase + '/patients?identity=hospital-b'); await act(sampleView(page), info);
        await expect(rows(page)).toHaveCount(0); await expect(page.locator('#sample-state')).toContainText('Not loaded');
        await loadSample(page, fixture); await expect(rows(page)).toHaveCount(3);
        expect(sourceRequests(fixture).at(-1).sampleClient).toBe(fixture.config.organizations.hospitalBServiceProvider.clientId);
        await page.goto(fixture.doctorBase + '/patients?identity=hospital-a'); await act(sampleView(page), info);
        await expect(rows(page)).toHaveCount(3); await expect(page.locator('#sample-source')).toHaveValue('ho-a');
        fixture.config.runtime = { ...fixture.config.runtime, revision: (fixture.config.runtime?.revision || 0) + 1 }; save(fixture);
        const beforeRejected = await page.evaluate(() => sessionStorage.getItem('pcm-doctor-draft::hospital-a'));
        await rows(page).first().getByRole('button', { name: 'Use patient', exact: true }).click();
        await expect(page.locator('#library-selection-state')).toContainText('Patient not selected: This sample changed.');
        expect(await page.evaluate(() => sessionStorage.getItem('pcm-doctor-draft::hospital-a'))).toBe(beforeRejected);
        await page.reload(); await act(sampleView(page), info); await expect(rows(page)).toHaveCount(0);
        const strict = require(path.join(root, 'test-support/team-config')).buildTeamConfig({}, 'strict');
        Object.assign(fixture.config, { conformance: strict.conformance, security: strict.security, securitySimulation: strict.securitySimulation, legacyDataSource: strict.legacyDataSource });
        delete fixture.config.sandboxSampling; save(fixture);
        const passive = fixture.requests.length;
        await page.reload(); await act(sampleView(page), info);
        await expect(page.locator('#sample-load')).toBeDisabled(); await expect(page.locator('#sample-state')).toContainText('Unsupported: sampling is disabled in Strict');
        await expect(page.locator('#sample-cancel')).toBeHidden();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        if (info.project.name === 'mobile') {
            await page.locator('#sample-load').scrollIntoViewIfNeeded();
            const bounds = await page.locator('#sample-load').boundingBox();
            await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        } else await page.locator('#sample-load').hover();
        await expect(page.getByRole('tooltip')).toContainText('ordinary PCM token');
        await page.screenshot({ path: info.outputPath('library-strict-help.png'), fullPage: true });
        await page.keyboard.press('Escape'); await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await act(demoView(page), info); await expect(page.locator('[data-library-group="demo"] [data-patient-row]')).toHaveCount(3);
        const easy = require(path.join(root, 'test-support/team-config')).buildTeamConfig();
        Object.assign(fixture.config, { conformance: easy.conformance, security: easy.security, securitySimulation: easy.securitySimulation, legacyDataSource: easy.legacyDataSource }); save(fixture);
        await page.reload(); await act(sampleView(page), info);
        await expect(page.locator('#sample-state')).toContainText('No source:'); await expect(page.locator('#sample-load')).toBeDisabled();
        await page.screenshot({ path: info.outputPath('library-no-source.png'), fullPage: true });
        expect(fixture.requests.length).toBe(passive);
        expect(fixture.consents.size).toBe(2); expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('states-receipt.json'), JSON.stringify({ requests: fixture.requests, errors, violations: fixture.violations }, null, 2));
    } finally { release?.(); fixture.state.sampleDelay = null; await fixture.close(); }
});

test('accepted selection response cannot replace the draft or navigate after the source changes', async ({ page }, info) => {
    const fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer({ sampling: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let release;
    try {
        await page.goto(fixture.doctorBase + '/?identity=hospital-a');
        await page.locator('#service-id').selectOption(fixture.instance.id);
        await page.getByRole('tab', { name: 'Enter identifier', exact: true }).click();
        await page.locator('#patient-system').selectOption('http://fhir.health.gov.il/identifier/il-national-id');
        await page.locator('#patient-id').fill('000000026');
        await page.locator('#manual-testing summary').click();
        await page.locator('#manual-consent-id').fill('preserve-current-draft');
        await page.locator('[data-patient-library]').click(); await act(sampleView(page), info);
        await loadSample(page, fixture);
        const before = await page.evaluate(() => sessionStorage.getItem('pcm-doctor-draft::hospital-a'));
        // Observe consumed JSON so negative assertions run after the selection continuation.
        await page.evaluate(() => {
            const original = window.fetch;
            sessionStorage.removeItem('doctor-test-selection-body');
            window.fetch = async (...args) => {
                const response = await original(...args);
                if (String(args[0]).endsWith('/patients/select')) {
                    const json = response.json.bind(response);
                    response.json = async () => { const payload = await json(); sessionStorage.setItem('doctor-test-selection-body', 'consumed'); return payload; };
                }
                return response;
            };
        });
        let accepted;
        const serverAccepted = new Promise(resolve => { accepted = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        await page.route('**/patients/select', async route => {
            const response = await route.fetch();
            accepted({ status: response.status(), body: await response.json() });
            await gate; await route.fulfill({ response });
        });
        await rows(page).first().getByRole('button', { name: 'Use patient', exact: true }).click();
        const acceptance = await serverAccepted;
        expect(acceptance).toEqual({ status: 200, body: { location: '/?identity=hospital-a' } });
        const changed = page.waitForResponse(response => response.url().endsWith('/patients/source') && response.ok());
        await page.locator('#sample-source').selectOption('ho-b'); await changed;
        await expect(rows(page)).toHaveCount(0); await expect(page.locator('#sample-state')).toContainText('Not loaded');
        const participantCount = fixture.requests.length;
        release();
        await page.waitForFunction(() => sessionStorage.getItem('doctor-test-selection-body') === 'consumed');
        expect(await page.evaluate(() => sessionStorage.getItem('pcm-doctor-draft::hospital-a'))).toBe(before);
        await expect(page).toHaveURL(fixture.doctorBase + '/patients?identity=hospital-a');
        await expect(page.locator('#sample-source')).toHaveValue('ho-b');
        await expect(rows(page)).toHaveCount(0); await expect(page.locator('#sample-state')).toContainText('Not loaded');
        await expect(page.locator('#library-selection-state')).toHaveText('');
        expect(fixture.requests.length).toBe(participantCount);
        expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('selection-race-receipt.json'), JSON.stringify({ acceptance, before, source: 'ho-b', requests: fixture.requests, errors, violations: fixture.violations }, null, 2));
    } finally {
        release?.();
        try { await page.unrouteAll({ behavior: 'wait' }); } finally { await fixture.close(); }
    }
});
