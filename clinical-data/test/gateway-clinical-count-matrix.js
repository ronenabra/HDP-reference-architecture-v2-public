'use strict';
/** Positive exact counts through ordinary PCM opaque tokens and all three public gateways. */
const fs = require('node:fs'), assert = require('node:assert/strict');
const { request, issue, approvePending, savedApproval, client, config } = require('./demo-runtime-client');
const { buildEffectivePolicy, sourceSimulationControls } = require('/shared/conformance-policy');
const { countFixtureCases } = require('./count-fixture-oracle');

/** Use the ordinary private approval workflow with the explicit three-source clinical decision. */
async function createApprovedClinicalConsent() {
    const binding = config.serviceCatalog.bindings.find(item => item.application === 'doctor' && item.serviceKey === 'lab-follow-up');
    const pending = await client.createConsentRequest('http://fhir.health.gov.il/identifier/il-national-id|000000018', binding.instanceId, 'hospital-a');
    assert.equal(pending.status, 'proposed');
    return approvePending(pending, { scopeChoice: 'service-provided',
        sourceIds: config.healthOrganizations.map(ho => ho.dataSourceOrganization.id) });
}

/** Compare independently known clinical IDs and the complete ordinary result set with both aliases. */
async function qualifyGatewayClinicalCounts(consent) {
    assert.equal(consent.status, 'active');
    assert.equal(consent.patient.identifier.system, 'http://fhir.health.gov.il/identifier/il-national-id');
    assert.equal(consent.patient.identifier.value, '000000018');
    const scenarios = [];
    for (const [index, ho] of config.healthOrganizations.entries()) {
        let grantedScope;
        const liveConfig = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
        const policy = buildEffectivePolicy(liveConfig, process.env);
        const fixture = countFixtureCases(ho.id, sourceSimulationControls(policy, liveConfig, { resource: ho.endpoint }), savedApproval(consent).scope);
        const cases = [];
        for (const [query, expectedIds] of fixture.cases) {
            const boundedQuery = `_id=${fixture.universe.join(',')}${query ? '&' + query : ''}`;
            const issued = await issue(consent, undefined, index);
            assert.equal(issued.status, 200, `${ho.id} ordinary PCM clinical token`);
            grantedScope = issued.json.scope;
            assert.equal(grantedScope, savedApproval(consent).scope);
            const ordinary = await request(`${ho.endpoint}/Observation?${boundedQuery}&_count=200`, { bearer: issued.json.access_token });
            assert.equal(ordinary.status, 200);
            assert.ok(!(ordinary.json.link || []).some(link => link.relation === 'next'), 'ordinary oracle must be complete');
            const ids = [...new Set((ordinary.json.entry || []).map(entry => entry.resource.id))].sort();
            assert.deepEqual(ids, [...expectedIds].sort(), `${ho.id} independent positive fixture oracle: query=${boundedQuery}; scope=${grantedScope}`);
            if (fixture.nativeFiltering) assert.equal(ordinary.json.total, undefined, 'ordinary protected clinical totals remain omitted');
            const aliases = [];
            for (const controls of ['_summary=count&_total=accurate', '_count=0']) {
                const counted = await request(`${ho.endpoint}/Observation?${boundedQuery}&${controls}`, { bearer: issued.json.access_token });
                assert.equal(counted.status, 200, `${ho.id} ${query} clinical gateway count: HTTP${counted.status} ${JSON.stringify(counted.json)}`);
                assert.equal(counted.json.type, 'searchset');
                assert.equal(counted.json.total, expectedIds.length);
                assert.deepEqual(counted.json.entry || [], []);
                const linkRelations = (counted.json.link || []).map(link => link.relation);
                if (fixture.nativeFiltering) assert.deepEqual(linkRelations, []);
                else assert.ok(linkRelations.every(relation => relation === 'self'), 'native simulation count must not publish paging links');
                aliases.push({ controls, status: counted.status, total: counted.json.total, linkRelations });
            }
            cases.push({ query: boundedQuery, expectedIds, ordinaryIds: ids, aliases });
        }
        const prefix = fixture.nativeFiltering ? 'gateway-clinical-count' : 'gateway-clinical-count-simulation';
        const scenario = { id: `${prefix}-${ho.id}`, status: 'pass', executed: true,
            ordinaryPcmToken: true, fixture: 'national-id000000018; approved Laboratory follow-up; independently known four-ID universe',
            effectiveNativePolicy: fixture.mode, nativeFiltering: fixture.nativeFiltering,
            approvedScope: savedApproval(consent).scope, grantedScope, cases };
        scenarios.push(scenario, { ...scenario, id: `${prefix}-positive-${ho.id}` });
    }
    return scenarios;
}

/** Read-only supplemental proof reuses an already approved clinical Consent from maintained sanity. */
async function main() {
    const create = process.env.PCM_COUNT_CREATE_CLINICAL_CONSENT === 'owned-stable-phase';
    assert.ok(create || process.env.PCM_COUNT_EXISTING_CONSENT_ID, 'explicit stable setup or existing Consent required');
    const consent = create ? await createApprovedClinicalConsent()
        : await client.checkConsentStatus(process.env.PCM_COUNT_EXISTING_CONSENT_ID, 'hospital-a');
    const scenarios = await qualifyGatewayClinicalCounts(consent);
    const result = { preset: config.conformance.preset, status: 'pass', countRequestsUseOrdinaryPcmTokens: true, scenarios };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { qualifyGatewayClinicalCounts, createApprovedClinicalConsent };
