'use strict';
/** Real protected EJS inventory with exact context, accessible copy and passive renewal. */
const { test, expect } = require('@playwright/test');
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
const saved = () => JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
const address = owner => `${fixture.base}/admin?section=certificates${owner ? '&owner=' + encodeURIComponent(owner) : ''}`;
/** Digest owned credential files, never exporting key bytes to browser artifacts. */
const hashes = () => Object.fromEntries(fs.readdirSync(process.env.CERTS_DIR).filter(name => fs.statSync(path.join(process.env.CERTS_DIR, name)).isFile()).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(process.env.CERTS_DIR, name))).digest('hex')]));
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/admin-shell-fixture')).startAdminShellFixture();
    fs.cpSync(require(path.join(root, 'test-support/certificates')).certificates(), process.env.CERTS_DIR, { recursive: true });
});
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });

test('certificate29 role rows filter exact owners, wrap at all widths, copy by keyboard and explain by native touch without mutation', async ({ page }, info) => {
    const writes = [], errors = []; page.on('request', req => { if (!['GET', 'HEAD'].includes(req.method())) writes.push(req.url()); }); page.on('pageerror', error => errors.push(error.message));
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH), credentials = hashes();
    await page.goto(address()); await expect(page.locator('[data-credential-row]').first()).toBeVisible();
    await expect(page.locator('[data-credential-inventory]')).toContainText('Negative fixture');
    await expect(page.locator('[data-credential-inventory]')).toContainText('Missing certificate');
    const owner = fixture.config.organizations.hospitalBServiceProvider.id;
    await page.getByLabel('Owner', { exact: true }).selectOption(owner); await page.getByRole('button', { name: 'Show owner', exact: true }).click();
    await expect(page.locator('[data-credential-row]')).toHaveCount(2); await expect(page.locator('[data-credential-inventory]')).toContainText('ES384'); await expect(page.locator('[data-credential-inventory]')).toContainText('listener adoption not checked');
    await page.locator('[data-credential-row]').first().getByText('Fingerprint and file location', { exact: true }).click();
    for (const [width, zoom] of [[1440, 1], [1024, 1], [390, 1], [320, 1], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await expect(page.locator('[data-copy-address]').first()).toBeVisible();
        await page.screenshot({ path: info.outputPath(`certificates-${width}-${zoom}.png`), fullPage: true });
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; }); await page.setViewportSize({ width: 390, height: 1000 });
    const row = page.locator('[data-credential-row]').first(), exact = await row.locator('[data-exact-address]').textContent(), copy = row.locator('[data-copy-address]');
    await page.evaluate(() => { window.copiedFingerprints = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedFingerprints.push(value); } } }); });
    await copy.focus(); await page.keyboard.press('Enter'); expect(await page.evaluate(() => window.copiedFingerprints)).toEqual([exact]); await expect(row.locator('[data-copy-status]')).toHaveText('Fingerprint copied.');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('blocked'); } } }); });
    await copy.focus(); await page.keyboard.press('Enter'); await expect(row.locator('[data-copy-status]')).toContainText('Automatic copy unavailable'); expect(await page.evaluate(() => window.getSelection().toString())).toBe(exact);
    const toggle = page.getByRole('checkbox', { name: 'Explain this page' }), ownerFilter = page.getByLabel('Owner', { exact: true });
    await toggle.scrollIntoViewIfNeeded(); const bounds = await ownerFilter.boundingBox(); await toggle.check(); expect(await ownerFilter.boundingBox()).toEqual(bounds);
    await ownerFilter.tap(); await expect(page.getByRole('tooltip')).toContainText('exact registry owner'); await page.keyboard.press('Escape'); await expect(ownerFilter).toBeFocused();
    await copy.focus(); await expect(page.getByRole('tooltip')).toContainText('complete base64url'); await page.getByRole('button', { name: 'Dismiss explanation', exact: true }).click(); await expect(copy).toBeFocused(); await toggle.uncheck();
    await row.getByRole('link', { name: 'Open app registration', exact: true }).click(); await expect(page).toHaveURL(/section=apps#provider-hospitalBServiceProvider$/);
    await page.locator('#provider-hospitalBServiceProvider').getByRole('link', { name: 'View app in Certificates', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`owner=${owner}$`));
    const source = fixture.config.healthOrganizations[1].dataSourceOrganization.id;
    await page.goto(address(source)); await page.getByRole('link', { name: 'Open source credentials', exact: true }).first().click(); await expect(page).toHaveURL(new RegExp(`source=${source}&view=credentials$`));
    await page.getByRole('link', { name: 'Open Certificates', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`owner=${source}$`));
    await page.goto(address('removed-owner')); await expect(page.getByRole('alert')).toContainText('no longer configured'); await expect(page.locator('[data-credential-row]')).toHaveCount(0); await page.screenshot({ path: info.outputPath('certificates-stale-owner.png'), fullPage: true });
    expect(await page.locator('body').textContent()).not.toMatch(/BEGIN.*PRIVATE KEY/); expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toMatch(/BEGIN|PRIVATE KEY/);
    await page.goto(`${fixture.base}/admin?section=overview`);
    const endpoint = page.locator('[data-endpoint="pcmApi"]'), endpointValue = await endpoint.locator('[data-exact-address]').textContent();
    await page.evaluate(() => { window.copiedAddresses = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedAddresses.push(value); } } }); });
    await endpoint.getByRole('button', { name: 'Copy exact address' }).click(); expect(await page.evaluate(() => window.copiedAddresses)).toEqual([endpointValue]); await expect(endpoint.locator('[data-copy-status]')).toHaveText('Exact address copied.');
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(hashes()).toEqual(credentials); expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
});

test('certificate29 renewal instructions are passive while the protected unsafe-regeneration refusal remains', async ({ page }, info) => {
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH), credentials = hashes(), tokens = require(path.join(root, 'src/pcm-core/src/store')).tokens.size;
    const writes=[],dialogs=[];page.on('request',req=>{if(!['GET','HEAD'].includes(req.method()))writes.push(req.url());});page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.dismiss();});
    await page.goto(address(fixture.config.organizations.serviceProvider.id));
    const review=page.getByRole('button',{name:'How to renew certificates',exact:true});
    await page.getByRole('checkbox',{name:'Explain this page'}).check();await review.focus();await expect(page.getByRole('tooltip')).toContainText('without confirmation or a request');await page.keyboard.press('Escape');await expect(review).toBeFocused();await page.getByRole('checkbox',{name:'Explain this page'}).uncheck();
    await review.click();const region=page.getByRole('region',{name:'Controlled certificate renewal'});await expect(region).toContainText('No credentials were changed');await expect(region).toContainText('--rotate-keys');await region.screenshot({path:info.outputPath('renewal-instructions.png')});
    await page.getByRole('button',{name:'Close instructions',exact:true}).click();await expect(review).toBeFocused();expect(writes).toEqual([]);expect(dialogs).toEqual([]);
    const refusal=await page.request.post(fixture.base+'/admin/certs/regenerate',{headers:{Accept:'application/json'}});expect(refusal.status()).toBe(409);
    expect(hashes()).toEqual(credentials);expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);expect(require(path.join(root,'src/pcm-core/src/store')).tokens.size).toBe(tokens);
});
