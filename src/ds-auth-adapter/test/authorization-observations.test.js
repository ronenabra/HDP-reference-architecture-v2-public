'use strict';
/** Actual HTTP early denials must produce one coherent terminal authorization observation. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'adapter-observation-'));
process.env.LOG_DIR=path.join(root,'logs');process.env.STATE_DIR=path.join(root,'state');
const {createApp}=require('../src/index'),logger=require('../src/logger');
const {buildTeamConfig}=require('../../../test-support/team-config');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('early token/certificate, inactive and malformed-authority exits retain 401 and exact reasons',async t=>{
 const cases=[
  {label:'missing',preset:'connectathon-easy',headers:{},reason:'MISSING_TOKEN'},
  {label:'malformed',preset:'connectathon-easy',headers:{authorization:'Basic value'},reason:'MALFORMED_TOKEN'},
  {label:'certificate',preset:'strict',headers:{authorization:'Bearer opaque'},reason:'CERTIFICATE_REQUIRED'},
  {label:'inactive',preset:'connectathon-easy',headers:{authorization:'Bearer opaque'},reason:'INACTIVE_INTROSPECTION'},
  {label:'contract',preset:'connectathon-easy',headers:{authorization:'Bearer opaque'},reason:'MALFORMED_PCM_RESPONSE',error:Object.assign(Error('closed response rejected'),{code:'PCM_INTROSPECTION_CONTRACT',reasonCode:'MALFORMED_PCM_RESPONSE'})},
  {label:'network',preset:'connectathon-easy',headers:{authorization:'Bearer opaque'},reason:'PCM_TRANSPORT_FAILED',error:Object.assign(Error('connection refused'),{isAxiosError:true})}
 ];
 for(const value of cases){
  let calls=0;const config=buildTeamConfig({},value.preset), runtime=createApp({config,env:{},bindings:{hoId:'ho-a',authMode:'direct'},client:{async introspect(){calls++;if(value.error)throw value.error;return{active:false}}}});
  const server=http.createServer(runtime.app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const response=await fetch('http://127.0.0.1:'+server.address().port+'/auth-check',{headers:{'x-correlation-id':'observation-'+value.label,'x-original-method':'GET','x-original-uri':'/fhir/Observation',...value.headers}});
   assert.equal(response.status,401);assert.equal(await response.text(),'Unauthorized');
   const all=fs.readFileSync(logger.getLogPath(),'utf8').trim().split('\n').map(JSON.parse);
   const decisions=all.filter(record=>record.details.type==='DS_AUTHORIZATION_DECISION'&&record.details.correlationId==='observation-'+value.label);
   assert.equal(decisions.length,1,value.label);assert.equal(decisions[0].details.reasonCode,value.reason);assert.equal(decisions[0].details.visibility,'default');
   assert.equal(calls,['inactive','contract','network'].includes(value.label)?1:0);
  }finally{await new Promise(resolve=>server.close(resolve));}
 }
});
test('an actual disconnected caller still gets exactly one observed authorization decision after introspection resolves',async()=>{
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve});
 const config=buildTeamConfig({},'connectathon-easy'),runtime=createApp({config,env:{},bindings:{hoId:'ho-a',authMode:'direct'},
  client:{introspect(){entered();return new Promise(resolve=>{release=resolve});}}});
 const server=http.createServer(runtime.app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const disconnected=new Promise(resolve=>server.once('connection',socket=>socket.once('close',resolve)));
  const request=http.get('http://127.0.0.1:'+server.address().port+'/auth-check',{headers:{authorization:'Bearer opaque',
   'x-correlation-id':'observed-disconnected-auth','x-original-method':'GET','x-original-uri':'/fhir/Observation'}});
  request.on('error',()=>{});await waiting;request.destroy();await disconnected;release({active:false});
  let decisions=[];for(let i=0;i<50;i++){
   decisions=fs.readFileSync(logger.getLogPath(),'utf8').trim().split('\n').map(JSON.parse)
    .filter(record=>record.details.type==='DS_AUTHORIZATION_DECISION'&&record.details.correlationId==='observed-disconnected-auth');
   if(decisions.length)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(decisions.length,1);assert.equal(decisions[0].details.reasonCode,'INACTIVE_INTROSPECTION');assert.equal(decisions[0].details.status,401);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
