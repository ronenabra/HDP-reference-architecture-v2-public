'use strict';
/** Actual custom-source form, conditional uploads, review, export and lifecycle. */
const {test,expect}=require('@playwright/test'),path=require('node:path');
const root=process.env.PCM_NAV_REPO||path.resolve(__dirname,'../../..');
let fixture, certificates;
test.beforeAll(async()=>{
    certificates=require(path.join(root,'test-support/certificates')).generateCertificates();
    fixture=await require(path.join(root,'test-support/admin-sources-fixture')).startAdminSourcesFixture();
    for(const name of ['rootCA.crt','rootCA.key']) require('node:fs').copyFileSync(path.join(certificates.directory,name),path.join(process.env.CERTS_DIR,name));
});
test.afterAll(async()=>{await fixture?.close();certificates?.cleanup();});
test.beforeEach(async({page})=>{await page.setExtraHTTPHeaders({'x-admin-password':fixture.password});});
const onboarding=()=>`${fixture.base}/admin?section=sources&view=onboarding`;

test('onboarding fields, nonsecret drafts, exact review and native Help remain passive and responsive',async({page},info)=>{
    const writes=[];page.on('request',req=>{if(req.method()==='POST')writes.push(req.url());});
    await page.goto(onboarding());
    await expect(page.locator('[name=pcmClientAuthCertFile]')).toBeHidden();await expect(page.locator('[data-source-verification-policy]')).toContainText('Off');
    await page.locator('[name=credentialMode]').selectOption('upload');
    await expect(page.locator('[name=pcmClientAuthCertFile]')).toBeVisible();await expect(page.locator('[name=pcmTransportCertFile]')).toBeHidden();
    await page.locator('[name=pcmClientAuthCertFile]').setInputFiles({name:'owned.crt',mimeType:'application/x-pem-file',buffer:Buffer.from('owned public UI fixture')});
    await page.locator('[name=credentialProfile]').selectOption('separate-es384');await expect(page.locator('[name=pcmTransportCertFile]')).toBeVisible();
    await page.locator('[name=serverTrustMode]').selectOption('custom-ca');await expect(page.locator('[name=serverTrustCaFile]')).toBeVisible();await expect(page.locator('[name=serverTrustCertFile]')).toBeHidden();
    await page.locator('[name=serverTrustMode]').selectOption('pinned-thumbprint');await expect(page.locator('[name=serverTrustCertFile]')).toBeVisible();
    for(const [width,zoom] of [[1440,1],[1024,1],[390,1],[320,1],[1440,2]]){
        await page.setViewportSize({width,height:1000});await page.evaluate(value=>{document.documentElement.style.zoom=String(value);},zoom);
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);
        if(width===1440&&zoom===1||width===320)await page.screenshot({path:info.outputPath(`onboarding-${width}.png`),fullPage:true});
    }
    await page.evaluate(()=>{document.documentElement.style.zoom='1';});await page.setViewportSize({width:390,height:844});
    await page.getByRole('checkbox',{name:'Explain this page'}).check();await page.locator('[name=credentialProfile]').focus();await expect(page.getByRole('tooltip')).toContainText('P-384');await page.keyboard.press('Escape');await expect(page.locator('[name=credentialProfile]')).toBeFocused();
    await page.locator('[name=name]').tap();await expect(page.getByRole('tooltip')).toBeVisible();await page.getByRole('button',{name:'Dismiss explanation'}).tap();await page.getByRole('checkbox',{name:'Explain this page'}).uncheck();
    expect(writes).toEqual([]);expect(fixture.unchanged()).toBe(true);
    await page.locator('[name=credentialMode]').selectOption('generate');await page.locator('[name=credentialProfile]').selectOption('shared-es256');await page.locator('[name=serverTrustMode]').selectOption('team-root-ca');
    await page.locator('[name=name]').fill('Draft <source24>');await page.locator('[name=endpoint]').fill('https://draft.example.test/fhir');await page.locator('[name=clientId]').fill('https://invalid.example.test/client');
    await page.getByRole('button',{name:'Review changes',exact:true}).click();expect(writes).toEqual([]);await expect(page.locator('[data-source-changes]')).toContainText('https://draft.example.test/fhir');
    await page.getByRole('button',{name:'Publish changes',exact:true}).click();await expect(page.getByText('Could not complete admin action',{exact:true})).toBeVisible();
    await expect(page.locator('[name=name]')).toHaveValue('Draft <source24>');await expect(page.locator('[name=clientId]')).toHaveValue('https://invalid.example.test/client');await expect(page.locator('.alert-danger')).toBeFocused();
    await expect(page.locator('[type=file]')).toHaveCount(6);for(const input of await page.locator('[type=file]').all())expect(await input.inputValue()).toBe('');
    expect(fixture.unchanged()).toBe(true);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toMatch(/PRIVATE KEY|credential|source24/);
    await page.screenshot({path:info.outputPath('invalid-draft-mobile.png'),fullPage:true});
});

