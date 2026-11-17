'use strict';
/** Actual public PCM HTTPS/assertion requests in each deployment preset; no credential doubles. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { PRESETS } = require('../../shared/conformance-policy');

test('Security27: all four presets keep actual transport/assertion effects and clinical scope/source/Patient/lifecycle authority', async t => {
    const f = await require('../../../test-support/consent-snapshot-fixture').startSnapshotFixture(); t.after(f.close);
    if(process.env.SECURITY_RUNTIME_REPORT)t.after(()=>{if(fs.existsSync(process.env.LOG_DIR))fs.cpSync(process.env.LOG_DIR,process.env.SECURITY_RUNTIME_REPORT+'.logs',{recursive:true});});
    const read = name => fs.readFileSync(path.join(process.env.CERTS_DIR, name));
    const role = f.config.certificateRoles.serviceProvider;
    const key = read(role.assertion.key), kid = require('../../shared/assertion-keys').jwkThumbprint(key);
    const endpoint = f.config.internalBaseUrls.pcmAuth + '/token';
    const logical = f.config.contract.operational.oauthBase + '/token';
    const clientId = f.config.organizations.serviceProvider.clientId;
    function sign(change = {}, wrong = false) {
        const now = Math.floor(Date.now()/1000);
        return jwt.sign({ iss: clientId, sub: clientId, aud: logical, jti: randomUUID(), iat: now, exp: now+300, ...change }, wrong ? read('ho-b-gateway-assertion.key') : key, { algorithm: 'ES256', header: { typ: 'JWT', kid } });
    }
    function request(body, certificate = true) {
        return new Promise((resolve,reject) => {
            const req = https.request(endpoint, { method: 'POST', ca: read('rootCA.crt'), ...(certificate ? {cert:read(role.mtls.cert),key:read(role.mtls.key)} : {}), headers:{'Content-Type':'application/x-www-form-urlencoded'}, agent:false }, res => {
                let raw='';res.on('data',chunk=>{raw+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));
            }); req.on('error',reject);req.end(new URLSearchParams(body).toString());
        });
    }
    let gatewayProbe = null;
    if (process.env.SECURITY_OWNED) {
        const owned=process.env.SECURITY_OWNED;
        fs.cpSync(process.env.CERTS_DIR,path.join(owned,'certs'),{recursive:true});
        process.env.TEAM_CONFIG_PATH=path.join(owned,'team-config.json');fs.writeFileSync(process.env.TEAM_CONFIG_PATH,JSON.stringify(f.config));
        process.env.HO_ID='ho-a';
        const runtime=require('../../ds-auth-adapter/src/index').createApp({env:{...process.env,PCM_INTROSPECTION_AUTH_MODE:'direct'}});
        const adapter=require('node:http').createServer(runtime.app);await new Promise(resolve=>adapter.listen(4100,'0.0.0.0',resolve));
        const upstream=https.createServer({cert:read('ho-a-hapi.crt'),key:read('ho-a-hapi.key')},(_req,res)=>res.writeHead(200,{'Content-Type':'application/fhir+json'}).end(JSON.stringify({resourceType:'Bundle',type:'searchset',entry:[]})));
        await new Promise(resolve=>upstream.listen(4200,'0.0.0.0',resolve));
        t.after(async()=>{for(const server of [adapter,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
        fs.writeFileSync(path.join(owned,'ready.json'),JSON.stringify({ready:true,node:process.version,openssl:process.versions.openssl}));
        const deadline=Date.now()+30000;while(!fs.existsSync(path.join(owned,'gateway-started'))){if(Date.now()>deadline)throw new Error('Owned gateway startup prerequisite timed out');await new Promise(resolve=>setTimeout(resolve,100));}
        gatewayProbe=(token,certificate=true)=>new Promise((resolve,reject)=>{
            const req=https.get('https://ds-gateway:8080/fhir/Observation?status=final',{ca:read('rootCA.crt'),agent:false,...(certificate?{cert:read(role.mtls.cert),key:read(role.mtls.key)}:{}),headers:{Authorization:'Bearer '+token}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);
        });
    }
    const rows = [];
    for (const preset of PRESETS) {
        // Owned deployment fixture construction, never a bypass of the protected mode-change command.
        const selected = require('../../../test-support/team-config').buildTeamConfig({},preset);
        for(const name of ['conformance','security','securitySimulation','legacyDataSource']) f.config[name] = selected[name];
        f.config.runtime.revision = (JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)).runtime.revision||0)+1;
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH,JSON.stringify(f.config));
        const consent = require('../src/fhir/consent-lifecycle').approveConsent({store:f.store,consent:f.create(),scopeChoice:'service-provided',sourceOrganizationIds:[f.config.healthOrganizations[0].dataSourceOrganization.id]});
        const basis = {type:'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access',fhirContext:[{type:'Consent',role:'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis',identifier:{system:consent.identifier[0].system,value:consent.identifier[0].value}}]};
        const body = {grant_type:'client_credentials',client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:sign(),scope:'patient/Observation.s',resource:f.config.healthOrganizations[0].endpoint,authorization_details:JSON.stringify([basis])};
        const valid = await request(body);assert.equal(valid.status,200,JSON.stringify({preset,valid}));
        assert.equal((await request({...body,client_assertion:sign()},false)).status,['connectathon-mtls','strict'].includes(preset)?401:200,preset+' PCM mTLS');
        rows.push({preset,check:'PCM-client-certificate-default',status:['connectathon-mtls','strict'].includes(preset)?401:200});
        if(gatewayProbe){
            let registeredStatus,registeredDeadline=Date.now()+7000;do{registeredStatus=await gatewayProbe(valid.body.access_token);if(registeredStatus===200)break;await new Promise(resolve=>setTimeout(resolve,200));}while(Date.now()<registeredDeadline);assert.equal(registeredStatus,200,preset+' actual gateway registered client');
            const expected=['connectathon-mtls','strict'].includes(preset)?401:200;
            let status,deadline=Date.now()+7000;do{status=await gatewayProbe(valid.body.access_token,false);if(status===expected)break;await new Promise(resolve=>setTimeout(resolve,200));}while(Date.now()<deadline);assert.equal(status,expected,preset+' actual source gateway mTLS');rows.push({preset,check:'actual-source-gateway-client-certificate',status});
        }
        for(const [name,assertion] of [['signature',sign({},true)],['audience',sign({aud:'https://wrong.test/token'})],['expiry',sign({iat:Math.floor(Date.now()/1000)-1000,exp:Math.floor(Date.now()/1000)-900})]]){
            const result=await request({...body,client_assertion:assertion});assert.equal(result.status,preset==='connectathon-easy'?200:401,JSON.stringify({preset,name,result}));rows.push({preset,check:name,status:result.status});
        }
        const replay=sign();assert.equal((await request({...body,client_assertion:replay})).status,200);assert.equal((await request({...body,client_assertion:replay})).status,preset==='connectathon-easy'?200:401,preset+' replay');
        const broader=await request({...body,scope:'patient/MedicationRequest.r',client_assertion:sign()});assert.equal(broader.status,200);assert.equal(broader.body.scope,valid.body.scope);assert.doesNotMatch(broader.body.scope,/MedicationRequest/);rows.push({preset,check:'scope-capped-to-approved',status:broader.status});
        for(const [name,changes] of [['source',{resource:f.config.healthOrganizations[1].endpoint}],['Patient',{authorization_details:JSON.stringify([{...basis,fhirContext:[...basis.fhirContext,{type:'Patient',role:'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient',identifier:{system:'http://fhir.health.gov.il/identifier/il-national-id',value:'999999999'}}]}])}]]){
            const result=await request({...body,...changes,client_assertion:sign()});assert.equal(result.status,400,JSON.stringify({preset,name,result}));rows.push({preset,check:name,status:result.status});
        }
        if(preset!=='strict'){
            const current=JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)), controls=require('../../shared/conformance-policy').SIMULATION_CONTROLS;
            const sourceBody={adminForm:'simulation',expectedRevision:String(current.runtime.revision||0),sourceId:f.config.healthOrganizations[0].dataSourceOrganization.id,preset,resetDefaults:'false',...Object.fromEntries(controls.map(name=>['control.'+name,'inherit']))};
            sourceBody['control.clientAssertionAudience']=preset==='connectathon-easy'?'true':'false';
            sourceBody['control.publicClientMtls']=['connectathon-mtls'].includes(preset)?'false':'true';
            const saved=await fetch(f.base+'/admin/config/simulation',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(sourceBody)});assert.equal(saved.status,200,await saved.text());
            const selected=await request({...body,client_assertion:sign({aud:'https://wrong.test/token'})});assert.equal(selected.status,preset==='connectathon-easy'?401:200);rows.push({preset,check:'selected-source-assertion-audience-override',status:selected.status});
            if(gatewayProbe){let status,deadline=Date.now()+7000;const expected=preset==='connectathon-mtls'?200:401;do{status=await gatewayProbe(valid.body.access_token,false);if(status===expected)break;await new Promise(resolve=>setTimeout(resolve,200));}while(Date.now()<deadline);assert.equal(status,expected,preset+' actual source override gateway mTLS');rows.push({preset,check:'selected-source-gateway-client-certificate-override',status});}
        }
        const tokens=require('../src/store').tokenStore, oldToken=structuredClone(tokens.peek(valid.body.access_token));
        const usagePath=path.join(process.env.STATE_DIR,'first-use-windows');const usage=()=>fs.existsSync(usagePath)?fs.readdirSync(usagePath).map(name=>[name,fs.readFileSync(path.join(usagePath,name),'utf8')]):[];const beforeUsage=usage();
        const current=JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
        const duration=await fetch(f.base+'/admin/config/security',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({adminForm:'token-duration',expectedRevision:String(current.runtime.revision||0),accessTokenExpiresInSeconds:'17'})});assert.equal(duration.status,200,await duration.text());
        const fresh=await request({...body,client_assertion:sign()});assert.equal(fresh.status,200);assert.equal(fresh.body.expires_in,17);assert.deepEqual(tokens.peek(valid.body.access_token),oldToken);assert.deepEqual(usage(),beforeUsage);rows.push({preset,check:'duration-save-reload-future-only',status:fresh.status});
        require('../src/fhir/consent-lifecycle').cancelConsent({store:f.store,consent:f.store.get('Consent',consent.id),callerOrganization:f.store.get('Organization',f.config.organizations.serviceProvider.id),request:require('../../sp-client/src/fhir-builders').buildConsentDeactivate(consent.id)});
        const ended=await request({...body,client_assertion:sign()});assert.equal(ended.status,400,JSON.stringify({preset,ended}));
        rows.push({preset,check:'lifecycle',status:ended.status});
    }
    if(process.env.SECURITY_RUNTIME_REPORT)fs.writeFileSync(process.env.SECURITY_RUNTIME_REPORT,JSON.stringify({executedAt:new Date().toISOString(),rows},null,2)+'\n');
});
