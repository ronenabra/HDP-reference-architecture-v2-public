'use strict';
/** Authored Admin markup, controller and live help with synthetic, intercepted mutations. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const fixture = process.env.PCM_ADMIN_PLAIN_FIXTURE;
const assetRoot = process.env.PCM_UI_ASSET_ROOT || '/ui-assets';
test.beforeEach(() => test.skip(!fixture, 'requires disposable recovery markup'));

/** Load the real template while preventing all external application requests. */
async function load(page) {
    await page.route('https://admin-plain.test/**', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/assets/')) {
            const name = path.basename(url.pathname);
            return route.fulfill({ body: fs.readFileSync(path.join(assetRoot, name)), contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript' });
        }
        if (url.pathname.startsWith('/admin/api/data-operations/')) return route.fulfill({ json: {
            id: url.pathname.split('/').at(-1), serverId: 'ho-a', kind: 'import', phase: 'failed',
            status: 'reconciliation-required', needsReconciliation: true, currentStage: 'reconciliation-required'
        } });
        return route.fulfill({ body: fs.readFileSync(fixture), contentType: 'text/html' });
    });
    await page.goto('https://admin-plain.test/admin');
}

test('Admin plain recovery copy, keyboard help and checkbox cancellation/reload @smoke', async ({ page }, info) => {
    await load(page);
    const card = page.locator('[data-managed-fhir-server="ho-a"]');
    await expect(card.locator('#data-operation-ho-a')).toContainText("couldn't confirm whether the import finished");
    await expect(card.locator('#data-operation-ho-a > p').first()).not.toContainText('reconciliation-required');
    await expect(card.locator('input[name="confirmation"][type="text"]')).toHaveCount(0);
    const reset = card.locator('form[action$="/reset"]');
    const ack = reset.locator('[data-delete-acknowledgement]');
    const button = reset.locator('button[data-help-key="admin.recovery-reset"]');
    await expect(button).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    for (const [selector, text] of [['[data-help-key="admin.recovery-verify"]', 'without uploading the file again'],
        ['[data-help-key="admin.recovery-stopped"]', 'local operator'],
        ['[data-help-key="admin.data-confirmation"]', 'No confirmation text needs to be typed']]) {
        await card.locator(selector).last().focus();
        await expect(page.getByRole('tooltip')).toContainText(text);
        await page.keyboard.press('Escape');
    }
    await reset.locator('[name="workersStopped"]').check();
    await ack.check();
    await expect(button).toBeEnabled();
    await button.focus();
    await expect(page.getByRole('tooltip')).toContainText('delete all data and saved versions');
    await page.keyboard.press('Escape');
    page.once('dialog', dialog => dialog.dismiss());
    await button.click();
    await expect(ack).not.toBeChecked();
    await expect(button).toBeDisabled();
    await ack.check();
    await page.reload();
    await expect(ack).not.toBeChecked();
    await expect(reset.locator('[name="workersStopped"]')).not.toBeChecked();
    await expect(page.locator('#delete-ho-b')).not.toBeChecked();
    await ack.focus();
    await expect(page.getByRole('tooltip')).toContainText('No confirmation text needs to be typed');
    await page.screenshot({ path: info.outputPath('recovery-help.png'), fullPage: true });
});

test('Admin recovery checkbox submits exact target and refuses unchecked submission @smoke', async ({ page }, info) => {
    await load(page);
    const reset = page.locator('[data-managed-fhir-server="ho-a"] form[action$="/reset"]');
    let posts = [];
    await page.route('**/admin/api/data-operations/*/reset', route => {
        posts.push(route.request().postData());
        return route.fulfill({ body: '<html><body>Cleared this server</body></html>', contentType: 'text/html' });
    });
    await reset.locator('[name="workersStopped"]').check();
    await reset.evaluate(form => form.requestSubmit());
    expect(posts).toEqual([]);
    await reset.locator('[name="confirmation"]').check();
    page.once('dialog', dialog => dialog.accept());
    await reset.locator('button[data-help-key="admin.recovery-reset"]').click();
    await expect(page.locator('body')).toContainText('Cleared this server');
    expect(posts).toHaveLength(1);
    const values = new URLSearchParams(posts[0]);
    expect(values.get('workersStopped')).toBe('true');
    expect(values.get('confirmation')).toMatch(/^delete-all:.*:ho-a$/);
    await page.screenshot({ path: info.outputPath('cleared.png'), fullPage: true });
});

