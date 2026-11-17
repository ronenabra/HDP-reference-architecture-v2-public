'use strict';
/** Actual TLS gateway arrivals visible through unmodified bounded/live PCM APIs. */
const { test, expect } = require('@playwright/test');
/** Query the real owned fixture's observed transport and log state. */
async function state(request) { return (await request.get('/fixture/state')).json(); }
/** Close the native-touch filter drawer when it covers the event list. */
async function closeSidebar(page) { if (await page.locator('#close-workbench').isVisible()) await page.locator('#close-workbench').click(); }

for (const order of ['timeline', 'flow']) test(`real early arrivals, exact raw, delayed completion and interruption: ${order}`, async ({ page, request }, info) => {
    await request.post('/fixture/reset');
    await page.addInitScript(order => localStorage.setItem('unifiedLogOrderMode', order), order);
    await page.goto('/logs-view?role=gateway&healthOrganizationId=ho-b&diagnostics=false');
    await closeSidebar(page);
    for (const scenario of ['delayed-auth', 'delayed-upstream']) {
        const correlationId = `browser-${order}-${scenario}`;
        await request.post(`/fixture/start?scenario=${scenario}&correlationId=${correlationId}`);
        await expect.poll(async () => (await state(request)).pending).toBe(1);
        const during = await state(request);
        expect(during.outcomes).toHaveLength(scenario === 'delayed-auth' ? 0 : 1);
        await page.locator('#follow-latest').click();
        const rows = page.locator(`.log-row[data-correlation-id="${correlationId}"]`);
        const arrivals = rows.filter({ hasText: 'Gateway Request' });
        await expect(arrivals).toHaveCount(2); // public request and its actual /auth subrequest
        expect(await arrivals.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Gateway Request:')]));
        expect((await arrivals.allTextContents()).some(text => text.includes('Derived'))).toBe(false);
        expect(await arrivals.evaluateAll(rows => rows.every(row => row.dataset.level === 'INFO'))).toBe(true);
        if (info.project.name === 'chromium-mobile') await arrivals.first().tap();
        else await arrivals.first().click();
        await expect(page.locator('#event-metadata')).toContainText('emitted');
        await expect(page.locator('#event-metadata')).not.toContainText('Derived gateway request');
        const normalized = JSON.parse(await page.locator('#panel-json pre[data-help-key="logs.payload"]').textContent());
        expect(normalized.event.provenance.kind).toBe('emitted'); expect(normalized.details.status).toBeUndefined();
        await page.locator('#tab-raw').click();
        const raw = await page.locator('.raw-source-text').textContent();
        expect(JSON.parse(raw).details.type).toBe('GATEWAY_REQUEST');
        expect(during.records.some(record => JSON.stringify(record) === raw)).toBe(true);
        await expect(page.locator('#panel-raw')).not.toContainText('source text belongs to the gateway response');
        await page.locator('#tab-json').click();
        await page.getByRole('checkbox', { name: 'Explain this page' }).check();
        if (info.project.name === 'chromium-mobile') await page.locator('#tab-raw').tap();
        else await page.locator('th[data-help-key="logs.message"]').focus();
        await expect(page.getByRole('tooltip')).toContainText('arrival');
        await page.getByRole('checkbox', { name: 'Explain this page' }).uncheck();
        await page.locator('#tab-json').click();
        await request.post('/fixture/release');
        await expect.poll(async () => (await state(request)).outcomes.length).toBe(scenario === 'delayed-auth' ? 1 : 2);
        await page.locator('#follow-latest').click();
        await expect(rows).toHaveCount(4);
        await expect(arrivals).toHaveCount(2);
        if (order === 'flow') await expect(page.locator('.flow-group').first()).toBeVisible();
    }
    const interrupted = `browser-${order}-interrupted`;
    await request.post(`/fixture/start?scenario=delayed-auth&correlationId=${interrupted}`);
    await expect.poll(async () => (await state(request)).pending).toBe(1);
    await page.locator('#follow-latest').click();
    const interruptedRows = page.locator(`.log-row[data-correlation-id="${interrupted}"]`);
    await expect(interruptedRows).toHaveCount(2);
    const result = await request.post('/fixture/interrupt'); expect(result.ok()).toBe(true);
    await expect.poll(async () => (await state(request)).outcomes.length).toBe(3);
    await request.post('/fixture/release');
    await page.locator('#follow-latest').click();
    await expect(interruptedRows).toHaveCount(2);
    expect((await state(request)).records.filter(record => record.details?.correlationId === interrupted).every(record => record.details.type === 'GATEWAY_REQUEST')).toBe(true);
    await testInfoEvidence(info, page, request, order);
});

/** Persist one compact actual-observation matrix and a representative screenshot. */
async function testInfoEvidence(info, page, request, order) {
    const observed = await state(request);
    await info.attach('real-arrival-observations', { body: JSON.stringify({ order,
        requestCount: observed.requests.length, outcomes: observed.outcomes,
        records: observed.records.map(({ details }) => ({ type: details.type, arrivalId: details.arrivalId,
            parentArrivalId: details.parentArrivalId, correlationId: details.correlationId, url: details.url, status: details.status })) }), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('real-gateway-arrivals.png'), fullPage: true });
}
