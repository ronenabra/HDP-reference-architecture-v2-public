'use strict';

/** Isolated pinned-browser preparation of actual EJS forms; no network or clinical request is allowed. */
const fs = require('node:fs'), assert = require('node:assert/strict');
const { chromium, expect } = require('/suite/node_modules/@playwright/test');
const { selectDemoApproval, DEFAULT_SCOPE, MANUAL_SCOPE } = require('/suite/tests/helpers/demo-access-approval');
(async () => {
    const browser = await chromium.launch({ headless: true }), context = await browser.newContext();
    await context.route('**/*', route => route.abort());
    const forms = [];
    try {
        for (const manual of [false, true]) {
            const page = await context.newPage(); await page.setContent(fs.readFileSync(`/fixtures/${manual ? 'manual' : 'default'}.html`, 'utf8'), { waitUntil: 'domcontentloaded' });
            await page.addScriptTag({ content: fs.readFileSync('/proof/approval-scopes.js', 'utf8') });
            const before = await page.locator('[name="sources"]:checked').evaluateAll(inputs => inputs.map(input => input.value));
            if (manual) await expect(page.locator('#scope-custom')).not.toBeVisible();
            const scope = await selectDemoApproval(page, expect, manual); assert.equal(scope, manual ? MANUAL_SCOPE : DEFAULT_SCOPE);
            const values = await page.locator('form[data-scope-approval]').evaluate(form => [...new FormData(form).entries()]);
            const data = Object.fromEntries(values);
            assert.equal(data.scopeChoice, manual ? 'custom' : 'service-provided'); assert.equal(data.customScope, manual ? MANUAL_SCOPE : '');
            assert.ok(data.expectedVersion); assert.ok(JSON.parse(data.approvalReview).anchor);
            assert.deepEqual(values.filter(([name]) => name === 'sources').map(([, value]) => value), before);
            await expect(page.getByRole('button', { name: 'Approve request', exact: true })).toBeEnabled();
            forms.push({ manual, scope, fields: [...values, ['action', 'approve']], authoredDefaultUnchanged: await page.locator('#scope-service-provided').getAttribute('data-scope-value') === DEFAULT_SCOPE });
            await page.close();
        }
        console.log(JSON.stringify({ isolatedBrowserPreparationOnly: true, liveClinicalRequests: 0, networkAllowed: false,
            browser: browser.version(), playwright: require('/suite/node_modules/@playwright/test/package.json').version, forms }));
    } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
