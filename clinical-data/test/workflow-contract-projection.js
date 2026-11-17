'use strict';
/** Assert exact registry-derived workflow membership in the runtime release matrix. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const shared = name => require(fs.existsSync('/shared') ? `/shared/${name}` : `../../src/shared/${name}`);
const { sourceInstitutionType } = shared('source-institution');
const { workflowIdentities, SYSTEM } = shared('workflow-identities');
const SCENARIO_SYSTEM = 'http://pcm.fhir.health.gov.il/cs/pcm-authorization-scenario';

/** Require every applicable configured Contract, excluding local sampling grants. */
function assertWorkflowProjection(resources, source, config) {
    const identities = workflowIdentities(config);
    const scenarios = sourceInstitutionType(source, { managed: true }) === 'hmo'
        ? ['presence-check', 'patient-authentication', 'dependent-discovery'] : ['presence-check'];
    const normative = resources.filter(resource => resource.subType?.some(type => type.coding?.some(coding =>
        coding.system === SCENARIO_SYSTEM && Object.hasOwn(identities, coding.code))));
    assert.deepEqual(normative.map(contract => contract.identifier?.find(item => item.system === SYSTEM)?.value).sort(),
        scenarios.map(scenario => identities[scenario]).sort(), 'source sees exactly its registry-derived workflow Contract identities');
    for (const contract of normative) {
        const scenario = contract.subType[0].coding[0].code;
        assert.equal(contract.identifier.find(item => item.system === SYSTEM).value, identities[scenario]);
        assert.equal(contract.status, 'executed'); assert.equal(contract.topicReference, undefined);
        assert.ok(contract.term[0].asset.length >= 3); assert.equal(contract.term[0].action, undefined);
    }
    return scenarios;
}
module.exports = { assertWorkflowProjection };
