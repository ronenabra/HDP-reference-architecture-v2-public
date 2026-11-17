'use strict';
/** Actual R8 five-state presentation, passive Help/renewal and guarded R1 correction flows. */
const {test,expect}=require('@playwright/test'),path=require('node:path'),fs=require('node:fs');
const AxeBuilder=require('@axe-core/playwright').default;
const root=process.env.PCM_NAV_REPO||path.resolve(__dirname,'../../..');
let fixture,certificates,runnerDirectory,runner;
const saved=()=>JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
const address=(section,source='',view='')=>`${fixture.base}/admin?section=${section}${source?'&source='+encodeURIComponent(source):''}${view?'&view='+view:''}`;
test.beforeAll(async()=>{
    certificates=require(path.join(root,'test-support/certificates')).generateCertificates();
    runnerDirectory=fs.mkdtempSync('/tmp/r8-sanity-');runner=path.join(runnerDirectory,'runner.js');process.env.SANITY_SCRIPT=runner;
    fs.writeFileSync(runner,"process.stdout.write(JSON.stringify({status:'incomplete',checks:[{name:'ho-a-gateway-readiness',status:'pass',httpStatus:200},{name:'ho-a-online-presence-count-only',status:'incomplete',state:'populated-unverified',reason:'No verified test fixture for the populated source'},{name:'doctor-flow-not-applicable-without-verified-fixture',status:'pass',reason:'No selected fixture has been verified on its named source.'},{name:'admin-logs-api',status:'pass',httpStatus:200}]}));process.exitCode=1;");
    fixture=await require(path.join(root,'test-support/admin-shell-fixture')).startAdminShellFixture();
    fs.cpSync(certificates.directory,process.env.CERTS_DIR,{recursive:true});

});
test.afterAll(async()=>{await fixture?.close();certificates?.cleanup();fs.rmSync(runnerDirectory,{recursive:true,force:true});});
test.beforeEach(async({page})=>{await page.setExtraHTTPHeaders({'x-admin-password':fixture.password});});

