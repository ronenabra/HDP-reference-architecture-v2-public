'use strict';
/** Real mounted Admin routes/controllers, focused presentation and pending-navigation checks. */
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = process.env.PCM_NAV_REPO || path.resolve(__dirname, '../../..');
let fixture;
test.beforeAll(async () => { fixture = await require(path.join(root, 'test-support/admin-shell-fixture')).startAdminShellFixture(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => { await page.setExtraHTTPHeaders({ 'x-admin-password': fixture.password }); });
const selected = page => page.locator('[data-admin-section][aria-current="page"]');

/** Capture form successful-value state without persisting any credential or file bytes. */
const formState = page => page.locator('form').evaluateAll(nodes => nodes.map(form => ({
    action: form.getAttribute('action'), fields: [...form.querySelectorAll('[name]')].map(node => [node.name, node.type === 'password' ? '' : node.value, node.checked, node.disabled])
})));

test('seven areas, exact source, refresh, back/forward and legacy fragments are passive', async ({ page }, info) => {
    const writes = [], errors = [];
    page.on('request', req => { if (!['GET','HEAD'].includes(req.method())) writes.push(`${req.method()} ${new URL(req.url()).pathname}`); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${fixture.base}/admin`);
    await expect(selected(page)).toHaveText('Overview');
    await page.locator('[data-admin-section="sources"]').click();
    await expect(selected(page)).toHaveText('Sources & data');
    const source = fixture.config.healthOrganizations[1].dataSourceOrganization.id;
    await page.locator('[data-source-address]').filter({ hasText: fixture.config.healthOrganizations[1].name }).click();
    expect(new URL(page.url()).searchParams.get('source')).toBe(source);
    await page.locator('[data-admin-section="security"]').click();
    await expect(selected(page)).toHaveText('Security & access');
    await page.goBack(); await expect(selected(page)).toHaveText('Sources & data');
    expect(new URL(page.url()).searchParams.get('source')).toBe(source);
    await page.goForward(); await expect(selected(page)).toHaveText('Security & access');
    for (const area of ['apps','certificates','logs','maintenance','overview']) {
        await page.locator(`[data-admin-section="${area}"]`).click(); await expect(selected(page)).toHaveAttribute('data-admin-section', area);
    }
    const time = await page.locator('time').textContent();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('time')).not.toHaveText(time);
    await page.goto(`${fixture.base}/admin#presence-limits`); await expect(selected(page)).toHaveAttribute('data-admin-section','sources');
    await page.goto(`${fixture.base}/admin?section=sources&source=stale-source`);
    await expect(page.getByRole('alert')).toContainText('no longer configured');
    await page.goto(`${fixture.base}/admin?section=unknown`); await expect(selected(page)).toHaveAttribute('data-admin-section','overview');
    await expect(page.getByRole('alert')).toContainText('area is unavailable');
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(fixture.unchanged()).toBe(true);
    await info.attach('passive.json', { body: JSON.stringify({ writes, errors, configUnchanged: fixture.unchanged(), source }), contentType: 'application/json' });
});

test('rendered responsive hierarchy, exact copy/fallback and actual icon-free Explain popups', async ({ page }, info) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const area of ['overview','sources','security','apps','certificates','logs','maintenance']) {
        await page.goto(`${fixture.base}/admin?section=${area}`);
        for (const [width, zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${area} ${width} zoom${zoom}`).toBe(true);
            await expect(page.getByRole('main')).toBeVisible(); await expect(page.getByRole('navigation', { name:'Admin areas' })).toBeVisible();
            const toggle = page.getByRole('checkbox',{name:'Explain this page'});
            await toggle.scrollIntoViewIfNeeded(); const before = await page.locator('.sandbox-header').boundingBox();
            const forms = await formState(page);
            await toggle.check(); expect(await page.locator('.sandbox-header').boundingBox()).toEqual(before);
            const target = page.locator(`[data-admin-section="${area}"]`); await target.focus();
            await expect(page.getByRole('tooltip')).toBeVisible(); await expect(page.getByRole('tooltip')).toContainText(({
                overview:'saved configuration',sources:'exact source',security:'authorization',apps:'registered callbacks',certificates:'private keys',logs:'sanity check',maintenance:'Clinical databases'
            })[area]);
            await page.keyboard.press('Escape'); await expect(target).toBeFocused();
            await toggle.uncheck(); expect(await formState(page)).toEqual(forms);
            expect(await page.locator('.help-icon, .help-gutter, .explain-icon').count()).toBe(0);
            if (width === 1440 && zoom === 1 || width === 320) await page.screenshot({ path: info.outputPath(`${area}-${width}.png`), fullPage: true });
        }
    }
    await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
    await page.setViewportSize({ width:390,height:844 }); await page.goto(`${fixture.base}/admin`);
    const row = page.locator('[data-endpoint="pcmApi"]'), exact = await row.locator('[data-exact-address]').textContent();
    await page.evaluate(() => { window.copiedAddresses=[]; Object.defineProperty(navigator,'clipboard',{ configurable:true, value:{ writeText:async value => {window.copiedAddresses.push(value);} } }); });
    await row.getByRole('button',{ name:'Copy exact address' }).click();
    expect(await page.evaluate(() => window.copiedAddresses)).toEqual([exact]); await expect(row.locator('[data-copy-status]')).toHaveText('Exact address copied.');
    await page.evaluate(() => { Object.defineProperty(navigator,'clipboard',{ configurable:true, value:{ writeText:async () => {throw new Error('blocked');} } }); });
    await row.getByRole('button',{ name:'Copy exact address' }).click();
    await expect(row.locator('[data-copy-status]')).toContainText('Automatic copy unavailable'); expect(await page.evaluate(() => window.getSelection().toString())).toBe(exact);
    const disabled = page.locator('[data-endpoint="teamDataSource"]'); await expect(disabled).toContainText('Disabled'); await expect(disabled.locator('a')).toHaveCount(0);
    const toggle=page.getByRole('checkbox',{name:'Explain this page'});await toggle.check();await row.getByRole('button',{name:'Copy exact address'}).focus();
    await expect(page.getByRole('tooltip')).toContainText('complete configured address');await page.screenshot({path:info.outputPath('copy-help-mobile.png'),fullPage:true});
    expect(errors).toEqual([]); expect(fixture.unchanged()).toBe(true);
});

test('whole Admin navigation stays guarded during upload and resumed polling', async ({ page }, info) => {
    await page.goto(`${fixture.base}/admin?section=overview`); await page.locator('[data-admin-section="sources"]').click();
    await page.locator(`[data-source-address="${fixture.config.healthOrganizations[0].dataSourceOrganization.id}"]`).click();
    await page.getByRole('link',{name:'Clinical data',exact:true}).click();
    let release, releaseB, submitted=false, submittedB=false;
    await page.route('**/admin/api/fhir-servers/ho-a/imports', async route => {
        submitted=true; await new Promise(resolve => { release=resolve; });
        await route.fulfill({ contentType:'application/json',status:202,body:JSON.stringify({id:'owned-pending22',serverId:'ho-a',phase:'loading',status:'running',currentStage:'transaction-waiting'}) });
    });
    await page.route('**/admin/api/fhir-servers/ho-a/data', async route => {
        submittedB=true; await new Promise(resolve => { releaseB=resolve; });
        await route.fulfill({contentType:'application/json',status:202,body:JSON.stringify({id:'owned-pending22-b',serverId:'ho-a',kind:'reset',phase:'failed',status:'failed',currentStage:'failed'})});
    });
    let finish=false,polls=0;
    await page.route('**/admin/api/data-operations/owned-pending22', route => {polls++;return route.fulfill({contentType:'application/json',body:JSON.stringify({id:'owned-pending22',serverId:'ho-a',phase:finish?'failed':'loading',status:finish?'failed':'running',currentStage:finish?'failed':'transaction-waiting'})});});
    const form=page.locator('[data-managed-fhir-server="ho-a"] form[data-async-operation]').first();
    await form.locator('input[type=file]').setInputFiles({name:'owned.source.transaction.json',mimeType:'application/json',buffer:Buffer.from('{"resourceType":"Bundle","type":"transaction","entry":[]}')});
    await form.getByRole('button',{name:'Check bundle and import'}).click(); await expect.poll(()=>submitted).toBe(true);
    const neighbour=page.locator('[data-managed-fhir-server="ho-a"] form[data-method="DELETE"]');
    await neighbour.locator('input[type=checkbox]').check();
    page.once('dialog',dialog=>dialog.accept());
    await neighbour.getByRole('button',{name:'Delete all data'}).click();await expect.poll(()=>submittedB).toBe(true);
    const sourceUrl=page.url();
    for(const selector of ['[data-admin-section="security"]','.sandbox-navigation a:has-text("Services")','.admin-source-links a']) {
        await page.locator(selector).first().click();expect(page.url()).toBe(sourceUrl);
    }
    await expect(page.locator('[data-admin-navigation-status]')).toContainText('upload or status check');
    const leaving=page.waitForEvent('dialog'); await page.evaluate(()=>history.back());
    const dialog=await leaving;expect(dialog.type()).toBe('beforeunload');await dialog.dismiss();expect(page.url()).toBe(sourceUrl);
    release();await expect.poll(()=>polls).toBeGreaterThan(0);
    await page.locator('[data-admin-section="maintenance"]').click();expect(page.url()).toBe(sourceUrl);
    const refresh=page.locator('[data-admin-refresh]');await expect(refresh).toBeDisabled();
    await page.screenshot({path:info.outputPath('pending-navigation.png'),fullPage:true});
    finish=true;await expect(page.locator('#data-operation-ho-a')).toContainText('The import did not finish');
    await page.locator('[data-admin-section="security"]').click();expect(page.url()).toBe(sourceUrl);
    await expect(refresh).toBeDisabled();releaseB();await expect(page.locator('#data-delete-ho-a')).toContainText('Deletion did not finish');
    await page.locator('[data-admin-section="security"]').click();await expect(selected(page)).toHaveAttribute('data-admin-section','security');
    expect(fixture.unchanged()).toBe(true);
});

test('login and renewal/error/legacy diagnostics share header, Explain and safe return', async ({ browser, page }, info) => {
    const context=await browser.newContext();const login=await context.newPage();
    await login.goto(`${fixture.base}/admin?section=certificates`);await expect(login.getByRole('heading',{name:'Sign in to Admin'})).toBeVisible();
    await expect(login.getByRole('checkbox',{name:'Explain this page'})).toBeVisible();await login.screenshot({path:info.outputPath('admin-login.png'),fullPage:true});await context.close();
    await page.goto(`${fixture.base}/admin?section=certificates`);await page.getByRole('button',{name:'How to renew certificates'}).click();
    await expect(page.getByText('No credentials were changed.',{exact:false}).first()).toBeVisible();await expect(selected(page)).toHaveAttribute('data-admin-section','certificates');
    await page.screenshot({path:info.outputPath('renewal-result.png'),fullPage:true});
    await page.goto(`${fixture.base}/admin?section=sources&source=admin22-custom&view=diagnostics`);await page.getByRole('button',{name:'Test source'}).click();
    await expect(page.getByRole('heading',{name:'Source readiness'})).toBeVisible();await expect(page.locator('pre')).toContainText('admin22-custom');
    await expect(page.getByRole('link',{name:'Back to Admin',exact:true})).toHaveAttribute('href','/pcm/admin?section=sources&source=admin22-custom&view=diagnostics');
    await page.screenshot({path:info.outputPath('source-readiness-result.png'),fullPage:true});
    await page.goto(`${fixture.base}/admin/logs/view?operationId=owned22&target=ho-a`);await expect(page.getByRole('heading',{name:'Import diagnostics'})).toBeVisible();await expect(page.locator('input[name=operationId]')).toHaveValue('owned22');
    await page.getByRole('link',{name:'Back to Admin',exact:true}).click();await expect(selected(page)).toHaveAttribute('data-admin-section','logs');
    await page.goto(`${fixture.base}/admin/logs/view?since=invalid`);await expect(page.getByText('Invalid since time',{exact:true})).toBeVisible();
    await expect(selected(page)).toHaveAttribute('data-admin-section','logs');expect(fixture.unchanged()).toBe(true);
});

/** Popup behavior, rather than catalog-key counts, establishes copy parity. */
test('five corrected explanations match the current controls and opaque client example', async ({page},info) => {
    await page.setViewportSize({width:390,height:844});
    for(const [area,selector,expected,retired] of [
        ['security','#access-token-lifetime','Issued-token expiry checks remain enforced','tokenExpiry'],
        ['security','[data-help-key="admin.security-invariants"]','Approved scope, exact Patient/source context','simulation controls'],
        ['sources','[data-managed-fhir-server="ho-a"] [data-help-key="admin.data-import"]','does not publish a Doctor picker inventory','making its patients available'],
        ['sources','#source-client-id','pcm-source-local-0001','Even if it looks like a URL'],
        ['certificates','[data-help-key="admin.cert-regenerate"]','recreates its listeners','reload new key material automatically']
    ]) {
        await page.goto(`${fixture.base}/admin?section=${area}${selector.includes('data-managed-fhir-server') ? '&source=' + encodeURIComponent(fixture.config.healthOrganizations[0].dataSourceOrganization.id) + '&view=data' : selector === '#source-client-id' ? '&view=onboarding' : ''}`);await page.getByRole('checkbox',{name:'Explain this page'}).check();
        const target=page.locator(selector);await target.scrollIntoViewIfNeeded();
        const disabled=await target.isDisabled();
        if(disabled){const box=await target.boundingBox();await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);}else await target.focus();
        await expect(page.getByRole('tooltip')).toContainText(expected);await expect(page.getByRole('tooltip')).not.toContainText(retired);
        await page.screenshot({path:info.outputPath(`corrected-${area}-${selector.includes('token')?'token':selector.includes('mapped')?'filtering':selector.includes('import')?'import':selector.includes('client')?'client-id':'renewal'}.png`)});
        await page.getByRole('button',{name:'Dismiss explanation'}).click();await expect(disabled?page.getByRole('checkbox',{name:'Explain this page'}):target).toBeFocused();
        if(selector==='#source-client-id')await expect(target).toHaveAttribute('placeholder','Leave blank to generate');
    }
    expect(fixture.unchanged()).toBe(true);
});

/** Non-secret failed-form inputs survive; a rejected request starts no operation. */
test('validation keeps the exact source draft and checkbox choices without saving', async ({page},info) => {
    await page.goto(`${fixture.base}/admin?section=sources&view=onboarding`);
    await page.locator('#source-name').fill('Owned draft <keep>');await page.locator('#source-endpoint').fill('https://invalid-source.example.test/fhir');
    await page.locator('#source-client-id').fill('https://invalid.example.test/client');
    await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(selected(page)).toHaveAttribute('data-admin-section','sources');
    await expect(page.getByText('Could not complete admin action')).toBeVisible();
    await expect(page.locator('#source-name')).toHaveValue('Owned draft <keep>');await expect(page.locator('#source-endpoint')).toHaveValue('https://invalid-source.example.test/fhir');
    await expect(page.locator('#source-client-id')).toHaveValue('https://invalid.example.test/client');await expect(page.locator('[name=credentialMode]')).toHaveValue('generate');
    await page.screenshot({path:info.outputPath('failed-source-draft.png'),fullPage:true});expect(fixture.unchanged()).toBe(true);
});
