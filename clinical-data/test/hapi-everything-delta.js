'use strict';
/** Final-image changed retrieval seam, encoded continuation restrictions, and compact ordinary-search compatibility. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {request}=require('./hapi-authorization-matrix');const {traverse}=require('./hapi-everything-matrix');
async function main(){const ho='ho-a',obs=[1,2,3,4].map(n=>`Observation/observation-${ho}-000${n}`),p=`Patient/patient-${ho}-0001`,full='patient/Patient.s patient/Observation.s',bucket='http://fhir.health.gov.il/cs/il-hdp-information-buckets|';
const cases=[];
for(const controls of ['', '?_count=999999999'])cases.push({name:controls?'capped-count':'default-count',pages:await traverse(ho,'/fhir/Patient/$everything'+controls,full,[p,...obs])});
cases.push({name:'encoded-retained-type',pages:await traverse(ho,'/fhir/Patient/$everything?%5Ftype=Observation&_count=1',full,obs)});
cases.push({name:'conjunctive-bucket-date',pages:await traverse(ho,'/fhir/Patient/$everything?_count=1',`patient/Observation.s?_security=${bucket}laboratoryTests&date=ge2026-01-02`,[obs[1],obs[3]])});
cases.push({name:'disjoint-overlapping-scope-union',pages:await traverse(ho,'/fhir/Patient/$everything?_count=1',`patient/Observation.s?_security=${bucket}laboratoryTests patient/Observation.s?_security=${bucket}procedures patient/Observation.s?status=preliminary`,obs)});
for(const source of ['ho-a','ho-b','ho-c']){
    const scope='patient/Observation.s',query='/fhir/Observation?_count=1&_total=accurate',r=await request(source,query,scope);assert.equal(r.response.status,200,r.text);assert.equal(r.body.total,4);
    const next=new URL(r.body.link.find(link=>link.relation==='next').url),continued=await request(source,next.pathname+next.search,scope);assert.equal(continued.response.status,200,continued.text);assert.equal(continued.body.total,4);
    const counted=await request(source,'/fhir/Observation?_summary=count',scope);assert.equal(counted.response.status,200);assert.equal(counted.body.total,4);assert.deepEqual(counted.body.entry||[],[]);
    const ordinary=await request(source,'/fhir/Observation?_count=1',scope);assert.equal(ordinary.response.status,200);assert.equal(ordinary.body.total,undefined);
    cases.push({name:'ordinary-page-count-total-compatibility',ho:source,status:'pass'});
}
const result={status:'pass',scope:'everything-final-image-delta',cases};if(process.env.PCM_MATRIX_OUTPUT)fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={main};
