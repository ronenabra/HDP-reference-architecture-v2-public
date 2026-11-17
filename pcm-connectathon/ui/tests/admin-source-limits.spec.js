'use strict';
/** Real limits forms: responsive effective values, bounded saves and reference Explain. */
const {test,expect}=require('@playwright/test');
const path=require('node:path'),fs=require('node:fs');
const root=process.env.PCM_NAV_REPO||path.resolve(__dirname,'../../..');
let fixture;
test.beforeAll(async()=>{fixture=await require(path.join(root,'test-support/admin-shell-fixture')).startAdminShellFixture();if(process.env.PCM_QUERY_NATIVE_PROBE)await require(process.env.PCM_QUERY_NATIVE_PROBE).initialize(fixture);});
test.afterAll(async()=>{if(process.env.PCM_QUERY_NATIVE_PROBE)await require(process.env.PCM_QUERY_NATIVE_PROBE).cleanup();await fixture?.close();});
test.beforeEach(async({page})=>{await page.setExtraHTTPHeaders({'x-admin-password':fixture.password});});
const address=source=>`${fixture.base}/admin?section=sources${source?`&source=${source}&view=limits`:'&view=defaults'}`;
const id=()=>fixture.config.healthOrganizations[0].dataSourceOrganization.id;

test('limits26 saved origins and exact units remain passive at desktop/mobile/zoom with keyboard and native-touch Help',async({page},info)=>{
    const writes=[],errors=[];page.on('request',req=>{if(!['GET','HEAD'].includes(req.method()))writes.push(req.method());});page.on('pageerror',e=>errors.push(e.message));
    await page.goto(address(id()));await expect(page.locator('main')).toContainText('Saved effective:');await expect(page.locator('main')).toContainText('Shared default');await expect(page.locator('main')).toContainText('Runtime adoption is not checked here');
    await expect(page.locator('#limit-maxPatients')).toBeDisabled();
    await page.getByRole('checkbox',{name:'Explain this page'}).check();
    const selector=page.getByRole('combobox',{name:'Batch payload value origin'});await selector.focus();await expect(page.getByRole('tooltip')).toContainText('Inherit removes');
    await page.keyboard.press('Escape');await expect(selector).toBeFocused();
    await selector.selectOption('custom');const field=page.locator('#limit-maxPayloadBytes');await field.tap();await expect(page.getByRole('tooltip')).toContainText('1,024');
    await page.getByRole('button',{name:'Dismiss explanation',exact:true}).click();await expect(field).toBeFocused();
    await page.getByRole('checkbox',{name:'Explain this page'}).uncheck();
    await page.locator('[data-limit=maxPayloadBytes] summary').click();await expect(page.locator('#raw-maxPayloadBytes')).toContainText('65536 bytes');
    for(const [width,zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]){
        await page.setViewportSize({width,height:1000});await page.evaluate(z=>{document.documentElement.style.zoom=String(z);},zoom);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`${width} zoom${zoom}`).toBe(true);
        await expect(page.getByRole('button',{name:'Save source limits',exact:true})).toBeVisible();
        if(width===1440||width===320)await page.screenshot({path:info.outputPath(`limits-${width}-zoom${zoom}.png`),fullPage:true});
    }
    expect(writes).toEqual([]);expect(errors).toEqual([]);expect(fixture.unchanged()).toBe(true);
});

test('limits26 custom save/inherit, stale draft and invalid units keep exact target and honest pending adoption',async({page},info)=>{
    await page.goto(address(id()));
    await page.getByRole('combobox',{name:'Patients per presence batch value origin'}).selectOption('custom');await page.locator('#limit-maxPatients').fill('105');
    await page.getByRole('button',{name:'Save source limits',exact:true}).click();await expect(page).toHaveURL(/view=limits&limitsSaved=/);await expect(page.locator('main')).toContainText('Source adoption pending operator checks');await expect(page.locator('main')).toContainText('Source override (ho-a)');
    await page.getByRole('combobox',{name:'Batch payload value origin'}).selectOption('custom');await page.locator('#limit-maxPayloadBytes').fill('0.0010241');
    await page.getByRole('button',{name:'Save source limits',exact:true}).click();await expect(page.locator('[role=alert]').filter({hasText:'exact whole bytes'})).toBeVisible();await expect(page.locator('#limit-maxPayloadBytes')).toHaveValue('0.0010241');await expect(page.locator('#limit-maxPayloadBytes')).toHaveAttribute('aria-invalid','true');await expect(page.locator('[data-source-workspace]')).toHaveAttribute('data-source-workspace',id());
    await page.locator('#limit-maxPayloadBytes').fill('0.001024');await page.locator('[data-limits-form]').first().locator('[name=expectedRevision]').evaluate(input=>{input.value='-1';});
    await page.getByRole('button',{name:'Save source limits',exact:true}).click();await expect(page.locator('[role=alert]').filter({hasText:'Limits changed'})).toBeVisible();await expect(page.locator('#limit-maxPayloadBytes')).toHaveValue('0.001024');
    await page.screenshot({path:info.outputPath('limits-stale-draft.png'),fullPage:true});
    await page.goto(address(id()));await page.getByRole('combobox',{name:'Patients per presence batch value origin'}).selectOption('inherit');await page.getByRole('button',{name:'Save source limits',exact:true}).click();await expect(page.locator('#limit-maxPatients')).toBeDisabled();
    const saved=JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));expect(saved.presence.sources?.['ho-a']).toBeUndefined();
    await page.locator('#upload-maxBytes').fill('805.306367');await page.getByRole('button',{name:'Save upload limits',exact:true}).click();await expect(page.locator('main')).toContainText('Source adoption pending operator checks');expect(JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)).healthOrganizations[0].clinicalData.limits.maxBytes).toBe(805306367);
    await page.goto(address('admin22-custom'));await expect(page.locator('main')).toContainText('external operator');await expect(page.getByRole('button',{name:'Save upload limits',exact:true})).toHaveCount(0);
});

