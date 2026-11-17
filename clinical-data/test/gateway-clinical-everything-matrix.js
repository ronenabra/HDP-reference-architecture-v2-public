'use strict';
/** Real approved opaque PCM tokens prove both operation forms and every public continuation on tiny fixtures. */
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const runtime=require('./demo-runtime-client');
const {equivalentTokens,authorityKey}=require('./equivalent-page-authority');
const {createApprovedClinicalConsent}=require('./gateway-clinical-count-matrix');
const {buildEffectivePolicy,sourceSimulationControls}=require('/shared/conformance-policy');
const {countFixtureCases}=require('./count-fixture-oracle');
async function qualify(consent){const scenarios=[];for(const [index,ho]of runtime.config.healthOrganizations.entries()){
    const config=JSON.parse(fs.readFileSync('/runtime/team-config.json')),policy=buildEffectivePolicy(config,process.env);
    const oracle=countFixtureCases(ho.id,sourceSimulationControls(policy,config,{resource:ho.endpoint}),runtime.savedApproval(consent).scope);
    const expected=oracle.known;
    const pair=await equivalentTokens(()=>runtime.issue(consent,undefined,index));
    const fingerprint=crypto.createHash('sha256').update(authorityKey(pair[0].json)).digest('hex');
    const count=await runtime.request(`${ho.endpoint}/Observation?_summary=count`,{bearer:pair[0].json.access_token});
    assert.equal(count.status,200);assert.equal(count.json.total,expected.length);
    const total=await runtime.request(`${ho.endpoint}/Observation?_count=1&_total=accurate`,{bearer:pair[0].json.access_token});
    assert.equal(total.status,200);assert.equal(total.json.total,expected.length);
    const totalNext=total.json.link.find(link=>link.relation==='next').url;
    const continued=await runtime.request(totalNext,{bearer:pair[1].json.access_token});assert.equal(continued.status,200);assert.equal(continued.json.total,expected.length);
    const ordinary=await runtime.request(`${ho.endpoint}/Observation?_count=1`,{bearer:pair[0].json.access_token});assert.equal(ordinary.status,200);assert.equal(ordinary.json.total,undefined);
    const compatibility={count:count.json.total,total:total.json.total,continuationStatus:continued.status,defaultTotalOmitted:true};
    for(const form of ['type','instance']){
        let url=`${ho.endpoint}/Patient/${form==='instance'?`patient-${ho.id}-0001/`:''}$everything?_count=1&_type=Observation`;
        const ids=[],pages=[];
        for(let n=0;n<12;n++){
            const token=pair[n===0?0:1];assert.equal(token.status,200);
            const r=await runtime.request(url,{bearer:token.json.access_token});assert.equal(r.status,200,`${url}: ${JSON.stringify(r.json)}`);
            assert.equal(r.json.total,undefined);const entries=r.json.entry||[];
            assert.ok(entries.every(entry=>entry.resource.resourceType==='Observation'&&entry.search?.mode==='match'));
            const selected=entries.map(entry=>entry.resource.id);assert.equal(selected.length,1,'useful bounded page');ids.push(...selected);
            const next=r.json.link?.find(link=>link.relation==='next')?.url;
            pages.push({url,ids:selected,next:next||null,authorityRevalidated:true,grantedScope:token.json.scope,distinctEquivalentToken:n===1});
            if(!next)break;assert.equal(new URL(next).origin,new URL(ho.endpoint).origin);url=next;assert.ok(n<11);
        }
        assert.deepEqual([...ids].sort(),[...expected].sort());assert.equal(new Set(ids).size,ids.length);
        scenarios.push({id:`gateway-clinical-everything-${oracle.nativeFiltering?'enforced':'simulation'}-${ho.id}-${form}`,status:'pass',executed:true,
            ordinaryPcmToken:true,compatibility,effectiveNativePolicy:oracle.mode,form,approvedScope:runtime.savedApproval(consent).scope,expectedIds:expected,actualIds:ids,authorityFingerprint:fingerprint,distinctApprovedOpaqueTokens:2,pages});
    }
    { // Anonymous and fake-token denials remain required in every preset.
        const anonymous=await runtime.request(`${ho.endpoint}/Patient/$everything`);assert.ok(anonymous.status>=400);
        const fake=await runtime.request(`${ho.endpoint}/Patient/$everything`,{bearer:'never-issued-everything-token'});assert.equal(fake.status,401);
    }
    const denied=await runtime.request(`${ho.endpoint}/Patient/patient-${ho.id}-htest-1/$everything`,{bearer:pair[1].json.access_token});
    assert.equal(denied.status,403,'caller ID is never target authority');
    const zero=await runtime.request(`${ho.endpoint}/Patient/$everything?_count=0`,{bearer:pair[1].json.access_token});assert.equal(zero.status,400);
}return scenarios;}
async function main(){const scenarios=[];let policyChange;try{
    scenarios.push(...await qualify(await createApprovedClinicalConsent()));
    if(runtime.config.conformance.preset==='connectathon-easy'){
        const consent=await createApprovedClinicalConsent(),issued=await runtime.issue(consent,undefined,0);
        const initial=await runtime.request(`${runtime.config.healthOrganizations[0].endpoint}/Patient/$everything?_type=Observation&_count=1`,{bearer:issued.json.access_token});
        assert.equal(initial.status,200);const oldNext=initial.json.link.find(link=>link.relation==='next').url;
        assert.equal((await runtime.save({ transportChecks: true })).status,200);
        const fresh=await runtime.issue(consent,undefined,0),stale=await runtime.request(oldNext,{bearer:fresh.json.access_token});
        assert.equal(stale.status,403,'changed policy/context cannot resume old operation');policyChange={status:'pass',oldCursorStatus:stale.status};
        scenarios.push(...await qualify(await createApprovedClinicalConsent()));
    }
}finally{if(runtime.config.conformance.preset==='connectathon-easy'){
    const r=await fetch(`${runtime.config.internalBaseUrls.pcmUi}/admin/config/simulation`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-admin-password':process.env.TEAM_ADMIN_PASSWORD||''},body:JSON.stringify({preset:'connectathon-easy'}),signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);
}}
const result={preset:runtime.config.conformance.preset,status:'pass',scope:'everything-backend-small-fixture',scenarios,...(policyChange?{policyChange}:{})};if(process.env.PCM_MATRIX_OUTPUT)fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={main,qualify};