/** Check real layout at the mock widths; half CSS viewport models 200% reflow. */
async function inspect(page,info,name) {
    for(const [width,zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]) {
        await page.setViewportSize({width:Math.round(width/zoom),height:Math.round(1000/zoom)});
        await page.evaluate(()=>window.scrollTo(0,0));
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`${name} ${width} zoom ${zoom}`).toBe(true);
        if(width>=1024&&zoom===1){const nav=await page.locator('.admin-sections').boundingBox(),main=await page.locator('main').boundingBox();expect(nav.width).toBeCloseTo(208,0);expect(nav.x+nav.width).toBeLessThanOrEqual(main.x+1);}
        await page.screenshot({path:info.outputPath(`${name}-${width}-zoom${zoom}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});
}
test('R8 five Admin mock states preserve left navigation, exact facts, passive renewal and Help',async({page},info)=>{
    const writes=[],dialogs=[],errors=[];page.on('request',req=>{if(!['GET','HEAD'].includes(req.method()))writes.push(req.url());});page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.dismiss();});page.on('pageerror',error=>errors.push(error.message));
    const before=fs.readFileSync(process.env.TEAM_CONFIG_PATH),id=fixture.config.healthOrganizations[0].dataSourceOrganization.id;
    for(const [name,url] of [['overview',address('overview')],['managed-registration',address('sources',id,'registration')],['managed-trust',address('sources',id,'trust')],['managed-credentials',address('sources',id,'credentials')],['custom-credentials',address('sources','admin22-custom','credentials')],['certificates',address('certificates')+'&owner='+encodeURIComponent(fixture.config.organizations.hospitalBServiceProvider.id)],['diagnostics',address('logs')]]){
        await page.goto(url);await expect(page.locator('.admin-sections a')).toHaveCount(7);await inspect(page,info,name);
        expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
    }
    await page.goto(address('certificates')+'&owner='+encodeURIComponent(fixture.config.organizations.serviceProvider.id));
    const opener=page.getByRole('button',{name:'How to renew certificates',exact:true});await opener.click();await expect(page.getByRole('region',{name:'Controlled certificate renewal'})).toContainText('--apply');await expect(page.getByRole('region',{name:'Controlled certificate renewal'})).toContainText('--rotate-keys');
    await page.getByRole('button',{name:'Close instructions'}).click();await expect(opener).toBeFocused();await opener.click();await page.getByRole('button',{name:'Close instructions'}).click();
    const publicLink=page.getByRole('link',{name:'Download certificate',exact:true}).first();const response=await page.request.get(new URL(await publicLink.getAttribute('href'),fixture.base).href);expect(response.status()).toBe(200);expect(await response.text()).toMatch(/BEGIN CERTIFICATE/);expect(await response.text()).not.toMatch(/PRIVATE KEY/);
    await page.getByRole('checkbox',{name:'Explain this page'}).check();await publicLink.focus();await expect(page.getByRole('tooltip')).toContainText('No private key');await page.keyboard.press('Escape');await expect(publicLink).toBeFocused();
    if(info.project.name==='mobile'){await publicLink.scrollIntoViewIfNeeded();await publicLink.tap({trial:true});}
    await page.getByRole('checkbox',{name:'Explain this page'}).uncheck();
    expect(writes).toEqual([]);expect(dialogs).toEqual([]);expect(errors).toEqual([]);expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
});

test('R8 R1 custom source can correct rejected pin and CA, resolve conflict, upload and export credentials',async({page},info)=>{
    await page.goto(address('sources')+'&view=onboarding');await page.locator('[name=name]').fill('Owned R8 correctable source');await page.locator('[name=endpoint]').fill('https://r8.example.test/fhir');
    await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    const id=await page.locator('[data-source-workspace]').getAttribute('data-source-workspace');
    await page.getByRole('link',{name:'HTTPS trust',exact:true}).click();const before=fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    await page.locator('[name=serverTrustMode]').selectOption('pinned-thumbprint');await page.locator('[name=serverTrustCertThumbprint]').fill('rejected pin <r8>');await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(page.locator('[name=serverTrustMode]')).toHaveValue('pinned-thumbprint');await expect(page.locator('[name=serverTrustCertThumbprint]')).toHaveValue('rejected pin <r8>');await expect(page.locator('#source-trust-error')).toContainText('Correct the retained fields');expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);await page.screenshot({path:info.outputPath('rejected-pin.png'),fullPage:true});
    await page.locator('[name=serverTrustMode]').selectOption('custom-ca');await page.locator('[name=serverTrustCaCert]').fill('custom/r8-missing.crt');await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();await expect(page.locator('[name=serverTrustCaCert]')).toHaveValue('custom/r8-missing.crt');expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    await page.locator('[name=serverTrustCaCert]').fill('rootCA.crt');await page.locator('[name=expectedRevision]').evaluate(node=>node.value='-1');await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();await expect(page.locator('#source-trust-error')).toContainText('changed');await expect(page.locator('[name=serverTrustCaCert]')).toHaveValue('rootCA.crt');expect(fs.readFileSync(process.env.TEAM_CONFIG_PATH).equals(before)).toBe(true);
    await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();expect(saved().organizations.dataSources.find(source=>source.id===id).serverTrust.mode).toBe('custom-ca');
    await page.getByRole('link',{name:'PCM credentials',exact:true}).click();await page.locator('[name=credentialMode]').selectOption('upload');await page.locator('[name=pcmClientAuthCertFile]').setInputFiles(path.join(certificates.directory,'sp-client-assertion.crt'));await page.locator('[name=pcmClientAuthKeyFile]').setInputFiles(path.join(certificates.directory,'sp-client-assertion.key'));await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(page.locator('#admin-error-summary')).toHaveCount(0);const bundle=await page.request.get(`${fixture.base}/admin/config/data-sources/${id}/client-bundle`);expect(bundle.status()).toBe(200);expect(JSON.stringify(await bundle.json())).toContain('PRIVATE KEY');await expect(page.getByRole('link',{name:'Download ZIP · private keys',exact:true})).toBeVisible();
    await page.goto(address('sources',fixture.config.healthOrganizations[0].dataSourceOrganization.id,'trust'));await expect(page.locator('[name=serverTrustCaCert]')).toHaveCount(0);await expect(page.locator('main')).not.toContainText('rejected pin <r8>');
});


test('R8 completed incomplete and failed sanity results dismiss without rerun and later results render normally',async({page},info)=>{
    await page.goto(address('logs'));await page.getByRole('button',{name:'Run sanity check',exact:true}).click();await expect(page).toHaveURL(/section=logs$/);
    const result=page.getByRole('region',{name:'Last sanity check'});await expect(result).toContainText('Incomplete —');await expect(result).toContainText('Passed');await expect(result).toContainText('Not exercised');await expect(result).toContainText('populated-unverified');await expect(result.getByRole('link',{name:'Open PCM diagnostics',exact:true})).toHaveAttribute('href',/diagnostics=true&source=pcm-core$/);
    await inspect(page,info,'incomplete-sanity');const writes=[];page.on('request',req=>{if(!['GET','HEAD'].includes(req.method()))writes.push(req.url());});
    await page.getByRole('button',{name:'Dismiss result',exact:true}).click();await expect(result).toBeHidden();const show=page.getByRole('button',{name:'Show / hide last result',exact:true});await expect(show).toBeFocused();await show.click();await expect(result).toBeVisible();
    await page.getByRole('checkbox',{name:'Explain this page'}).check();await page.getByRole('button',{name:'Dismiss result',exact:true}).focus();await expect(page.getByRole('tooltip')).toContainText('pending-operation guards remain unchanged');await page.getByRole('button',{name:'Dismiss explanation',exact:true}).click();await page.getByRole('checkbox',{name:'Explain this page'}).uncheck();expect(writes).toEqual([]);
    fs.writeFileSync(runner,"process.stdout.write(JSON.stringify({status:'fail',checks:[{name:'ho-a-gateway-readiness',status:'fail',httpStatus:503,error:'owned gateway unavailable'}]}));process.exitCode=1;");
    await page.getByRole('button',{name:'Run sanity check',exact:true}).click();await expect(result).toContainText('Failed —');await expect(result).toContainText('HTTP 503');await expect(result).toContainText('owned gateway unavailable');await page.getByRole('button',{name:'Dismiss result',exact:true}).click();await expect(result).toBeHidden();
    await page.getByRole('button',{name:'Show / hide last result',exact:true}).click();await page.screenshot({path:info.outputPath('failed-sanity.png'),fullPage:true});
});