test('limits26 managed upload block preserves captured operation and external/default forms expose no imports',async({page},info)=>{
    const {DataOperationRegistry}=require(path.join(root,'src/pcm-core/src/data-operations'));const registry=new DataOperationRegistry();const operation=registry.create('ho-a','import',{targetIdentity:JSON.stringify(fixture.config.healthOrganizations[0])});
    registry.transition(operation.id,'failed',{mutationSubmitted:true,needsReconciliation:true});const before=fs.readFileSync(registry.file(operation.id));
    await page.goto(address(id()));await expect(page.getByRole('button',{name:'Save upload limits',exact:true})).toBeDisabled();await expect(page.locator('main')).toContainText(operation.id);
    await page.getByRole('checkbox',{name:'Explain this page'}).check();await page.getByRole('button',{name:'Save upload limits',exact:true}).tap({force:true});await expect(page.getByRole('tooltip')).toContainText('partially completed');await page.keyboard.press('Escape');
    await page.screenshot({path:info.outputPath('limits-blocked.png'),fullPage:true});expect(fs.readFileSync(registry.file(operation.id)).equals(before)).toBe(true);
    await page.goto(address());await expect(page.getByRole('button',{name:'Save default limits',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save upload limits',exact:true})).toHaveCount(0);
    fs.rmSync(registry.directory,{recursive:true,force:true});
});

/** One focused real form journey; optional native probe is bound to a disposable managed HAPI fixture. */
test('clinical query runtime controls save inherit drafts and narrow layout',async({page},info)=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(address(id()));
    const section=page.locator('#clinical-query-limits'), form=section.locator('form');
    await expect(section.getByRole('heading',{name:'Clinical query processing'})).toBeVisible();
    await expect(form.locator('[data-query-limit]')).toHaveCount(14);
    const setting=form.locator('[name="mode.maxPagePayloadBytes"]'),field=page.locator('#query-maxPagePayloadBytes');
    await expect(field).toBeDisabled();await setting.selectOption('custom');await field.fill('1');
    await form.getByRole('button',{name:'Save clinical query limits',exact:true}).click();
    await expect(section).toContainText('Source override (ho-a)');await expect(field).toHaveValue('1');
    if(process.env.PCM_QUERY_NATIVE_PROBE) await require(process.env.PCM_QUERY_NATIVE_PROBE).probe('low',503);
    await setting.selectOption('custom');await field.fill('2097152');
    await form.getByRole('button',{name:'Save clinical query limits',exact:true}).click();
    await expect(field).toHaveValue('2097152');
    if(process.env.PCM_QUERY_NATIVE_PROBE) await require(process.env.PCM_QUERY_NATIVE_PROBE).probe('increased',200);
    const before=fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await field.fill('1.5');await form.getByRole('button',{name:'Save clinical query limits',exact:true}).click();
    await expect(field).toHaveValue('1.5');await expect(field).toHaveAttribute('aria-invalid','true');expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    await field.fill('2097152');await form.locator('[name=expectedRevision]').evaluate(node=>node.value='-1');
    await form.getByRole('button',{name:'Save clinical query limits',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Limits changed');
    await expect(field).toHaveValue('2097152');expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    await page.goto(address(id()));await setting.selectOption('inherit');await form.getByRole('button',{name:'Save clinical query limits',exact:true}).click();await expect(field).toBeDisabled();
    await page.setViewportSize({width:390,height:844});await section.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath('clinical-query-narrow.png'),fullPage:true});
    await page.goto(address());await expect(page.getByRole('button',{name:'Save clinical query defaults',exact:true})).toBeVisible();
    await page.goto(address('admin22-custom'));await expect(section).toContainText('no supported local HAPI query worker');await expect(section.locator('form')).toHaveCount(0);
    expect(errors).toEqual([]);
});