test('generated source registration, export, stable edit, conflicts and disable-remove use actual APIs',async({page},info)=>{
    await page.goto(onboarding());await page.locator('[name=name]').fill('Source24 generated owned');await page.locator('[name=endpoint]').fill('https://owned.source24.example.test/fhir');
    await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(page.locator('[data-source-workspace]')).toBeVisible();const id=await page.locator('[data-source-workspace]').getAttribute('data-source-workspace');
    await page.locator('[name=name]').fill('Source24 edited');await page.locator('[name=endpoint]').fill('https://edited.source24.example.test/fhir');
    await page.locator('[name=expectedRevision]').first().evaluate(node=>{node.value='-1';});await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(page.locator('[data-source-workspace]')).toHaveAttribute('data-source-workspace',id);await expect(page.locator('[name=endpoint]')).toHaveValue('https://edited.source24.example.test/fhir');
    await expect(page.getByText('Source settings changed.',{exact:false})).toBeVisible();
    await page.getByRole('button',{name:'Review changes',exact:true}).click();await page.getByRole('button',{name:'Publish changes',exact:true}).click();
    await expect(page.locator('h3#source-workspace-name')).toHaveText('Source24 edited');
    for(const width of [1440,320]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`edit-${width}.png`),fullPage:true});}
    await page.getByRole('link',{name:'PCM credentials',exact:true}).click();
    await expect(page.locator('[data-source-workspace]')).toContainText('Valid from');expect(await page.locator('.admin-source-exports').evaluate(element=>element.getBoundingClientRect().bottom+scrollY<=document.documentElement.scrollHeight)).toBe(true);await page.screenshot({path:info.outputPath('credentials-320.png'),fullPage:true});
    const download=await page.request.get(`${fixture.base}/admin/config/data-sources/${id}/client-bundle`);expect(download.status()).toBe(200);const bundle=await download.json();expect(bundle.credentialScope).toContain('PRIVATE KEYS');expect(JSON.stringify(bundle.certificates)).toContain('PRIVATE KEY');expect(download.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('link',{name:'Download ZIP · private keys',exact:true})).toBeVisible();const zip=await page.request.get(`${fixture.base}/admin/config/data-sources/${id}/client-bundle.zip`);expect(zip.status()).toBe(200);expect(zip.headers()['content-type']).toContain('application/zip');expect((await zip.body()).subarray(0,2).toString()).toBe('PK');expect(await page.locator('body').textContent()).not.toContain('BEGIN PRIVATE KEY');
    await page.getByRole('link',{name:'Registration',exact:true}).click();await page.getByRole('button',{name:'Disable source',exact:true}).click();await expect(page.locator('[data-source-workspace]')).toContainText('Disabled');
    await page.getByRole('button',{name:'Re-enable source',exact:true}).click();await expect(page.locator('[data-source-workspace]')).toContainText('Configured');
    await page.getByRole('button',{name:'Disable source',exact:true}).click();page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Remove source',exact:true}).click();await expect(page.locator('[data-source-workspace]')).toHaveAttribute('data-source-workspace',id);
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Remove source',exact:true}).click();await expect(page.locator('[data-source-workspace]')).toHaveCount(0);
    await page.goto(`${fixture.base}/admin?section=sources&source=${id}`);await expect(page.getByRole('alert')).toContainText('no longer configured');await expect(page.locator('[data-source-workspace]')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('removed-registration.png'),fullPage:true});
});
