'use strict';
/** Owned snapshot of actual sprint-35 sources; UI faults/clear never touch the native source files. */
const fs=require('node:fs'),path=require('node:path');
const config=require('../../test-support/team-config').installTestRuntime();
const root=process.env.SHARED_LOGS_DIR,owned=process.env.PCM_HAPI_OBS_OWNED || '/native-owned';
const components=require('../../src/pcm-core/src/log-ordering').configuredLogComponents(config);
function copySnapshot(){
const copies=[];
for(const letter of ['a','b','c'])for(const [suffix,subdir]of [['hapi-runtime','hapi-runtime'],['hapi','hapi']]){
 const source=path.join(owned,'logs',letter,subdir),target=path.join(root,'ho-'+letter+'-'+suffix);
 fs.mkdirSync(target,{recursive:true});if(fs.existsSync(source)){fs.cpSync(source,target,{recursive:true});copies.push({source:'ho-'+letter+'-'+suffix,kind:'actual-native-snapshot'});}
}
for(const letter of ['a','b','c']){
 const source=path.join(owned,'node-logs','ho-'+letter+'-adapter'),target=path.join(root,'ho-'+letter+'-adapter');
 if(fs.existsSync(source)){fs.cpSync(source,target,{recursive:true});copies.push({source:'ho-'+letter+'-adapter',kind:'actual-adapter-snapshot'});}
}
for(const [folder,target]of [['ho-a-pcm','pcm-core'],['sp-client','sp-client']]){
 const source=path.join(owned,'node-logs',folder);if(fs.existsSync(source)){fs.cpSync(source,path.join(root,target),{recursive:true});copies.push({source:target,kind:'actual-node-snapshot'});}
}
return copies;
}
const copies=copySnapshot();
const nativeDir=path.join(root,'ho-a-hapi-runtime');
const nativeFiles=[path.join(nativeDir,'current.log'),...(fs.existsSync(path.join(nativeDir,'history'))?fs.readdirSync(path.join(nativeDir,'history'),{withFileTypes:true}):[])
 .filter(value=>value.isDirectory()).map(value=>path.join(nativeDir,'history',value.name,'app.log'))];
const nativeRecords=nativeFiles.flatMap(filename=>fs.readFileSync(filename,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
const latest=records=>records.sort((left,right)=>Date.parse(left.timestamp)-Date.parse(right.timestamp)).at(-1);
const selected=latest(nativeRecords.filter(record=>record.details?.type==='HAPI_RESPONSE'&&record.details?.flowId==='obs35-direct-ho-a-connectathon-easy'&&record.details?.resourceType==='Patient'))
 || latest(nativeRecords.filter(record=>record.details?.type==='HAPI_RESPONSE'&&record.details?.traceId));
if(!selected)throw Error('Required actual native trace is unavailable');
const manifest={schema:'hapi-observability-browser/1',copies,traceId:selected.details.traceId,parentSpanId:selected.details.parentSpanId,
 flowId:selected.details.flowId,nativeRequestId:selected.details.requestId,nativeTimestamp:selected.timestamp,source:'ho-a-hapi-runtime',snapshot:true,coverage:'Actual retained byte snapshots; original live native sources stay untouched.'};
const isolation=JSON.parse(fs.readFileSync(path.join(owned,'native-detail-isolation.json'),'utf8'));
if(isolation.status!=='passed')throw Error('Required actual native detail-expiry evidence is unavailable');
manifest.detailIsolation=isolation.receipts.map(value=>({phase:value.phase,ho:value.ho,flow:value.flow,
 enabled:value.receipt.details.detailCollection.enabled,expiresAt:value.receipt.details.detailCollection.expiresAt,resourceDetails:value.resourceDetails}));
const app=require('../../src/pcm-core/src/index').createUiApp();
app.get('/fixture/manifest',(_req,res)=>res.json(manifest));
app.post('/fixture/reset',(_req,res)=>{clearInterval(timer);timer=null;fs.rmSync(root,{recursive:true,force:true});copySnapshot();res.json({fixture:true});});
let timer,writes=0;
app.post('/fixture/writer/:mode',(req,res)=>{clearInterval(timer);timer=null;if(req.params.mode==='on')timer=setInterval(()=>{
 const filename=path.join(root,'ho-a-hapi-runtime/current.log');fs.appendFileSync(filename,JSON.stringify({timestamp:new Date().toISOString(),level:'INFO',message:'Owned browser active writer '+ ++writes,
 details:{type:'OWNED_WRITER_PROBE',visibility:'default',healthOrganizationId:'ho-a',collectionFixture:true}})+'\n');},10);res.json({writes,active:!!timer,fixture:true});});
app.post('/fixture/source/:mode',(req,res)=>{const filename=path.join(root,'ho-b-hapi-runtime/current.log'),held=filename+'.held';
 if(req.params.mode==='fail'){fs.renameSync(filename,held);fs.mkdirSync(filename);}else{fs.rmdirSync(filename);fs.renameSync(held,filename);}res.json({fixture:true});});
const server=app.listen(43186,'127.0.0.1',()=>console.log(JSON.stringify(manifest)));
async function close(){clearInterval(timer);await app.locals.closeLogSearch();server.closeAllConnections();server.close(()=>{fs.rmSync(path.dirname(process.env.TEAM_CONFIG_PATH),{recursive:true,force:true});process.exit(0);});}
process.on('SIGTERM',close);process.on('SIGINT',close);
