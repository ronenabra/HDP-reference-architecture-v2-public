'use strict';
/** Actual Doctor/PCM fixture: exact pair, invalid focus, pending submit, drafts and passive Help. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs'), path = require('node:path');
const root = process.env.DOCTOR_UI_ROOT || path.resolve(__dirname, '../../..');
const m = require(path.join(root, 'src/shared/identity-mapping'));
const passport = 'http://hl7.org/fhir/sid/passport-USA';

test('manual identifier is one exact draft through keyboard, touch, validation, history and submit', async ({ page }, info) => {
    const fixture = await require(path.join(root, 'test-support/doctor-public-server')).startDoctorPublicServer();
    const errors = [], creates = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/create-consent')) creates.push(request.postData()); });
    const act = async locator => info.project.name === 'mobile' ? locator.tap() : locator.click();
    const ready = () => expect(page.locator('#patient-feedback')).toContainText('Ordinary identifiers require explicit Consent review');
    try {
        const base = fixture.doctorBase;
        await page.goto(base + '/?identity=hospital-a');
        await page.locator('#service-id').selectOption(fixture.instance.id);
        await page.locator('#configured-patient').selectOption(`${m.SYNTHETIC_TEST_ID_SYSTEM}|1`);
        await expect(page.locator('#patient-name')).toContainText('Israel Israelov');
        await act(page.getByRole('button', { name: 'Enter identifier', exact: true }));
        await page.locator('#patient-system').selectOption('__manual__');
        const system = page.getByRole('textbox', { name: 'System URI', exact: true }), value = page.locator('#patient-id');
        await expect(system).toBeFocused();
        await system.fill(passport); await value.fill('00AbC'); await ready();
        await expect(page.locator('#patient-name')).toContainText('Name unknown');
        await expect(page.locator('#patient-resolved')).toHaveText(`Resolved identifier: ${passport}|00AbC`);
        await system.fill('urn:unsupported:CaseSensitive');
        await expect(page.locator('#patient-system-feedback')).toContainText('System URI');
        await act(page.locator('[data-request-consent]'));
        await expect(system).toBeFocused(); expect(creates).toEqual([]);
        await value.press('Enter'); expect(creates).toEqual([]);
        await expect(system).toHaveValue('urn:unsupported:CaseSensitive');
        await page.screenshot({ path: info.outputPath('identifier-unsupported.png'), fullPage: true });
        await page.reload();
        await expect(system).toHaveValue('urn:unsupported:CaseSensitive');
        await expect(page.locator('#patient-system-feedback')).toContainText('System URI');
        await system.fill(m.DEFAULT_PATIENT_ID_SYSTEM); await value.fill('000000019');
        await expect(page.locator('#patient-feedback')).toContainText('check digit');
        await act(page.locator('[data-request-consent]')); await expect(value).toBeFocused(); expect(creates).toEqual([]);
        await system.fill(''); await act(page.locator('[data-request-consent]')); await expect(system).toBeFocused(); expect(creates).toEqual([]);
        // An explicit full token overrides both the empty manual URI and the prior choice.
        await value.fill(` ${passport} | 001aB `); await ready();
        await expect(system).toHaveValue(passport); await expect(value).toHaveValue('001aB');
        await act(page.getByRole('button', { name: 'Choose patient', exact: true }));
        await act(page.getByRole('button', { name: 'Enter identifier', exact: true }));
        await expect(system).toHaveValue(passport); await expect(value).toHaveValue('001aB');
        const beforeHelp = fixture.requests.length, beforeCount = fixture.consents.size;
        const geometry = () => page.locator('[data-patient-section]').boundingBox();
        const beforeGeometry = await geometry();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        if (info.project.name === 'mobile') await system.tap(); else await system.focus();
        await expect(page.getByRole('tooltip')).toContainText('never fetched');
        await page.keyboard.press('Escape'); await expect(system).toBeFocused();
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        const afterGeometry = await geometry(); expect(afterGeometry.height).toBe(beforeGeometry.height);
        expect(fixture.requests.length).toBe(beforeHelp); expect(fixture.consents.size).toBe(beforeCount);
        const sizes = info.project.name === 'mobile' ? [[390, 1], [320, 1]] : [[1440, 1], [1024, 1], [1440, 2]];
        for (const [width, zoom] of sizes) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
            await expect(system).toBeVisible(); await expect(value).toBeVisible();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
            await page.screenshot({ path: info.outputPath(`identifier-${width}-zoom-${zoom}.png`), fullPage: true });
        }
        await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
        await page.locator('[data-patient-library]').click();
        await page.getByRole('link', { name: 'Back to request', exact: true }).click(); await ready();
        await expect(system).toHaveValue(passport); await expect(value).toHaveValue('001aB');
        await expect(page.locator('#service-id')).toHaveValue(fixture.instance.id);
        await page.goBack(); await expect(page.getByRole('link', { name: 'Back to request', exact: true })).toBeVisible();
        await page.goForward(); await ready();
        await expect(system).toHaveValue(passport); await expect(value).toHaveValue('001aB');
        await page.reload(); await ready(); await expect(system).toHaveValue(passport);
        // A restored history document must not overwrite a newer library/reset draft on reload.
        await page.evaluate(({ system }) => {
            const key = `pcm-doctor-draft:${document.body.dataset.browserBase || ''}:hospital-a`;
            const draft = JSON.parse(sessionStorage.getItem(key));
            draft.patientId = '0007R'; draft.patientSystem = system; draft.manualSystem = true;
            sessionStorage.setItem(key, JSON.stringify(draft));
            window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        }, { system: passport });
        await ready(); await expect(value).toHaveValue('0007R');
        // A real library selection replaces the pair, while preserving the selected service.
        await page.locator('[data-patient-library]').click();
        const chosen = page.locator('form[action$="/patients/select"]').filter({ has: page.locator(`input[name="patientId"][value="${m.SYNTHETIC_TEST_ID_SYSTEM}|2"]`) });
        await chosen.getByRole('button').click();
        await expect(page.locator('#patient-name')).toContainText('Israela Israelov');
        await expect(page.locator('#service-id')).toHaveValue(fixture.instance.id);
        await act(page.getByRole('button', { name: 'Enter identifier', exact: true }));
        await page.locator('#patient-system').selectOption('__manual__');
        await value.fill(`${passport}|001aB`); await ready();
        await expect(system).toHaveValue(passport);
        // Hold the actual save: Enter must wait and then submit the edited pair exactly once.
        let release, observed;
        const gate = new Promise(resolve => { release = resolve; });
        const seen = new Promise(resolve => { observed = resolve; });
        await page.route('**/selection', async route => { observed(); await gate; await route.continue(); });
        await value.fill('oldDraft'); await seen;
        await value.fill('0009Z');
        await expect(value).toHaveValue('0009Z');
        await value.press('Enter');
        expect(creates).toEqual([]); expect(fixture.consents.size).toBe(beforeCount);
        release();
        await expect.poll(() => creates.length).toBe(1);
        await expect.poll(() => fixture.consents.size).toBe(beforeCount + 1);
        await expect(page.getByText('Consent request created. Check its recorded PCM status; creation does not fetch data or prove a patient decision.', { exact: true })).toBeVisible();
        const created = [...fixture.consents.values()].at(-1);
        expect(created.patient.identifier).toEqual({ system: passport, value: '0009Z' });
        const submitted = new URLSearchParams(creates[0]);
        expect(submitted.get('patientSystem')).toBe(passport); expect(submitted.get('patientId')).toBe('0009Z');
        expect(fixture.violations).toEqual([]); expect(errors).toEqual([]);
        fs.writeFileSync(info.outputPath('receipt.json'), JSON.stringify({ creates, patient: created.patient, requests: fixture.requests, violations: fixture.violations, errors }, null, 2));
    } finally { await fixture.close(); }
});
