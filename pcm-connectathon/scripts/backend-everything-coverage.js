'use strict';
/** Closed Patient-operation backend inventory; never implies release/browser or large-graph qualification. */
const assert=require('node:assert/strict');
const {PRESETS}=require('../../src/shared/conformance-policy');
const HOS=['ho-a','ho-b','ho-c'];
const { laboratoryFixture } = require('../../clinical-data/test/count-fixture-oracle');
const GRAPH_CASES=['patient-grants-remain-single-target-cyclic-graph','contained-parent-representation','current-body-target-reassignment-between-pages','current-body-filter-change-with-unrestricted-read-between-pages'];
/** Require independently specified results, both forms, policy variants, current-body security and scoped cleanup. */
function validateBackendEverythingQualification(result,image){
    assert.equal(result.scope,'everything-backend-small-fixture');assert.equal(result.releaseQualification,false);assert.match(image,/^sha256:[a-f0-9]{64}$/);
    assert.equal(result.native.status,'pass');for(const ho of HOS)assert.equal(result.native.results.find(item=>item.ho===ho)?.status,'pass');
    assert.equal(result.graph.status,'pass');for(const name of GRAPH_CASES)assert.ok(result.graph.cases.some(item=>item.name===name));assert.deepEqual(result.graph.cleanup.failures,[]);
    const cyclic=result.graph.cases.find(item=>item.name==='patient-grants-remain-single-target-cyclic-graph');
    assert.equal(cyclic.excludedForeign,'Observation/ds-everything-other-observation');
    assert.equal(cyclic.sharedSupport,'Practitioner/practitioner-ho-a-0001');
    assert.deepEqual(cyclic.cycle,['Observation/ds-everything-anchor','Observation/ds-everything-other-observation','Observation/ds-everything-anchor']);
    assert.ok(!cyclic.pages.flatMap(page=>page.ids).includes(cyclic.excludedForeign));
    assert.ok(!cyclic.pages.flatMap(page=>page.ids).includes(cyclic.sharedSupport));
    assert.ok(cyclic.pages.flatMap(page=>page.ids).includes('Observation/ds-everything-anchor'));
    assert.equal(result.delta.status,'pass');for(const name of ['default-count','capped-count','encoded-retained-type','conjunctive-bucket-date','disjoint-overlapping-scope-union'])assert.ok(result.delta.cases.some(item=>item.name===name));
    assert.equal(result.simulation.status,'pass');assert.equal(result.simulation.allOffSimulation,false);
    for(const ho of HOS){
        const item=result.simulation.cases.find(item=>item.ho===ho&&item.name==='scoped-signature-raw-query-target-expiry-and-count-denials');
        assert.equal(item?.status,'pass');assert.equal(item.baselineStatus,200);
        assert.equal(item.scope,'patient/Observation.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&date=ge2026-01-01');
        assert.deepEqual(item.expected,[1,2].map(n=>`Observation/observation-${ho}-000${n}`));
        assert.ok(item.pages.length>=2,'scoped native traversal must cross a continuation');
        assert.deepEqual(item.pages.flatMap(page=>page.ids),item.expected);
        assert.deepEqual(item.checks,['missing-target','wrong-target','cursor-target','raw-query','signature','unsigned','expiry','zero-count','summary-count','accurate-total']);
        assert.deepEqual(item.admissionNegatives,['private-version-4','context-version-3','unfiltered-kind']);
    }
    assert.ok(result.simulation.cases.some(item=>item.ho==='ho-a'&&item.name==='ambiguous-resolver'&&item.status==='pass'));
    assert.equal(result.deadline.status,'pass');assert.equal(result.deadline.blockedAfterDeadline,0);assert.equal(result.deadline.independentLockStillHeld,true);assert.equal(result.deadline.idleTransactions,0);
    for(const preset of PRESETS){const run=result.presets.find(item=>item.preset===preset);assert.equal(run?.status,'pass',preset);
        if(preset==='connectathon-easy')assert.equal(run.policyChange?.oldCursorStatus,403);
        for(const ho of HOS){assert.equal(run.images[`${ho}-hapi`],image);
            for(const mode of ['enforced'])for(const form of ['type','instance']){
                const item=run.scenarios.find(value=>value.id===`gateway-clinical-everything-${mode}-${ho}-${form}`);assert.ok(item?.executed&&item.status==='pass'&&item.ordinaryPcmToken);
                const expected=laboratoryFixture(ho,item.approvedScope).allowed.map(record=>record.id);
                assert.deepEqual(item.expectedIds,expected);assert.deepEqual([...item.actualIds].sort(),[...expected].sort());assert.equal(new Set(item.actualIds).size,item.actualIds.length);
                assert.deepEqual(item.pages.flatMap(page=>page.ids),item.actualIds);assert.ok(item.pages.every(page=>page.ids.length===1&&page.authorityRevalidated));assert.equal(item.pages.at(-1).next,null);
                assert.ok(item.pages.every(page=>page.grantedScope===item.approvedScope),'exact saved/issued scope on every operation page');
                assert.equal(item.distinctApprovedOpaqueTokens,2);assert.equal(item.pages[1].distinctEquivalentToken,true);
                assert.equal(item.compatibility.count,expected.length);assert.equal(item.compatibility.total,expected.length);assert.equal(item.compatibility.continuationStatus,200);assert.equal(item.compatibility.defaultTotalOmitted,true);
            }
        }
    }
    assert.equal(result.cleanup.status,'pass');return true;
}
module.exports={GRAPH_CASES,validateBackendEverythingQualification};
