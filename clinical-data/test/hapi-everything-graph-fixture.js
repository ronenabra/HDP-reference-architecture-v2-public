'use strict';
/** Four temporary graph resources exercise cycles, shared supports, target isolation and current-body reauthorization. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { maintenance, observation } = require('./hapi-page-small-fixture');
const { request: nativeRequest } = require('./hapi-authorization-matrix');
const { traverse } = require('./hapi-everything-matrix');
const ho='ho-a', target=process.env.PCM_EVERYTHING_TARGET || 'patient-ho-a-0001', other='ds-everything-other-patient';
const anchor=observation('ds-everything-anchor','final');
anchor.subject={reference:`Patient/${target}`};
anchor.hasMember=[{reference:'Observation/ds-everything-other-observation'}];
anchor.performer=[{reference:'Practitioner/practitioner-ho-a-0001'}];
anchor.contained=[{resourceType:'Observation',id:'contained-local',status:'final',code:{text:'Contained clinical detail'}}];
const foreign={...observation('ds-everything-other-observation','final'),subject:{reference:`Patient/${other}`},hasMember:[{reference:`Observation/${anchor.id}`}],performer:anchor.performer};
const rows=[{resourceType:'Patient',id:other,name:[{text:'Other operation graph patient'}]},foreign,anchor];
const scope='patient/Patient.s patient/Observation.s';
const expected=[`Patient/${target}`,...(process.env.PCM_EVERYTHING_OBSERVATIONS
    ? JSON.parse(process.env.PCM_EVERYTHING_OBSERVATIONS)
    : [1,2,3,4].map(n=>`Observation/observation-ho-a-000${n}`)),`Observation/${anchor.id}`];
const options=process.env.PCM_EVERYTHING_PATIENT_IDENTIFIER
    ? {claims:{patient_identifier:JSON.parse(process.env.PCM_EVERYTHING_PATIENT_IDENTIFIER)}} : {};
/** Permit the small graph fixture to coexist with a separate sparse population and identity. */
function request(ho,uri,scope){return nativeRequest(ho,uri,scope,options);}
async function main(){const result={status:'running',temporaryResources:rows.length,cases:[]};try{
    await maintenance('POST','',{resourceType:'Bundle',type:'transaction',entry:rows.map(resource=>({resource,request:{method:'PUT',url:`${resource.resourceType}/${resource.id}`}}))});
    const pages = await traverse(ho,'/fhir/Patient/$everything?_count=1',scope,expected,options);
    // Both sides share one support resource and form a cycle across the target boundary.
    // Exact traversal membership above excludes the foreign node and shared Practitioner.
    assert.deepEqual(anchor.performer, foreign.performer);
    assert.equal(anchor.hasMember[0].reference, `Observation/${foreign.id}`);
    assert.equal(foreign.hasMember[0].reference, `Observation/${anchor.id}`);
    result.cases.push({name:'patient-grants-remain-single-target-cyclic-graph',pages,
        excludedForeign:`Observation/${foreign.id}`, sharedSupport:anchor.performer[0].reference,
        cycle:[`Observation/${anchor.id}`,`Observation/${foreign.id}`,`Observation/${anchor.id}`]});
    const contained=await request(ho,`/fhir/Patient/${target}/$everything?_count=100`,scope);
    const parent=contained.body.entry.find(entry=>entry.resource.id===anchor.id).resource;
    assert.deepEqual(parent.contained.map(resource=>resource.id),['contained-local']);
    assert.deepEqual(parent.hasMember,anchor.hasMember,'the returned anchor retains its cross-target cycle edge');
    assert.deepEqual(parent.performer,anchor.performer,'the returned anchor retains its shared support reference');
    assert.ok(!contained.body.entry.some(entry=>entry.resource.id==='contained-local'),'contained content is indivisible parent representation, not standalone enumeration');
    result.cases.push({name:'contained-parent-representation',status:'pass'});
    const first=await request(ho,'/fhir/Patient/$everything?_count=1',scope);
    const next=new URL(first.body.link.find(link=>link.relation==='next').url);
    await maintenance('PUT',`/Observation/${anchor.id}`,{...anchor,subject:{reference:`Patient/${other}`}});
    const seen=[];let uri=next.pathname+next.search;
    for(let n=0;n<20;n++){
        const r=await request(ho,uri,scope);assert.equal(r.response.status,200,r.text);
        seen.push(...(r.body.entry||[]).map(entry=>entry.resource.id));
        const link=r.body.link?.find(value=>value.relation==='next')?.url;if(!link)break;
        const parsed=new URL(link);uri=parsed.pathname+parsed.search;assert.ok(n<19);
    }
    assert.ok(!seen.includes(anchor.id),'current bodies cannot retain stale patient authority');
    result.cases.push({name:'current-body-target-reassignment-between-pages',status:'pass'});
    await maintenance('PUT',`/Observation/${anchor.id}`,anchor);
    const filteredScope='patient/Observation.s?status=final patient/Observation.r';
    const filtered=await request(ho,'/fhir/Patient/$everything?_type=Observation&_count=1',filteredScope);
    const filteredNext=new URL(filtered.body.link.find(link=>link.relation==='next').url);
    await maintenance('PUT',`/Observation/${anchor.id}`,{...anchor,status:'amended'});
    const filteredSeen=[];uri=filteredNext.pathname+filteredNext.search;
    for(let n=0;n<20;n++){
        const r=await request(ho,uri,filteredScope);assert.equal(r.response.status,200,r.text);
        filteredSeen.push(...(r.body.entry||[]).map(entry=>entry.resource.id));
        const link=r.body.link?.find(value=>value.relation==='next')?.url;if(!link)break;
        const parsed=new URL(link);uri=parsed.pathname+parsed.search;assert.ok(n<19);
    }
    assert.ok(!filteredSeen.includes(anchor.id),'current MATCH s filter cannot be widened by r');
    result.cases.push({name:'current-body-filter-change-with-unrestricted-read-between-pages',status:'pass'});
    result.status='pass';
}finally{
    const failures=[];
    // Break only this fixture's cycles before deleting; native referential
    // integrity correctly rejects either individual delete while the cycle exists.
    for (const resource of [anchor,foreign]) {
        const detached={...resource}; delete detached.hasMember;
        try { await maintenance('PUT', `/Observation/${resource.id}`, detached); } catch (error) { failures.push(error.message); }
    }
    for(const resource of [...rows].reverse())try{await maintenance('DELETE',`/${resource.resourceType}/${resource.id}`);}catch(error){failures.push(error.message);}
    result.cleanup={deleted:rows.length,failures};assert.deepEqual(failures,[]);
    if(process.env.PCM_MATRIX_OUTPUT)fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT,JSON.stringify(result,null,2));
}console.log(JSON.stringify(result));}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={main};
