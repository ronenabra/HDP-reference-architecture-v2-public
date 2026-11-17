'use strict';
/** Recapture the final preview/help copy against the live owned fixture, including native mobile taps. */
const fs = require('node:fs');
const { chromium, expect } = require('/suite/node_modules/@playwright/test');
const AxeBuilder = require('/suite/node_modules/@axe-core/playwright').default;
const config = JSON.parse(fs.readFileSync('/config.json'));
(async () => {
    const browser = await chromium.launch(); const observations = [];
    try {
        for (const mobile of [false, true]) {
            const label = mobile ? 'mobile' : 'desktop';
            const context = await browser.newContext({ ignoreHTTPSErrors: true,
                viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
                hasTouch: mobile, isMobile: mobile });
            const page = await context.newPage(); await page.goto(config.publicBaseUrls.spClient);
            const cards = page.locator('.card:has([data-help-key="doctor.consent-card"])');
            let id;
            for (let index = await cards.count() - 1; index >= 0; index--) if ((await cards.nth(index).locator('[data-help-key="doctor.consent-status"]').textContent()).trim() === 'active') {
                id = await cards.nth(index).locator('[name="consentId"]').inputValue(); break;
            }
            if (!id) throw new Error('Missing required active ordinary Consent; run the real clinical setup first');
            const card = page.locator(`.card:has(input[name="consentId"][value="${id}"])`);
            const activate = target => mobile ? target.tap() : target.click();
            await activate(card.locator('[formaction="/discover"]'));
            await card.locator('[data-source-choice]').selectOption(config.healthOrganizations[0].endpoint);
            await activate(card.locator('[formaction="/fetch-data"]'));
            const preview = card.locator('[aria-label="Fetched FHIR data"]');
            await expect(preview).toContainText('Selected patient (request context)');
            await expect(preview).toContainText('Every preset enforces the saved approval');
            const data = JSON.parse(await preview.locator('pre').textContent());
            if (data.preview.types.find(type => type.type === 'Observation')?.count !== 10) throw new Error('Required live >10 fixture is missing');
            await preview.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `/artifacts/${label}-preview-final.png` });
            await activate(page.getByRole('checkbox', { name: 'Explain this page' }));
            await activate(page.getByRole('button', { name: 'Enter or edit identifier', exact: true }));
            await page.locator('#patient-id').focus();
            await expect(page.getByRole('tooltip')).toContainText('Keep leading zeros');
            await page.screenshot({ path: `/artifacts/${label}-help-final.png` });
            const axe = await new AxeBuilder({ page }).analyze();
            const blocking = axe.violations.filter(value => ['critical', 'serious'].includes(value.impact));
            if (blocking.length) throw new Error(JSON.stringify(blocking));
            observations.push({ label, nativeTouch: mobile, preview: data.preview,
                helpText: await page.getByRole('tooltip').textContent(), violations: axe.violations.map(value => ({ id: value.id, impact: value.impact })) });
            await page.keyboard.press('Escape'); await context.close();
        }
        fs.writeFileSync('/artifacts/copy-recapture.json', JSON.stringify({ status: 'pass', observations }, null, 2));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
