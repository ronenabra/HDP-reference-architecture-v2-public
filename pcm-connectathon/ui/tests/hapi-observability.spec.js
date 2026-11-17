'use strict';
/** Actual source snapshots, real viewer/API, exact investigation and honest source/clear behavior. */
const fs=require('node:fs');const {test,expect}=require('@playwright/test');
async function activate(locator,info){if(info.project.name.endsWith('mobile'))await locator.tap();else{await locator.focus();await locator.press('Enter');}}
async function close(page){if(await page.locator('#workbench').isVisible())await page.locator('#close-workbench').click();}
async function panel(page,name,info){await close(page);await activate(page.locator('[data-open-panel="'+name+'"]'),info);}
test('native sources and real trace remain visible with Diagnostics off; raw and return preserve exact identity',async({page,request},info)=>{
 await request.post('/fixture/reset');
 const manifest=await(await request.get('/fixture/manifest')).json();const samples=[],errors=[];
 const started=new WeakMap();page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>started.set(request,performance.now()));page.on('requestfinished',request=>{if(request.url().includes('/api/unified-logs?'))samples.push({url:request.url(),milliseconds:performance.now()-started.get(request)});});
 await page.goto('/logs-view?diagnostics=false');await expect(page.locator('.log-row').first()).toBeVisible();
 await page.evaluate(trace=>{document.getElementById('filter-traceId').value=trace;return startSearch();},manifest.traceId);
 await expect.poll(()=>page.evaluate(()=>searchSession?.state)).toBe('complete');
 expect(await page.evaluate(()=>showDiagnosticLogs)).toBe(false);
 const native=await page.evaluate(()=>currentLogs.find(value=>value.details.type==='HAPI_RESPONSE'&&value.event?.source?.componentId==='ho-a-hapi-runtime'));
 expect(native.event.source.role).toBe('hapi');expect(native.event.source.healthOrganizationId).toBe('ho-a');
 await activate(page.locator('[data-log-id="'+native.id+'"]'),info);await expect(page.locator('#panel-structured')).toContainText('completionObserved');
 await page.locator('#tab-raw').click();await expect(page.locator('#panel-raw')).toContainText(manifest.nativeRequestId);
 const raw=await page.evaluate(()=>selectedResult.raw);await activate(page.locator('[data-inspect-field="traceId"]'),info);
 await expect.poll(()=>page.evaluate(()=>searchSession?.state)).toBe('complete');
 const roles=await page.evaluate(()=>searchSession.observedRoles);expect(roles).toContain('hapi');expect(roles).toContain('adapter');
 await expect(page.locator('#investigation-description')).toContainText('correlation-only events are excluded');
 await activate(page.locator('#return-to-results'),info);await expect.poll(()=>page.evaluate(()=>selectedResult?.raw)).toBe(raw);
 await page.goBack();await expect(page.locator('#investigation-title')).toContainText('Trace');await page.goForward();
 await panel(page,'coverage',info);await expect(page.locator('#source-list')).toContainText('HAPI runtime');await expect(page.locator('#source-list')).toContainText('Native diagnostics:');
 await close(page);await page.getByRole('checkbox',{name:'Explain this page'}).check();await panel(page,'filters',info);
 await expect(page.locator('#filter-role option[value="hapi"]')).toHaveText('HAPI runtime');
 await close(page);
 for(const width of(info.project.name.endsWith('mobile')?[390,320]:[1440,1024,320])){await page.setViewportSize({width,height:900});await page.screenshot({path:info.outputPath('native-'+width+'.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
 if(!info.project.name.endsWith('mobile')){await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>{document.documentElement.style.zoom='2';});await page.screenshot({path:info.outputPath('native-200-percent.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.evaluate(()=>{document.documentElement.style.zoom='1';});}
 for(const sample of samples){expect(sample.milliseconds).toBeGreaterThan(0);expect(sample.milliseconds).toBeLessThan(2000);}
 expect(errors).toEqual([]);fs.writeFileSync(info.outputPath('actual-trace.json'),JSON.stringify({manifest,roles,raw,samples},null,2));
});
test('all three native roles, import compatibility, source failure isolation and active clear use the existing operations',async({page,request},info)=>{
 await request.post('/fixture/reset');
 await page.goto('/logs-view?role=hapi&diagnostics=false');await expect(page.locator('.log-row').first()).toBeVisible();
 await panel(page,'coverage',info);for(const id of ['ho-a-hapi-runtime','ho-b-hapi-runtime','ho-c-hapi-runtime'])await expect(page.locator('#source-list')).toContainText(id);
 await request.post('/fixture/source/fail');const partial=await(await request.get('/api/unified-logs?page=true&role=hapi&diagnostics=false')).json();
 expect(partial.failures.some(value=>value.component==='ho-b-hapi-runtime')).toBe(true);expect(partial.entries.some(value=>value.event.source.healthOrganizationId==='ho-a')).toBe(true);
 await request.post('/fixture/source/heal');
 const old=await(await request.get('/api/unified-logs?page=true&role=hapi-import&diagnostics=true')).json();expect(old.entries.length).toBeGreaterThan(0);
 const detail=await(await request.get('/api/unified-logs/detail?reference='+encodeURIComponent(old.entries[0].reference))).json();expect(JSON.stringify(detail)).toContain('HAPI_IMPORT_DIAGNOSTIC');
 await request.post('/fixture/writer/on');await new Promise(resolve=>setTimeout(resolve,50));
 const exported=await request.get('/admin/logs/download');expect([200,207]).toContain(exported.status());expect((await exported.text()).includes('ho-a-hapi-runtime')).toBe(true);
 const cleared=await request.post('/api/unified-logs/clear');expect(cleared.ok()).toBe(true);
 await new Promise(resolve=>setTimeout(resolve,50));await request.post('/fixture/writer/off');
 const after=await(await request.get('/api/unified-logs?page=true&role=hapi&diagnostics=false')).json();expect(after.entries.some(value=>value.message.startsWith('Owned browser active writer'))).toBe(true);
 await page.goto('/logs-view?role=hapi&diagnostics=false');await expect(page.locator('.log-row').first()).toBeVisible();
 await page.evaluate(()=>holdReading());expect(await page.evaluate(()=>followingLatest)).toBe(false);await page.evaluate(()=>followLatest());
 fs.writeFileSync(info.outputPath('operations.json'),JSON.stringify({partial:partial.failures,importRows:old.entries.length,exportStatus:exported.status(),clearStatus:cleared.status(),afterRows:after.entries.length},null,2));
});
test('real private detail collection is independent of Diagnostics and expires on the server for one HO',async({page,request},info)=>{
 await request.post('/fixture/reset');const manifest=await(await request.get('/fixture/manifest')).json();
 expect(manifest.detailIsolation).toHaveLength(6);
 for(const observed of manifest.detailIsolation){
  await page.goto('/logs-view?'+new URLSearchParams({role:'hapi',source:observed.ho+'-hapi-runtime',flowId:observed.flow,diagnostics:'false'}));
  await expect.poll(()=>page.evaluate(()=>currentLogs.some(row=>row.details.type==='HAPI_REQUEST'))).toBe(true);
  const receipt=await page.evaluate(()=>currentLogs.find(row=>row.details.type==='HAPI_REQUEST'));
  expect(receipt.event.source.healthOrganizationId).toBe(observed.ho);
  expect(await page.evaluate(()=>showDiagnosticLogs)).toBe(false);
  expect(await page.evaluate(()=>currentLogs.some(row=>row.details.type==='HAPI_CONTEXT_VALIDATION'))).toBe(true);
  await activate(page.locator('[data-log-id="'+receipt.id+'"]'),info);await expect(page.locator('#panel-structured')).toContainText('expiresAt');
  await expect(page.locator('#panel-structured')).toContainText('completion was not observed');
  const effective=await page.evaluate(()=>selectedResult.entry.details.detailCollection);expect(effective.enabled).toBe(observed.enabled);expect(effective.expiresAt).toBe(observed.expiresAt);
  if(observed.enabled)expect(observed.resourceDetails).toBeGreaterThan(0);else expect(observed.resourceDetails).toBe(0);
 }
 fs.writeFileSync(info.outputPath('actual-detail-expiry.json'),JSON.stringify(manifest.detailIsolation,null,2));
});