for (const [phase, extra, text] of [
    ['loading', { currentStage: 'transaction-waiting' }, 'Import in progress'],
    ['succeeded', {}, 'Import complete'],
    ['failed', {}, 'The import did not finish'],
    ['succeeded', { reconciliationVerifiedAt: 'now' }, 'No file was imported again'],
    ['failed', { resetVerifiedAt: 'now', submittedOutcome: 'resolved-by-target-reset' }, 'All data and saved versions were deleted']
]) test(`Admin polled ${text} stays readable with live help @smoke`, async ({ page }, info) => {
    await load(page);
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await page.evaluate(({ phase, extra }) => renderDataOperation(document.getElementById('data-operation-ho-a'), {
        id: 'synthetic-operation-uuid', serverId: 'ho-a', phase, status: 'raw-ledger-state', kind: 'import', ...extra
    }), { phase, extra });
    const output = page.locator('#data-operation-ho-a');
    await expect(output.locator(':scope > p').first()).toContainText(text);
    await output.locator('h4').focus();
    await expect(page.getByRole('tooltip')).toContainText('Import in progress, import complete');
    await page.keyboard.press('Escape');
    await expect(output.locator('details')).not.toHaveAttribute('open');
    await output.locator('summary').click();
    await expect(output.locator('details')).toContainText('synthetic-operation-uuid');
    await page.screenshot({ path: info.outputPath(`${phase}-help.png`), fullPage: true });
});

test('Admin refused deletion clears only its acknowledgement and explains the next step @smoke', async ({ page }) => {
    await load(page);
    await page.route('**/admin/api/fhir-servers/ho-a/data', route => route.fulfill({ status: 409,
        json: { error: 'target ho-a busy; raw-operation-uuid', activeOperationId: 'raw-operation-uuid' } }));
    const target = page.locator('[data-managed-fhir-server="ho-a"]');
    const ack = target.locator('#delete-ho-a');
    await page.locator('#delete-ho-b').check();
    await ack.check();
    page.once('dialog', dialog => dialog.accept());
    await target.getByRole('button', { name: 'Delete all data', exact: true }).click();
    const output = target.locator('#data-delete-ho-a');
    await expect(output.locator('p')).toContainText('needs attention on this server');
    await expect(output.locator('p')).not.toContainText('raw-operation-uuid');
    await expect(output.locator('a')).toHaveAttribute('href', '#server-ho-a');
    await expect(ack).not.toBeChecked();
    await expect(page.locator('#delete-ho-b')).toBeChecked();
    await page.getByRole('checkbox', { name: 'Explain this page' }).check();
    await output.locator('a').focus();
    await expect(page.getByRole('tooltip')).toContainText('recovery controls');
});

for (const phase of ['loading', 'failed']) test(`Admin replacement ${phase} retains import outcome after clearing @smoke`, async ({ page }) => {
    await load(page);
    await page.evaluate(phase => renderDataOperation(document.getElementById('data-operation-ho-a'), {
        id: 'replacement', serverId: 'ho-a', kind: 'replace', phase,
        currentStage: 'transaction-waiting', resetVerifiedAt: 'now', needsReconciliation: phase === 'failed'
    }), phase);
    const output = page.locator('#data-operation-ho-a');
    await expect(output.locator('h4')).toContainText('Check bundle and import');
    await expect(output.locator(':scope > p').first()).toContainText(phase === 'failed'
        ? "couldn't confirm whether the import finished" : 'Import in progress');
    await expect(output.locator(':scope > p').first()).not.toContainText('You can import another file');
});
