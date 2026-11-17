'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PRESETS}=require('../../src/shared/conformance-policy');
const {GRAPH_CASES,validateBackendEverythingQualification}=require('../scripts/backend-everything-coverage');
const approvedScope=require('../../config/demo-services.json').clinicalServices.find(item=>item.key==='lab-follow-up').serviceGrant.scope;
const image=`sha256:${'a'.repeat(64)}`,hos=['ho-a','ho-b','ho-c'];
/** Independently authored tiny evidence envelope tests missing/widened authority and incomplete scope. */
function good(){return {scope:'everything-backend-small-fixture',releaseQualification:false,
    native:{status:'pass',results:hos.map(ho=>({ho,status:'pass'}))},graph:{status:'pass',cases:GRAPH_CASES.map(name=>({name,...(name==='patient-grants-remain-single-target-cyclic-graph'?{excludedForeign:'Observation/ds-everything-other-observation',sharedSupport:'Practitioner/practitioner-ho-a-0001',cycle:['Observation/ds-everything-anchor','Observation/ds-everything-other-observation','Observation/ds-everything-anchor'],pages:[{ids:['Observation/ds-everything-anchor']}]}:{})})),cleanup:{failures:[]}},
    delta:{status:'pass',cases:['default-count','capped-count','encoded-retained-type','conjunctive-bucket-date','disjoint-overlapping-scope-union'].map(name=>({name}))},
    simulation:{status:'pass',allOffSimulation:false,cases:[...hos.map(ho=>({ho,name:'scoped-signature-raw-query-target-expiry-and-count-denials',status:'pass',baselineStatus:200,
        scope:'patient/Observation.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&date=ge2026-01-01',
        expected:[1,2].map(n=>`Observation/observation-${ho}-000${n}`),pages:[1,2].map(n=>({ids:[`Observation/observation-${ho}-000${n}`]})),
        checks:['missing-target','wrong-target','cursor-target','raw-query','signature','unsigned','expiry','zero-count','summary-count','accurate-total'],
        admissionNegatives:['private-version-4','context-version-3','unfiltered-kind']})),{ho:'ho-a',name:'ambiguous-resolver',status:'pass'}]},
    deadline:{status:'pass',blockedAfterDeadline:0,independentLockStillHeld:true,idleTransactions:0},cleanup:{status:'pass'},
    presets:PRESETS.map(preset=>({preset,status:'pass',policyChange:{oldCursorStatus:403},images:Object.fromEntries(hos.map(ho=>[`${ho}-hapi`,image])),
        scenarios:hos.flatMap(ho=>(['enforced']).flatMap(mode=>['type','instance'].map(form=>{
            const ids=[1,2].map(n=>`observation-${ho}-000${n}`);
            return {id:`gateway-clinical-everything-${mode}-${ho}-${form}`,status:'pass',executed:true,ordinaryPcmToken:true,approvedScope,expectedIds:ids,actualIds:[...ids],distinctApprovedOpaqueTokens:2,
                compatibility:{count:ids.length,total:ids.length,continuationStatus:200,defaultTotalOmitted:true},pages:ids.map((id,n)=>({ids:[id],authorityRevalidated:true,grantedScope:approvedScope,distinctEquivalentToken:n===1,next:n===ids.length-1?null:'next'}))};
        })))}))};}
test('closed operation backend scope accepts independent complete small proof',()=>assert.equal(validateBackendEverythingQualification(good(),image),true));
test('missing forms, sources, modes, native freshness or integrity cannot pass',()=>{
    for(const change of [r=>r.presets.pop(),r=>r.presets[0].scenarios.pop(),r=>r.graph.cases.pop(),r=>r.simulation.cases.pop(),r=>{r.presets[0].images['ho-a-hapi']='drift';}]){
        const result=good();change(result);assert.throws(()=>validateBackendEverythingQualification(result,image));
    }
});
test('widened/duplicated results, stale authority, surviving work and release claims fail',()=>{
    for(const change of [r=>r.presets[0].scenarios[0].actualIds.push('other-patient'),r=>{r.presets[0].scenarios[0].pages[1].authorityRevalidated=false;},r=>{r.deadline.blockedAfterDeadline=1;},r=>{r.cleanup.status='fail';},r=>{r.releaseQualification=true;}]){
        const result=good();change(result);assert.throws(()=>validateBackendEverythingQualification(result,image));
    }
});

test('saved scope drift or a missing frozen scope cannot borrow historical result IDs', () => {
    for (const scope of [undefined, approvedScope.replace('laboratoryTests', 'procedures')]) {
        const result = good();
        const scenario = result.presets[0].scenarios.find(item => item.ordinaryPcmToken);
        scenario.approvedScope = scope;
        assert.throws(() => validateBackendEverythingQualification(result, image));
    }
});

test('obsolete admission-only evidence cannot stand in for later scoped operation boundaries', () => {
    for (const change of [r => { r.simulation.allOffSimulation = true; },
        r => { r.simulation.cases[0].name = 'all-off-signature-raw-query-target-expiry-and-count-denials'; },
        r => { r.simulation.cases[0].baselineStatus = 403; },
        r => { r.simulation.cases[0].scope = 'system/*.*'; },
        r => { r.simulation.cases[0].expected.push('Observation/observation-ho-a-0004'); },
        r => { r.simulation.cases[0].pages.pop(); },
        r => { r.simulation.cases[0].checks.pop(); },
        r => { r.simulation.cases[0].admissionNegatives.pop(); },
        r => { r.graph.cases[0].name = 'broad-system-grants-remain-single-target-cyclic-shared-graph'; },
        r => { r.graph.cases[0].pages[0].ids.push(r.graph.cases[0].excludedForeign); },
        r => { r.graph.cases[0].pages[0].ids.push(r.graph.cases[0].sharedSupport); },
        r => { r.graph.cases[0].pages[0].ids = []; },
        r => { r.graph.cases[0].cycle.pop(); }]) {
        const result = good(); change(result);
        assert.throws(() => validateBackendEverythingQualification(result, image));
    }
});
