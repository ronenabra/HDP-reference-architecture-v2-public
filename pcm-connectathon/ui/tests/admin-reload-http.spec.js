'use strict';
/** Reproduce and qualify navigation against real Admin HTTP/ledger/upload owners. */
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const base = process.env.PCM_ADMIN_RELOAD_URL;
const baseline = process.env.PCM_ADMIN_RELOAD_BASELINE;
test.beforeEach(() => test.skip(!base, 'requires isolated Admin HTTP fixture with synthetic upstream'));

/** Wait on actual persisted server state instead of relying on browser feedback. */
async function facts(request) { return (await request.get(`${base}/fixture/facts`)).json(); }

/** Clear only the fake fixture targets using the maintained Admin deletion routes. */
async function prepare(request) {
    for (const id of ['ho-a', 'ho-b']) {
        const response = await request.delete(`${base}/admin/api/fhir-servers/${id}/data`, { data: { confirmation: `delete-all:team-a:${id}` } });
        expect(response.status()).toBe(202);
        await expect.poll(async () => (await facts(request)).servers[id].operation.phase).toBe('succeeded');
    }
    expect((await request.post(`${base}/fixture/arm`)).ok()).toBe(true);
}

test('Admin overlapping uploads retain acceptance, reservation and saved file @smoke', async ({ page, request }, info) => {
    await prepare(request);
    const initial = await facts(request);
    if (baseline) await page.route('**/assets/connectathon.js', route => route.fulfill({ body: fs.readFileSync(baseline), contentType: 'application/javascript' }));
    const failures = [], navigations = [];
    page.on('requestfailed', req => failures.push({ url: req.url(), error: req.failure()?.errorText }));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await page.goto(`${base}/admin`);
    await page.locator('#bundle-ho-b').setInputFiles('/ci/ho-b.source.transaction.json');
    await page.locator('[data-managed-fhir-server="ho-b"] button[data-help-key="admin.data-import"]').click();
    await expect.poll(async () => (await facts(request)).gates.preflightReached).toBe(true);
    await page.locator('#bundle-ho-a').setInputFiles('/ci/ho-a.source.transaction.json');
    await page.locator('[data-managed-fhir-server="ho-a"] button[data-help-key="admin.data-import"]').click();
    await expect.poll(async () => (await facts(request)).servers['ho-a'].operation.phase).toBe('succeeded');
    if (baseline) await expect.poll(() => navigations.length).toBe(2);
    else {
        await expect(page.locator('#data-operation-ho-a')).toContainText('Import complete');
        await page.waitForTimeout(1100); // Cross the previous unconditional 500 ms reload.
        expect(navigations).toHaveLength(1);
        await expect(page.locator('[data-admin-refresh]')).toBeDisabled();
        await expect(page.locator('#data-operation-ho-b')).toContainText('Wait for the server to confirm');
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        await page.locator('[data-admin-refresh-status]').focus();
        await expect(page.getByRole('tooltip')).toContainText('While any server');
        await page.keyboard.press('Escape');
    }
    const beforeAcceptance = await facts(request);
    expect(beforeAcceptance.servers['ho-b'].reserved).toBe(true);
    expect(beforeAcceptance.servers['ho-b'].savedUpload).toBe(false);
    expect(beforeAcceptance.servers['ho-b'].operation.mutationSubmitted).not.toBe(true);
    await request.post(`${base}/fixture/release/preflight`);
    await expect.poll(async () => (await facts(request)).gates.transactionReached).toBe(true);
    const accepted = await facts(request);
    expect(accepted.servers['ho-b'].reserved).toBe(true);
    expect(accepted.servers['ho-b'].savedUpload).toBe(true);
    expect(accepted.servers['ho-b'].operation.phase).toBe('loading');
    if (!baseline) await expect(page.locator('#data-operation-ho-b')).toContainText('Import in progress');
    await request.post(`${base}/fixture/release/transaction`);
    await expect.poll(async () => (await facts(request)).servers['ho-b'].operation.phase).toBe('succeeded');
    const finished = await facts(request);
    expect(finished.servers['ho-b'].reserved).toBe(false);
    expect(finished.servers['ho-b'].savedUpload).toBe(false);
    for (const id of ['ho-a', 'ho-b']) expect(finished.servers[id].posts - initial.servers[id].posts).toBe(1);
    const connections = finished.connections.slice(-2);
    if (baseline) expect(connections.some(item => item.closedBeforeResponse)).toBe(true);
    else expect(connections.every(item => item.finished && !item.closedBeforeResponse)).toBe(true);
    // Browser requestfailed events can miss cancellation; the real response-close
    // observation distinguishes it from the retained backend operation.
    if (!baseline) {
        await expect.poll(() => navigations.length).toBe(2);
        expect(failures).toEqual([]);
        await expect(page.locator('#data-operation-ho-b')).toContainText('Import complete');
        await page.locator('#data-operation-ho-b').scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('both-imports-complete.png'), fullPage: true });
    }
    await info.attach('operation-lifecycle', { body: JSON.stringify({ baseline: Boolean(baseline), initial, beforeAcceptance, accepted, finished, failures, navigations }, null, 2), contentType: 'application/json' });
});
