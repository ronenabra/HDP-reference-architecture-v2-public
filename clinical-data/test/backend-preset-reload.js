'use strict';
/** Existing protected Admin runtime reload used only between same-mode named backend presets. */
const assert=require('node:assert/strict'),fs=require('node:fs');
async function main(){const config=JSON.parse(fs.readFileSync('/runtime/team-config.json')),preset=process.env.PCM_TARGET_PRESET;
assert.ok(['connectathon-mtls','connectathon-balanced','connectathon-easy'].includes(preset));
const response=await fetch(`${config.internalBaseUrls.pcmUi}/admin/config/simulation`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-admin-password':process.env.TEAM_ADMIN_PASSWORD||''},body:JSON.stringify({preset}),signal:AbortSignal.timeout(15000)});
const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));assert.equal(json.applied,'runtime-reload');
const after=JSON.parse(fs.readFileSync('/runtime/team-config.json'));assert.equal(after.conformance.preset,preset);
const result={status:'pass',preset,applied:json.applied,effectivePolicy:json.effectivePolicy,beforeRevision:config.runtime.revision,afterRevision:after.runtime.revision};
if(process.env.PCM_MATRIX_OUTPUT)fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});module.exports={main};
