'use strict';
/** Stage explicit named browser qualification transactions through the real Admin UI only. */
const fs = require('node:fs');
const { chromium, expect } = require('/suite/node_modules/@playwright/test');
const config = JSON.parse(fs.readFileSync('/config.json'));
(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
        const page = await context.newPage();
        const operations = [];
        for (const source of config.healthOrganizations) {
            const file = `/fixtures/${source.id}.source.transaction.json`;
            if (!fs.existsSync(file)) throw new Error(`Required named fixture missing: ${file}`);
            await page.goto(`${config.publicBaseUrls.pcmUi}/admin`);
            const target = page.locator(`[data-managed-fhir-server="${source.id}"]`);
            await target.locator(`#bundle-${source.id}`).setInputFiles(file);
            await target.locator(`#replace-${source.id}`).check();
            await target.getByRole('button', { name: 'Check bundle and import', exact: true }).click();
            await expect(target.locator(`#data-operation-${source.id}`)).toContainText(/Import|Checking|Waiting|accepted|verified/i);
            await page.reload();
            await expect(target.locator(`#data-operation-${source.id}`)).toContainText('Import complete', { timeout: 120000 });
            const operationId = await target.locator(`#data-operation-${source.id}`).getAttribute('data-operation-id');
            const result = await (await page.request.get(`${config.publicBaseUrls.pcmUi}/admin/api/data-operations/${operationId}`)).json();
            operations.push({ sourceId: source.id, operationId, phase: result.phase, expectedCounts: result.expectedCounts, verifiedCounts: result.verifiedCounts });
        }
        fs.writeFileSync('/artifacts/upload-receipt.json', JSON.stringify({ teamId: config.teamId, operations }, null, 2));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
