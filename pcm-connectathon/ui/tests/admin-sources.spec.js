'use strict';
/** Real registered-source directory/workspaces, exact legacy mapping commands and guarded navigation. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture, legacy, managed, other;
test.beforeAll(async () => {
    fixture = await require(path.join(root, 'test-support/admin-sources-fixture')).startAdminSourcesFixture();
    const sources = require(path.join(root, 'src/pcm-core/src/data-sources')).getConfiguredDataSources(fixture.config, { includeDisabled: true });
    legacy = sources.find(source => source.compatibilityOnly).id;
    managed = sources.find(source => source.healthOrganizationId === fixture.config.healthOrganizations[0].id).id;
    other = sources.find(source => source.healthOrganizationId === fixture.config.healthOrganizations[1].id).id;
});
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });
const url = (source = '', view = '') => `${fixture.base}/admin?${new URLSearchParams({ section: 'sources', ...(source ? { source } : {}), ...(view ? { view } : {}) })}`;
const workspace = page => page.locator('[data-source-workspace]');

test('dynamic grouped directory and single workspaces remain passive, exact and responsive with real Explain', async ({ page }, info) => {
    const writes = [], errors = [];
    page.on('request', req => { if (!['GET','HEAD'].includes(req.method())) writes.push(req.url()); });
    page.on('pageerror', error => errors.push(error.message));
    for (const [name, source, view] of [['directory','',''],['managed',managed,'registration'],['mapping',legacy,'mappings'],['custom','source-fourth-long','registration']]) {
        await page.goto(url(source, view));
        if (source) await expect(workspace(page)).toHaveAttribute('data-source-workspace',source);
        else { await expect(page.locator('#group-managed h3')).toHaveText('Managed HAPI (3)'); await expect(page.locator('#group-custom h3')).toHaveText('Custom sources (2)'); }
        for (const [width, zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]) {
            await page.setViewportSize({ width, height: 1000 }); await page.evaluate(z => { document.documentElement.style.zoom = String(z); }, zoom);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${name} ${width} zoom${zoom}`).toBe(true);
            if (name === 'mapping') {
                await expect(page.locator('.identity-mappings')).toContainText('000000018'); await expect(page.locator('.identity-mappings')).toContainText('Local<exact>&000000002');
                for (const button of await page.locator('.identity-mappings button').all()) await expect(button).toBeVisible();
            }
            const toggle = page.getByRole('checkbox',{name:'Explain this page'}); await toggle.check();
            const target = source ? page.getByRole('navigation',{name:'Source workspace views'}).getByRole('link').first() : page.locator('[data-source-address]').first();
            await target.focus(); await expect(page.getByRole('tooltip')).toBeVisible(); await expect(page.getByRole('tooltip')).toContainText(source ? 'Registration' : 'registered source');
            await page.keyboard.press('Escape'); await expect(target).toBeFocused(); await toggle.uncheck();
            if (width === 1440 && zoom === 1 || width === 320) await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage:true });
        }
        await page.evaluate(() => {document.documentElement.style.zoom = '1';});
    }
    await page.setViewportSize({width:390,height:844}); await page.goto(url(legacy,'mappings'));
    await page.getByRole('checkbox',{name:'Explain this page'}).check();
    await page.locator('#mapping-business-id').tap(); await expect(page.getByRole('tooltip')).toContainText('national-ID naming system');
    await page.getByRole('button',{name:'Dismiss explanation'}).tap();
    await page.goto(url('source-disabled')); await expect(page.getByRole('alert')).toContainText('unavailable'); await expect(workspace(page)).toContainText('Disabled');
    for (const view of ['trust','credentials']) { await page.goto(url('source-disabled',view)); await expect(workspace(page).locator('form')).toHaveCount(0); }
    await page.goto(url('missing-current-source')); await expect(page.getByRole('alert')).toContainText('no longer configured'); await expect(workspace(page)).toHaveCount(0);
    expect(errors).toEqual([]); expect(writes).toEqual([]); expect(fixture.unchanged()).toBe(true);
    await info.attach('passivity.json',{body:JSON.stringify({writes,errors,configurationUnchanged:fixture.unchanged()}),contentType:'application/json'});
});

test('source/view refresh, context links, legacy bookmarks and switch cannot submit another source draft', async ({ page }) => {
    const writes = []; page.on('request', req => {if (req.method() === 'POST') writes.push(req.url());});
    await page.goto(url(managed)); await page.locator('[name="institutionType"]').selectOption('other');
    await page.getByRole('link',{name:'Back to Managed HAPI'}).click(); await page.locator(`[data-source-address="${other}"]`).click();
    await expect(workspace(page)).toHaveAttribute('data-source-workspace',other); await expect(page.locator('[name="institutionType"]')).toHaveValue('hospital');
    await page.getByRole('link',{name:'Limits & capabilities',exact:true}).click(); await page.reload();
    expect(new URL(page.url()).searchParams.get('source')).toBe(other); expect(new URL(page.url()).searchParams.get('view')).toBe('limits');
    await page.getByRole('link',{name:'Security & access',exact:true}).click(); await page.goBack(); await expect(workspace(page)).toHaveAttribute('data-source-workspace',other);
    await page.goto(`${fixture.base}/admin#mapping-business-id`); await expect(workspace(page)).toHaveAttribute('data-source-workspace',legacy); expect(new URL(page.url()).searchParams.get('view')).toBe('mappings');
    await page.goto(`${fixture.base}/admin#server-${fixture.config.healthOrganizations[0].clinicalData.serverId}`); await expect(page.locator('[data-managed-fhir-server]')).toHaveCount(1);
    await page.goto(`${fixture.base}/admin#source-stale-bookmark`); await expect(page.getByRole('alert')).toContainText('no longer configured'); await expect(workspace(page)).toHaveCount(0);
    await page.goto(url('source-fourth-long','data')); await expect(page.getByRole('alert')).toContainText('does not apply'); await expect(page.locator('[data-async-operation]')).toHaveCount(0);
    expect(writes).toEqual([]); expect(fixture.unchanged()).toBe(true);
});

test('actual legacy add/upsert/remove preserve leading zeros, errors, conflict drafts and native source configuration', async ({ page }, info) => {
    await page.goto(url(legacy,'mappings'));
    await page.locator('#mapping-business-id').fill('https://owned.example.test/identifier|'); await page.locator('#mapping-internal-id').fill('Local<draft>&000001');
    await page.getByRole('button',{name:'Add',exact:true}).click(); await expect(page.getByText('Could not complete admin action',{exact:true})).toBeVisible();
    await expect(workspace(page)).toHaveAttribute('data-source-workspace',legacy); await expect(page.locator('#mapping-internal-id')).toHaveValue('Local<draft>&000001');
    await page.locator('#mapping-business-id').fill('https://owned.example.test/identifier|000000018');
    await page.locator('[name="expectedRevision"]').last().evaluate(node => {node.value = '-1';});
    await page.getByRole('button',{name:'Add',exact:true}).click(); await expect(page.getByText('Identity mappings changed.',{exact:false})).toBeVisible();
    await expect(page.locator('#mapping-business-id')).toHaveValue('https://owned.example.test/identifier|000000018');
    await page.getByRole('button',{name:'Add',exact:true}).click();
    const row = page.locator('.identity-mappings tr').filter({hasText:'https://owned.example.test/identifier'}); await expect(row).toContainText('000000018'); await expect(row).toContainText('Local<draft>&000001');
    const form = row.locator('form'); await expect(form.locator('input[type="checkbox"]')).toHaveCount(0);
    await row.getByRole('button',{name:'Remove',exact:true}).click(); await expect(page.locator('.identity-mappings')).not.toContainText('https://owned.example.test/identifier');
    await expect(page.locator('.identity-mappings')).toContainText('000000018');
    const config = require(path.join(root,'src/pcm-core/src/team-config')).loadTeamConfig();
    expect(config.healthOrganizations).toEqual(fixture.config.healthOrganizations);
    expect(config.security.dsGatewayToFhirServer).toEqual(fixture.config.security.dsGatewayToFhirServer);
    await page.screenshot({path:info.outputPath('mapping-after-remove.png'),fullPage:true});
});

test('whole Admin navigation protects selected managed upload before an operation ID', async ({ page }) => {
    await page.goto(url(managed,'data'));
    let entered, release; const pending = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {release = resolve;});
    await page.route('**/admin/api/fhir-servers/*/imports', async route => { entered(); await gate; await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Owned controlled upload refusal'})}); });
    await page.locator('input[type="file"][name="bundle"]').setInputFiles({name:'owned.source.transaction.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    await page.getByRole('button',{name:'Check bundle and import'}).click(); await pending;
    page.once('dialog',dialog=>dialog.dismiss()); await page.getByRole('link',{name:'Back to Managed HAPI'}).click(); await expect(workspace(page)).toHaveAttribute('data-source-workspace',managed);
    page.once('dialog',dialog=>dialog.dismiss()); await page.getByRole('link',{name:'Registration',exact:true}).click(); expect(new URL(page.url()).searchParams.get('view')).toBe('data');
    release(); await expect(page.locator('[id^="data-operation-"]')).toContainText('Owned controlled upload refusal');
});

/** Actual classification save changes only the selected saved classification. */
test('institution save and stale conflict preserve source authority, endpoints and the rejected draft', async ({ page }, info) => {
    await page.goto(url(other));
    await page.locator('[name="institutionType"]').selectOption('other');
    await page.getByRole('button',{name:'Save institution type'}).click();
    await expect(page.getByRole('status').filter({hasText:'Institution type saved.'})).toBeVisible();
    await expect(page.locator('[name="institutionType"]')).toHaveValue('other');
    const current = require(path.join(root,'src/pcm-core/src/team-config')).loadTeamConfig();
    const changed = current.healthOrganizations.find(source => source.dataSourceOrganization.id === other);
    expect(changed.institutionType).toBe('other');
    expect(current.healthOrganizations.map(source => source.endpoint)).toEqual(fixture.config.healthOrganizations.map(source => source.endpoint));
    expect(current.healthOrganizations.filter(source => source.dataSourceOrganization.id !== other)).toEqual(fixture.config.healthOrganizations.filter(source => source.dataSourceOrganization.id !== other));
    await page.locator('[name="institutionType"]').selectOption('hmo');
    await page.locator('[name="expectedRevision"]').evaluate(node => {node.value = '-1';});
    await page.getByRole('button',{name:'Save institution type'}).click();
    await expect(page.getByText('Source settings changed.',{exact:false})).toBeVisible();
    await expect(workspace(page)).toHaveAttribute('data-source-workspace',other); await expect(page.locator('[name="institutionType"]')).toHaveValue('hmo');
    expect(require(path.join(root,'src/pcm-core/src/team-config')).loadTeamConfig()).toEqual(current);
    await page.screenshot({path:info.outputPath('classification-conflict.png'),fullPage:true});
});
