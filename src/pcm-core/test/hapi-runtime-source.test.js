'use strict';
/** Native runtime trust and reader budgets remain independent of payload source claims. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {configuredLogComponents}=require('../src/log-ordering');
const {readUnifiedPage,readUnifiedDetail}=require('../src/unified-log-page');
const {normalizeLogEntry}=require('../src/log-normalization');

test('three trusted runtime sources stay distinct from legacy import and source impersonation', t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-runtime-reader-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const components=configuredLogComponents({healthOrganizations:['a','b','c'].map(id=>({id:'ho-'+id,name:'HO '+id}))});
 const sources=components.filter(source=>source.role==='hapi');assert.equal(sources.length,3);assert.equal(components.filter(source=>source.role==='hapi-import').length,3);
 const source=sources[0];fs.mkdirSync(path.join(root,source.dir));
 fs.writeFileSync(path.join(root,source.dir,'current.log'),JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'HAPI_CONTEXT_VALIDATION · CONTEXT_VALIDATED',details:{type:'HAPI_CONTEXT_VALIDATION',visibility:'default',role:'doctor',healthOrganizationId:'ho-b',reasonCode:'CONTEXT_VALIDATED'},event:{schemaVersion:'1.0',source:{componentId:'forged',role:'doctor',healthOrganizationId:'ho-b'}}})+'\n');
 const page=readUnifiedPage(root,components,{diagnostics:'false',role:'hapi'});assert.equal(page.entries.length,1);assert.ok(page.bytesRead<=1024*1024);assert.ok(page.entries.length<=200);
 const entry=page.entries[0];assert.equal(entry.event.source.role,'hapi');assert.equal(entry.event.source.healthOrganizationId,'ho-a');
 assert.equal(entry.event.source.componentId,'ho-a-hapi-runtime');
});
test('malformed/deep native records refuse unsafe raw at browse and full export without hiding healthy sources',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-native-malformed-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source={dir:'ho-a-hapi-runtime',role:'hapi',healthOrganizationId:'ho-a',strictPath:true};fs.mkdirSync(path.join(root,source.dir));
 let deep={AWS_SECRET_ACCESS_KEY:'must-never-escape'};for(let i=0;i<36;i++)deep={nested:deep};
 fs.writeFileSync(path.join(root,source.dir,'current.log'),[
  {timestamp:new Date().toISOString(),level:'ERROR',message:'Bad native version',event:{schemaVersion:'99'},details:{type:'HAPI_ERROR',exception:deep}},
  {timestamp:new Date().toISOString(),level:'ERROR',message:'Deep native',details:{type:'HAPI_ERROR',exception:deep}},
  {timestamp:new Date().toISOString(),level:'INFO',message:'Healthy native',details:{type:'HAPI_CONTEXT_VALIDATION'}}
 ].map(JSON.stringify).join('\n')+'\n');
 const page=readUnifiedPage(root,[source],{diagnostics:'false'});assert.equal(page.entries.length,3);assert.equal(page.entries.filter(entry=>entry.parseError).length,2);
 const exported=require('../src/log-export').readLogExport(root,[source]);assert.equal(exported.complete,true);assert.doesNotMatch(JSON.stringify(exported),/must-never-escape/);assert.match(JSON.stringify(exported),/withheld/);
});
test('owned native clear refuses symlinks without touching another source and healthy clears still proceed',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-native-clear-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native={dir:'ho-a-hapi-runtime',role:'hapi',healthOrganizationId:'ho-a',strictPath:true},healthy={dir:'pcm-core'};
 for(const item of[native,healthy])fs.mkdirSync(path.join(root,item.dir));const outside=path.join(root,'unrelated');fs.writeFileSync(outside,'preserve exact bytes');
 fs.symlinkSync(outside,path.join(root,native.dir,'current.log'));fs.writeFileSync(path.join(root,healthy.dir,'current.log'),'clear this');
 const result=require('../src/log-clear').clearConfiguredLogs(root,[native,healthy]);assert.equal(result.status,'partial');
 assert.equal(result.results.find(item=>item.component===native.dir).status,'failed');assert.equal(fs.readFileSync(outside,'utf8'),'preserve exact bytes');assert.equal(fs.readFileSync(path.join(root,healthy.dir,'current.log'),'utf8'),'');
});
test('native query credentials stay out of summaries while selected/raw/full export retain exact non-AWS bytes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-summary-url-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source={dir:'ho-a-hapi-runtime',role:'hapi',healthOrganizationId:'ho-a',strictPath:true};fs.mkdirSync(path.join(root,source.dir));
 const url='/fhir/Observation?access_token=owned-opaque-token&identifier=exact%7Cvalue';
 fs.writeFileSync(path.join(root,source.dir,'current.log'),JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'HAPI_REQUEST',details:{type:'HAPI_REQUEST',url,visibility:'default'}})+'\n');
 const page=readUnifiedPage(root,[source],{diagnostics:'false'});assert.equal(page.entries[0].details.url,'/fhir/Observation');
 assert.doesNotMatch(JSON.stringify(page.entries),/owned-opaque-token/);
 const detail=readUnifiedDetail(root,[source],page.entries[0].reference);assert.equal(detail.entry.details.url,url);assert.match(detail.raw,/owned-opaque-token/);
 assert.match(JSON.stringify(require('../src/log-export').readLogExport(root,[source])),/owned-opaque-token/);
});
test('native clear rejects a FIFO without waiting for a reader and still clears a healthy source',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hapi-clear-fifo-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native={dir:'ho-a-hapi-runtime',role:'hapi',strictPath:true},healthy={dir:'pcm-core'};
 for(const source of [native,healthy])fs.mkdirSync(path.join(root,source.dir));
 require('node:child_process').execFileSync('mkfifo',[path.join(root,native.dir,'current.log')]);
 fs.writeFileSync(path.join(root,healthy.dir,'current.log'),'clear healthy');
 const started=performance.now(),result=require('../src/log-clear').clearConfiguredLogs(root,[native,healthy]);
 assert.ok(performance.now()-started<2000);assert.equal(result.results.find(value=>value.component===native.dir).status,'failed');
 assert.equal(fs.readFileSync(path.join(root,healthy.dir,'current.log'),'utf8'),'');
});
