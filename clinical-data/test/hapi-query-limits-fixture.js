'use strict';
/** One tiny disposable native fixture for the existing Admin browser harness. */
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), assert = require('node:assert/strict');
const { mapIdentity } = require('../../src/ds-auth-adapter/src/mapper');
const { validateIntrospectionResponse } = require('../../src/ds-auth-adapter/src/introspection-contract');
const { dataSourceResponse } = require('../../src/ds-auth-adapter/test-support/introspection-fixture');
const { buildEffectivePolicy, simulationPolicyStamp } = require('../../src/shared/conformance-policy');
const prefix = 'query-limits-fixture', created = [], report = { scope: 'one-disposable-managed-source', cases: [] };
const credential = 'owned-query-limits-runtime-01-only-20261116';
/** Call the owned TLS listener, keeping import credentials separate from protected clinical reads. */
function call(method, uri, body, token) {
    return new Promise((resolve, reject) => {
        const req = https.request(`https://ho-a-hapi:8080${uri}`, { method, ca: fs.readFileSync('/owned/certs/rootCA.crt'),
            headers: { 'content-type': 'application/fhir+json', accept: 'application/fhir+json',
                ...(token ? { authorization: `Bearer ${token}`, 'X-PCM-Request-Method': method, 'X-PCM-Request-URI': uri }
                    : { 'X-PCM-Import-Credential': credential }) } }, response => {
            let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part; });
            response.on('end', () => { let value; try { value = JSON.parse(text); } catch {} resolve({ status: response.statusCode, body: value }); });
        });
        req.setTimeout(20000, () => req.destroy(new Error('Native fixture request timed out'))); req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
}
/** Publish the real fixture config directory through a stable symlink; atomic Admin saves remain visible. */
async function initialize() {
    fs.symlinkSync(process.env.TEAM_CONFIG_PATH, '/owned/active-config.json');
    process.env.LOCAL_JWT_SIGNING_KEY_PATH = '/owned/certs/ho-a-gateway.key';
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
        try { ready = (await call('GET','/fhir/metadata')).status === 200; } catch {}
        if (!ready) await new Promise(resolve => setTimeout(resolve,1000));
    }
    assert.ok(ready,'owned native source ready');
    const patient = { resourceType:'Patient', id:`${prefix}-patient`, identifier:[{system:'http://fhir.health.gov.il/identifier/il-national-id',value:'000000018'}] };
    const resources = [patient,...[1,2].map(number=>({resourceType:'Observation',id:`${prefix}-${number}`,status:'final',code:{text:'Owned query limit fixture'},subject:{reference:`Patient/${patient.id}`}}))];
    for (const resource of resources) {
        const target = `${resource.resourceType}/${resource.id}`;
        assert.equal((await call('PUT',`/fhir/${target}`,resource)).status,201); created.push(target);
    }
}
/** A fresh private signed request uses the same mounted Admin document and a bounded native query. */
async function probe(label, expected) {
    const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)), ho = config.healthOrganizations[0];
    const now = Math.floor(Date.now()/1000), uri = `/fhir/Observation?_id=${prefix}-1,${prefix}-2&_count=1&_total=accurate`;
    const raw = { ...dataSourceResponse(), iat:now-1, exp:now+30, aud:ho.endpoint, iss:config.contract.operational.oauthBase, scope:'patient/Observation.rs' };
    const context = validateIntrospectionResponse(raw,{expectedIssuer:raw.iss,expectedAudience:ho.endpoint,hoId:ho.id,clock:()=>now});
    const controls = buildEffectivePolicy(config).simulation;
    const token = mapIdentity(context,{hoId:ho.id,issuer:ho.adapterIssuer,audience:ho.adapterAudience,identityOverrides:{},
        policyStamp:simulationPolicyStamp(controls.perSource[ho.id]||controls.controls,ho.id,(config.runtime.revision||0)-(config.runtime.queryLimitsRevisionOffset||0)),
        requestBinding:{method:'GET',uri}});
    const response = await call('GET',uri,undefined,token);
    report.cases.push({label,status:response.status,expected,revision:config.runtime.revision,limit:config.clinicalQuery?.sources?.[ho.id]?.maxPagePayloadBytes,total:response.body?.total,entries:response.body?.entry?.length});
    fs.writeFileSync('/artifacts/native.json',JSON.stringify(report,null,2));
    assert.equal(response.status,expected,JSON.stringify(response.body));
    if (expected===200) { assert.equal(response.body.total,2); assert.equal(response.body.entry.length,1); }
}
/** Delete only these three owned records; the external runner removes the disposable source afterward. */
async function cleanup() {
    report.cleanup=[];
    for (const resource of created.reverse()) {
        const response=await call('DELETE',`/fhir/${resource}`);report.cleanup.push({resource,status:response.status});assert.equal(response.status,200);
    }
    fs.writeFileSync('/artifacts/native.json',JSON.stringify(report,null,2));
}
module.exports={initialize,probe,cleanup};
