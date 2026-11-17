'use strict';
/** Real frozen approvals, current introspection and public gateway/native isolation in every preset. */
const fs = require('node:fs'), assert = require('node:assert/strict');
const { request, issue, introspect, save, approvePending, savedApproval, client, config } = require('./demo-runtime-client');
const { createApprovedClinicalConsent, qualifyGatewayClinicalCounts } = require('./gateway-clinical-count-matrix');
const NATIONAL = 'http://fhir.health.gov.il/identifier/il-national-id|000000018';
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
// Deliberate manual alternative: no bucket/history/R exclusion; V stays excluded in every clause.
const BROAD = ['Patient', 'Observation', 'DiagnosticReport', 'Condition'].map(type => `patient/${type}.rs?${V}`).join(' ');
const binding = key => config.serviceCatalog.bindings.find(item => item.application === 'doctor' && item.serviceKey === key);

/** Both values of the retired flag must reject without publishing any config bytes. */
async function rejectRetiredFlags() {
    const outcomes = [];
    for (const value of [false, true]) {
        const before = fs.readFileSync('/runtime/team-config.json');
        const response = await fetch(`${config.internalBaseUrls.pcmUi}/admin/config/simulation`, {
            method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD },
            body: JSON.stringify({ preset: config.conformance.preset, grantFullClinicalAccess: value }), signal: AbortSignal.timeout(15000)
        });
        assert.equal(response.status, 400, `retired flag ${value} must reject`);
        assert.deepEqual(fs.readFileSync('/runtime/team-config.json'), before, 'rejection must not change config/revision');
        outcomes.push({ value, status: response.status, configUnchanged: true });
    }
    return outcomes;
}

/** Compare actual saved, issued and Data Source active authority before probing a separate query. */
async function activeAuthority(consent, issued, index = 0) {
    assert.equal(issued.status, 200, JSON.stringify(issued.json));
    const active = await introspect(issued.json.access_token, index);
    assert.equal(active.status, 200); assert.equal(active.json.active, true);
    assert.equal(issued.json.scope, savedApproval(consent).scope);
    assert.equal(active.json.scope, issued.json.scope);
    assert.deepEqual(active.json.authorization_details, issued.json.authorization_details);
    return { savedScope: savedApproval(consent).scope, issuedScope: issued.json.scope, activeScope: active.json.scope };
}

