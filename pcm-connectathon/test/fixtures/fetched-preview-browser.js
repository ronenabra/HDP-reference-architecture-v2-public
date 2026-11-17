'use strict';

/** Isolated pinned-browser proof over actual EJS markup; no live clinical or team requests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/suite/node_modules/@playwright/test');
const { readFetchedPreview } = require('/suite/tests/helpers/fetched-preview');

/** Exercise actual strict locators and extraction guards against the current rendered Consent card. */
async function main() {
    const browser = await chromium.launch({ headless: true });
    const cases = [];
    const context = await browser.newContext();
    let blockedRequests = 0;
    await context.route('**/*', route => { blockedRequests++; return route.abort(); });
    try {
        const page = await context.newPage();
        const populated = fs.readFileSync('/fixtures/populated.html', 'utf8');
        const missing = fs.readFileSync('/fixtures/no-result.html', 'utf8');
        const reset = () => page.setContent(populated, { waitUntil: 'domcontentloaded' });
        const card = page.locator('.card').filter({ has: page.locator('input[name="consentId"][value="preview-proof"]') });
        await reset();
        assert.equal(await card.locator('pre').count(), 2);
        await assert.rejects(card.locator('pre').textContent(), /strict mode violation/);
        const snapshotBytes = await card.locator('pre').first().textContent();
        const snapshot = JSON.parse(snapshotBytes);
        assert.equal(snapshot.model, 'pcm-consent-scope/1');
        const result = await readFetchedPreview(card);
        assert.ok(result.entry.some(entry => entry.resource.resourceType === 'Patient'));
        assert.ok(result.entry.some(entry => entry.resource.resourceType === 'Condition'));
        assert.equal(result.preview.limit, 10); assert.equal(result.preview.source, 'https://source.example/fhir');
        assert.equal(await card.locator('pre').first().textContent(), snapshotBytes);
        assert.equal(await card.locator('[data-saved-approval]').textContent(), snapshot.scope);
        cases.push('snapshot and fetched Bundle coexist; old lookup ambiguous; exact fetched data and saved scope retained');
        await page.setContent(missing, { waitUntil: 'domcontentloaded' });
        assert.equal(await card.locator('pre').count(), 1);
        assert.equal(JSON.parse(await card.locator('pre').textContent()).model, 'pcm-consent-scope/1');
        await assert.rejects(readFetchedPreview(card), /unavailable/);
        cases.push('no fetched region cannot reuse the remaining saved snapshot');
        for (const [name, text] of [['malformed', '{invalid'], ['snapshot-as-data', snapshotBytes]]) {
            await reset();
            await card.getByRole('region', { name: 'Fetched FHIR data', exact: true }).locator('pre').evaluate((node, value) => { node.textContent = value; }, text);
            await assert.rejects(readFetchedPreview(card), /malformed|not a preview Bundle/);
            assert.equal(await card.locator('pre').first().textContent(), snapshotBytes);
            cases.push(name + ' stays unavailable without changing the snapshot');
        }
        await reset();
        await card.getByRole('region', { name: 'Fetched FHIR data', exact: true }).locator('pre').evaluate(node => node.remove());
        await assert.rejects(readFetchedPreview(card), /unavailable/);
        cases.push('missing fetched result stays unavailable');
        await reset();
        await card.getByRole('region', { name: 'Fetched FHIR data', exact: true }).evaluate(node => node.after(node.cloneNode(true)));
        await assert.rejects(readFetchedPreview(card), /ambiguous/);
        cases.push('duplicate fetched regions stay ambiguous');
        console.log(JSON.stringify({ browser: await browser.version(), playwright: require('/suite/node_modules/@playwright/test/package.json').version,
            cases, passed: cases.length, liveTeamRequests: 0, blockedRequests, isolatedDomOnly: true }, null, 2));
    } finally { await context.close(); await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
