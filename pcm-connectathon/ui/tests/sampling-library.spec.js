'use strict';
/** Actual Doctor template/client rendering for bounded sample states and cancellation. */
const { test, expect } = require('@playwright/test');
const fs = require('fs'), path = require('path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
const available = fs.existsSync(path.join(root, 'src/sp-client/src/views/patients.ejs'));
const ejs = available ? require(path.join(root, 'node_modules/ejs')) : null;
test.beforeEach(() => test.skip(!available, 'requires read-only repository mount'));
for (const state of ['loaded', 'partial', 'empty', 'error', 'cancelled', 'source-changed']) {
    test(`Standard sampling library ${state} shows only current candidates`, async ({ page }) => {
        let loads = 0, release;
        const html = ejs.render(fs.readFileSync(path.join(root, 'src/sp-client/src/views/patients.ejs'), 'utf8'), { teamId: 'sampling-fixture', identity: 'hospital-a', fixed: [{ idSystem: 'urn:test', idValue: '1', display: 'Standard one' }], sources: [{ id: 'ho-a', name: 'HO A' }, { id: 'ho-b', name: 'HO B' }], state: { sourceId: 'ho-a', state: 'unloaded' } });
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.pathname === '/patients') return route.fulfill({ contentType: 'text/html', body: html });
            if (url.pathname.startsWith('/assets/')) {
                const file = path.join(root, 'src/shared/ui', url.pathname.slice(8));
                return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : 'text/css', body: fs.existsSync(file) ? fs.readFileSync(file) : '' });
            }
            if (url.pathname === '/patients/source') return route.fulfill({ json: { state: 'unloaded' } });
            if (url.pathname === '/patients/load') {
                loads++;
                if (['cancelled', 'source-changed'].includes(state)) await new Promise(resolve => { release = resolve; });
                return route.fulfill({ status: state === 'error' ? 400 : 200, json: { state, patients: state === 'empty' ? [] : [{ idSystem: 'urn:synthetic', idValue: 'guid', display: '<script>bad()</script>' }], rejected: state === 'partial' ? 2 : 0, sourceName: 'HO A', refreshedAt: 'fixture-time', error: 'Authorization unavailable' } }).catch(() => {});
            }
            return route.fulfill({ body: '' });
        });
        await page.goto('http://sampling.example/patients');
        expect(loads).toBe(0);
        await page.getByRole('button', { name: 'Load up to 10 sandbox patients', exact: true }).click();
        await expect.poll(() => loads).toBe(1);
        if (state === 'cancelled') { await page.locator('#sample-cancel').click(); release(); }
        else if (state === 'source-changed') { await page.locator('#sample-source').selectOption('ho-b'); release(); }
        if (['cancelled', 'source-changed'].includes(state)) {
            await expect(page.locator('#sample-state')).toHaveText('Sample cleared'); await expect(page.locator('#sample-results button')).toHaveCount(0);
        } else if (state === 'error') await expect(page.locator('#sample-state')).toContainText('Authorization unavailable');
        else {
            await expect(page.locator('#sample-state')).toContainText(state);
            await expect(page.locator('#sample-results button')).toHaveCount(state === 'empty' ? 0 : 1);
            if (state === 'partial') await expect(page.locator('#sample-state')).toContainText('2 invalid/ambiguous/untagged');
        }
        expect(await page.locator('#sample-results script').count()).toBe(0);
        expect(loads).toBe(1);
    });
}