async function main() {
    const retiredFlags = await rejectRetiredFlags();
    assert.equal((await save()).status, 200);
    const scenarios = [], gatewayCounts = [];
    // HTEST1 has no Observations in this bound fixture: prove the exact zero count on every source.
    const zeroConsent = await client.createConsentRequest('http://fhir.health.gov.il/identifier/il-hdp-test-id|1', binding('lab-follow-up').instanceId, 'hospital-a');
    for (const [index, ho] of config.healthOrganizations.entries()) {
        const issued = await issue(zeroConsent, undefined, index);
        await activeAuthority(zeroConsent, issued, index);
        const enumerated = await request(`${ho.endpoint}/Observation?_count=200`, { bearer: issued.json.access_token });
        assert.equal(enumerated.status, 200);
        assert.ok(!(enumerated.json.link || []).some(link => link.relation === 'next'));
        assert.deepEqual(enumerated.json.entry || [], [], 'known HTEST1 Observation fixture is empty');
        for (const controls of ['_summary=count&_total=accurate', '_count=0']) {
            const counted = await request(`${ho.endpoint}/Observation?${controls}`, { bearer: issued.json.access_token });
            assert.equal(counted.status, 200); assert.equal(counted.json.total, 0);
            assert.equal(counted.json.type, 'searchset'); assert.deepEqual(counted.json.entry || [], []); assert.deepEqual(counted.json.link || [], []);
        }
        gatewayCounts.push({ id: `gateway-clinical-zero-${ho.id}`, status: 'pass', executed: true, expected: 0, ordinaryPcmToken: true });
    }
    const restricted = await createApprovedClinicalConsent(), original = savedApproval(restricted);
    const ordinary = await issue(restricted); const restrictedAuthority = await activeAuthority(restricted, ordinary);
    assert.match(original.scope, /v3-Confidentiality\|R/); assert.match(original.scope, /v3-Confidentiality\|V/);
    const different = await issue(restricted, 'patient/Condition.rs');
    await activeAuthority(restricted, different);
    assert.equal(different.json.scope, original.scope, 'advisory request cannot add Condition authority');
    const deniedCondition = await request(`${config.healthOrganizations[0].endpoint}/Condition`, { bearer: ordinary.json.access_token });
    assert.ok(deniedCondition.status >= 400, 'restricted approval cannot query Condition');
    gatewayCounts.push(...await qualifyGatewayClinicalCounts(restricted));
    // A broader compatible request ceiling cannot widen this existing approval.
    const compatible = await issue(restricted, 'patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs patient/Condition.rs');
    assert.equal(compatible.status, 200); assert.equal(compatible.json.scope, original.scope);
    assert.deepEqual(savedApproval(await client.checkConsentStatus(restricted.id, 'hospital-a')), original);
    scenarios.push({ id: 'demo-access-ordinary-restricted', status: 'pass', executed: true, consentId: restricted.id,
        ...restrictedAuthority, compatibleCeilingPreservedScope: true, conditionDenied: deniedCondition.status });

    // Changed permissions use a different ordinary pending Consent and explicit manual decision, including Strict.
    const pending = await client.createConsentRequest(NATIONAL, binding('lab-follow-up').instanceId, 'hospital-a');
    assert.equal(pending.status, 'proposed');
    const broadConsent = await approvePending(pending, { scopeChoice: 'custom', customScope: BROAD,
        sourceIds: [config.healthOrganizations[0].dataSourceOrganization.id] });
    assert.notEqual(broadConsent.id, restricted.id); assert.equal(savedApproval(broadConsent).scope, BROAD);
    const broad = await issue(broadConsent); const broadAuthority = await activeAuthority(broadConsent, broad);
    const source = config.healthOrganizations[0].endpoint;
    const data = await request(`${source}/Condition?_count=200`, { bearer: broad.json.access_token });
    assert.equal(data.status, 200);
    assert.deepEqual((data.json.entry || []).map(item => item.resource.id), ['qualification-ho-a-condition-national']);
    assert.ok(!data.json.link?.some(link => link.relation === 'next'));
    const condition = await request(`${source}/Condition/qualification-ho-a-condition-national`, { bearer: broad.json.access_token });
    assert.equal(condition.status, 200); assert.equal(condition.json.subject.reference, 'Patient/patient-ho-a-0001');
    const observations = await request(`${source}/Observation?_count=200`, { bearer: broad.json.access_token });
    assert.equal(observations.status, 200);
    const observationFixture = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname, '../ci/ho-a.source.transaction.json')));
    const broadIds = observationFixture.entry.map(entry => entry.resource).filter(record => record.resourceType === 'Observation'
        && record.subject?.reference === 'Patient/patient-ho-a-0001'
        && !record.meta.security.some(label => label.system === 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality' && label.code === 'V'))
        .map(record => record.id).sort();
    assert.equal(broadIds.length, 3, 'bound V-only manual fixture has three ordinary Observations');
    assert.deepEqual((observations.json.entry || []).map(item => item.resource.id).sort(), broadIds);
    const forbiddenV = await request(`${source}/Observation/observation-ho-a-0004`, { bearer: broad.json.access_token });
    assert.ok(forbiddenV.status >= 400, 'the actual V-labelled record must remain denied');
    const foreignPatient = await request(`${source}/Patient?identifier=${encodeURIComponent('http://fhir.health.gov.il/identifier/il-hdp-test-id|2')}`, { bearer: broad.json.access_token });
    assert.ok(foreignPatient.status >= 400 || !(foreignPatient.json.entry || []).length);
    assert.notEqual((await issue(broadConsent, undefined, 1)).status, 200, 'unapproved source cannot mint authority');
    assert.ok((await request(`${config.healthOrganizations[1].endpoint}/Condition`, { bearer: broad.json.access_token })).status >= 400);
    assert.ok((await request(`${source}/Condition`, { method: 'POST', bearer: broad.json.access_token, body: { resourceType: 'Condition' } })).status >= 400);
    const requestedWrite = await issue(broadConsent, 'patient/Condition.c');
    assert.equal(requestedWrite.status, 400, 'advisory ceilings still require supported read/search syntax');
    assert.equal(requestedWrite.json.error, 'invalid_scope');
    assert.deepEqual(savedApproval(await client.checkConsentStatus(restricted.id, 'hospital-a')), original);
    const cancelled = await client.deactivateConsent(broadConsent.id, 'hospital-a');
    assert.equal(cancelled.status, 'inactive'); assert.equal(savedApproval(cancelled).scope, BROAD);
    assert.equal((await introspect(broad.json.access_token)).json.active, false);
    assert.notEqual((await issue(cancelled)).status, 200);
    // Existing positive adapter/native decisions are bounded to 30 seconds; never clear their stores to fake revocation.
    await new Promise(resolve => setTimeout(resolve, 31000));
    const revoked = await request(`${source}/Condition`, { bearer: broad.json.access_token });
    assert.ok(revoked.status >= 400);
    scenarios.push({ id: 'demo-access-explicit-broad-approval-and-native-isolation', status: 'pass', executed: true,
        consentId: broadConsent.id, ...broadAuthority, query: 'Condition', expectedCondition: 'qualification-ho-a-condition-national',
        patientIsolation: true, sourceIsolation: true, writesDenied: true, actualVRecordDenied: forbiddenV.status,
        rPolicy: 'deliberate V-only manual approval permits R; this dataset has no R-labelled clinical record',
        cancellation: { inactiveIntrospection: true, newTokenDenied: true, nativeAfter31Seconds: revoked.status } });
    scenarios.push({ id: 'demo-access-retired-flags-rejected', status: 'pass', executed: true, outcomes: retiredFlags });
    const output = { preset: config.conformance.preset, status: 'pass', nativeFiltersDuringGrantProof: true, scenarios: [...gatewayCounts, ...scenarios] };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { BROAD, rejectRetiredFlags, activeAuthority, main };
