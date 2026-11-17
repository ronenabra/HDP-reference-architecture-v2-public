'use strict';
/** One locked tiny native graph proves active verified-deadline cancellation without any larger fixture. */
const assert=require('node:assert/strict'),fs=require('node:fs');
const {request}=require('./hapi-authorization-matrix');
async function main(){const started=Date.now();const r=await request('ho-a','/fhir/Patient/$everything?_type=Observation&_count=1','patient/Observation.s');const elapsedMs=Date.now()-started;
    assert.equal(r.response.status,503,r.text);assert.equal(r.body.resourceType,'OperationOutcome');assert.equal(r.body.total,undefined);assert.ok(elapsedMs<12000,`active deadline ${elapsedMs}`);
    const result={status:'pass',elapsedMs,httpStatus:r.response.status,completeOutcome:true,noPartialBundle:true};if(process.env.PCM_MATRIX_OUTPUT)fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
module.exports={main};
