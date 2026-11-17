'use strict';
/** R8 distinct panels, R1 route-owned drafts and truthful completed-result rendering. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const config = require('../../../test-support/team-config').installTestRuntime();
const { toConfigDataSource } = require('../src/data-sources');
const source = toConfigDataSource({ id:'r8-exact-source', clientId:'r8-exact-client', name:'R8 source', endpoint:'https://r8.example.test/fhir' });
source.pcmClientAuth.certThumbprint = 'A'.repeat(43);
config.organizations.dataSources = [source]; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
const router = require('../src/routes/ui');
require('../src/data-sources').syncDataSourcesToStore(require('../src/fhir/store'),config,null,{preserveExisting:true});
const render = (query, options = {}) => router._test.renderAdminHtml({query},options);
/** Invoke the actual trust route so rejected draft rendering also proves no configuration publication. */
function trust(suffix, body) {
    const route = `/admin/config/data-sources/:id/server-trust/${suffix}`;
    const response = { code:200, status(code) { this.code=code; return this; }, send(value) {this.html=value; return this;}, json(value) {this.value=value; return this;}, redirect(value) {this.location=value;}, format(types) {types.html();} };
    router.stack.find(layer => layer.route?.path===route).route.stack[0].handle({path:`/admin/config/data-sources/${source.id}/server-trust/${suffix}`,params:{id:source.id},query:{source:config.healthOrganizations[0].dataSourceOrganization.id},body,get:()=>'text/html'}, response);
    return response;
}
test('R1 rejected pin and CA and stale revision keep exact source drafts without publication or cross-form leakage', () => {
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    for (const [suffix, fields, expected] of [
        ['thumbprint',{serverTrustMode:'pinned-thumbprint',serverTrustCertThumbprint:'bad <pin>'},/value="bad &lt;pin&gt;"/],
        ['ca',{serverTrustMode:'custom-ca',serverTrustCaCert:'custom/missing-ca.crt'},/value="custom\/missing-ca.crt"/],
        ['thumbprint',{serverTrustMode:'pinned-thumbprint',serverTrustCertThumbprint:'B'.repeat(43),expectedRevision:'-1'},/value="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"/]
    ]) {
        const result=trust(suffix,{adminForm:'source-trust',expectedRevision:String(config.runtime.revision||0),...fields,name:'do not leak',password:'do not echo',privateKey:'do not echo'});
        assert.ok(result.code>=400); assert.match(result.html,expected); assert.ok(result.html.includes(`data-source-workspace="${source.id}"`));
        assert.ok(result.html.includes(`value="${fields.serverTrustMode}" selected`)); assert.match(result.html,/source-trust-error/);
        assert.doesNotMatch(result.html,/do not leak|do not echo/); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH),before);
    }
    const draft=require('../src/routes/admin-draft');
    assert.equal(draft.draftValue({path:'/admin/config/data-sources/another/server-trust/thumbprint',body:{serverTrustCertThumbprint:'bad'}},{adminError:{}},`/admin/config/data-sources/${source.id}/server-trust/thumbprint`,'serverTrustCertThumbprint','saved'),'saved');
});
test('R1 a corrected pin saves through existing revision command with fixed identity', () => {
    const before=fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    try {
        const result=trust('thumbprint',{adminForm:'source-trust',expectedRevision:String(config.runtime.revision||0),serverTrustMode:'pinned-thumbprint',serverTrustCertThumbprint:'B'.repeat(43)});
        assert.equal(result.code,200,result.html?.match(/small mt-1[^>]*>([^<]+)/)?.[1]); assert.ok(result.location.endsWith(`source=${source.id}&view=trust`));
        const saved=JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)); const actual=saved.organizations.dataSources.find(item=>item.id===source.id);
        assert.equal(actual.serverTrust.certThumbprint,'B'.repeat(43));assert.equal(actual.clientId,source.clientId);
    } finally {fs.writeFileSync(process.env.TEAM_CONFIG_PATH,before);}
});
test('built-in source views contain distinct facts and preserve operator boundaries and registration controls', () => {
    const id=config.healthOrganizations[0].dataSourceOrganization.id;
    const registration=render({section:'sources',source:id,view:'registration'}), trust=render({section:'sources',source:id,view:'trust'}), credentials=render({section:'sources',source:id,view:'credentials'});
    assert.match(render({section:'sources',source:id,view:'registration',sourceInstitution:'saved'}),/Institution type saved/);
    assert.match(registration,/name="institutionType"/);assert.match(registration,/FHIR base URL/);
    assert.doesNotMatch(trust,/name="institutionType"|PCM client cert x5t|FHIR base URL|type="file"/);assert.match(trust,/Server verification is <strong>off/);assert.match(trust,/Saved trust method/);
    assert.match(credentials,/mTLS client authentication and signed client assertions/);assert.doesNotMatch(credentials,/Saved trust method|FHIR base URL|type="file"/);
    assert.ok([registration,trust,credentials].every(html=>(html.match(/data-admin-section=/g)||[]).length===7));
});
test('overview groups compact exact addresses, preserves protocol values and has no invented check', () => {
    const html=render({section:'overview'});assert.match(html,/Browser applications/);assert.match(html,/Configured API addresses/);assert.match(html,/Configuration details/);
    assert.ok(html.includes(config.contract.operational.oauthBase));assert.doesNotMatch(html,/Configured connections|Component adoption:|Last sanity check/);
});
test('completed incomplete/error results distinguish checks from unexercised flows and remain recoverably dismissible', () => {
    const sanityResult={ok:false,result:{status:'incomplete',checks:[{name:'ho-a-gateway-readiness',status:'pass',httpStatus:200},{name:'ho-a-online-presence-count-only',status:'incomplete',state:'populated-unverified',reason:'No verified test fixture'},{name:'doctor-flow-not-applicable-without-verified-fixture',status:'pass',reason:'No selected fixture has been verified on its named source.'}]}};
    const html=render({section:'logs'},{sanityResult});assert.match(html,/Incomplete — some checks/);assert.match(html,/Passed/);assert.match(html,/Not exercised/);assert.match(html,/populated-unverified/);assert.match(html,/data-admin-dismiss="admin-sanity-result"/);assert.match(html,/Show \/ hide last result/);
    assert.doesNotMatch(html,/Sanity check ERROR|Sanity check OK/);
    const error=render({section:'logs'},{sanityResult:{ok:false,error:'owned runner failure'}});assert.match(error,/owned runner failure/);assert.match(error,/runner did not return individual checks/);assert.match(error,/No individual checks were recorded/);
    assert.match(render({section:'overview'},{sanityResult}),/Last sanity check/);
});

test('sanity runner failure cannot become green from recorded passing checks and explicit skips stay unexercised',()=>{
    const view=require('../src/admin-sanity-view').sanityView({ok:false,result:{status:'pass',checks:[{name:'unrun',status:'skipped'}]}});
    assert.equal(view.status,'fail');assert.equal(view.rows[0].status,'Not exercised');
});
