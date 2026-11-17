'use strict';
/** Actual source simulation, immutable audiences and native revocation after the bounded positive cache. */
const fs = require('fs'), assert = require('node:assert/strict');
const { request, issue, introspect, save, approvePending, savedApproval, requestCeiling, client, config } = require('./demo-runtime-client');
const { sourceChangeFields } = require('./demo-source-form');
const { laboratoryFixture } = require('./count-fixture-oracle');
const ids = config.healthOrganizations.map(source => source.dataSourceOrganization.id);
const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD };
/** Read the displayed version and form token from the actual private Consent page. */
async function displayed(id) {
    const html = await (await fetch(`${config.internalBaseUrls.pcmUi}/ui/approve/${id}`)).text();
    return { html, ...(config.conformance.preset === 'strict' ? {} : sourceChangeFields(html)) };
}
/** Submit exactly the closed private source command. */
async function command(id, sourceIds, action = 'apply', stale = null) {
    const page = stale || await displayed(id);
    const response = await fetch(`${config.internalBaseUrls.pcmUi}/admin/consents/${id}/sandbox-sources`, { method: 'POST', headers,
        body: JSON.stringify({ action, sourceIds, expectedVersion: page.expectedVersion, csrf: page.csrf }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, json: await response.json() };
}
/** Compare every policy field, excluding only discovery projections and permitted source/audit/server fields. */
function policy(consent) {
    const copy = structuredClone(consent);
    delete copy.discoveredEndpoint; delete copy.discoveredEndpoints;
    delete copy.meta.versionId; delete copy.meta.lastUpdated;
    copy.provision.actor = copy.provision.actor.filter(actor => !actor.role.coding.some(code => code.code === 'CST'));
    return copy;
}
async function main() {
    const scenarios = [], journeys = [];
    const pass = id => scenarios.push({ id: `demo-sources-${id}`, status: 'pass', executed: true });
    const binding = config.serviceCatalog.bindings.find(item => item.application === 'doctor' && item.serviceKey === 'lab-follow-up');
    if (config.conformance.preset === 'strict') {
        const automatic = await client.createConsentRequest('http://fhir.health.gov.il/identifier/il-hdp-test-id|1', binding.instanceId, 'hospital-a');
        const page = await displayed(automatic.id); assert.ok(!page.html.includes('data-source-change action='));
        assert.equal((await command(automatic.id, [], 'apply', { expectedVersion: automatic.meta.versionId, csrf: 'forged' })).status, 403);
        pass('strict-command-denied');
    } else {
        for (const broadChoice of [false, true]) {
            assert.equal((await save()).status, 200);
            const pending = await client.createConsentRequest('http://fhir.health.gov.il/identifier/il-national-id|000000018', binding.instanceId, 'hospital-a');
            assert.equal(pending.status, 'proposed');
            const v = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
            const customScope = ['Patient', 'Observation', 'DiagnosticReport'].map(type => `patient/${type}.rs?${v}`).join(' ');
            const consent = await approvePending(pending, { sourceIds: [ids[0]],
                scopeChoice: broadChoice ? 'custom' : 'service-provided', ...(broadChoice ? { customScope } : {}) });
            const original = policy(consent), scope = requestCeiling(consent);
            const a = await issue(consent, scope); assert.equal(a.status, 200);
            assert.equal(a.json.scope, savedApproval(consent).scope);
            const activeA = await introspect(a.json.access_token); assert.equal(activeA.json.active, true);
            assert.equal(activeA.json.scope, a.json.scope); assert.deepEqual(activeA.json.authorization_details, a.json.authorization_details);
            const expected = source => {
                if (!broadChoice) return laboratoryFixture(source, savedApproval(consent).scope).allowed.map(record => record.id).sort();
                assert.equal(savedApproval(consent).scope, customScope);
                const bundle = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname, `../ci/${source}.source.transaction.json`)));
                return bundle.entry.map(item => item.resource).filter(record => record.resourceType === 'Observation'
                    && record.subject?.reference === `Patient/patient-${source}-0001`
                    && !record.meta.security.some(label => label.system === 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality' && label.code === 'V'))
                    .map(record => record.id).sort();
            };
            const observedA = await request(`${config.healthOrganizations[0].endpoint}/Observation?_count=10`, { bearer: a.json.access_token });
            assert.equal(observedA.status, 200); assert.deepEqual(observedA.json.entry.map(item => item.resource.id).sort(), expected('ho-a'));
            const stale = await displayed(consent.id);
            assert.ok(stale.html.includes('Test a source-list change'));
            assert.ok(stale.html.includes('Saving changes does not record a new patient approval'));
            const preview = await command(consent.id, ids.slice(0, 2), 'preview', stale); assert.equal(preview.status, 200); assert.deepEqual(preview.json.added, [ids[1]]);
            assert.equal((await command(consent.id, ids.slice(0, 2))).status, 200);
            assert.equal((await command(consent.id, [], 'apply', stale)).status, 409);
            assert.equal((await introspect(a.json.access_token, 1)).json.active, false);
            const b = await issue(consent, scope, 1); assert.equal(b.status, 200);
            assert.equal((await introspect(b.json.access_token, 1)).json.active, true);
            const observedB = await request(`${config.healthOrganizations[1].endpoint}/Observation?_count=10`, { bearer: b.json.access_token });
            assert.equal(observedB.status, 200); assert.deepEqual(observedB.json.entry.map(item => item.resource.id).sort(), expected('ho-b'));
            assert.equal((await command(consent.id, [ids[1]])).status, 200);
            assert.equal((await introspect(a.json.access_token)).json.active, false);
            assert.notEqual((await issue(consent, scope)).status, 200);
            // Adapter and native policy may retain the previous positive decision for at most 30 seconds.
            await new Promise(resolve => setTimeout(resolve, 31000));
            const removedSource = await request(`${config.healthOrganizations[0].endpoint}/Observation?_count=10`, { bearer: a.json.access_token });
            assert.ok(removedSource.status >= 400);
            // Production tokens also expire within 30s; separately prove empty-source revocation with a fresh live B token.
            const liveB = await issue(consent, scope, 1); assert.equal(liveB.status, 200); assert.equal((await introspect(liveB.json.access_token, 1)).json.active, true);
            assert.equal((await command(consent.id, [])).status, 200);
            assert.equal((await introspect(liveB.json.access_token, 1)).json.active, false);
            assert.equal((await introspect(b.json.access_token, 1)).json.active, false);
            assert.notEqual((await issue(consent, scope, 1)).status, 200);
            const refreshed = await client.checkConsentStatus(consent.id, 'hospital-a'); assert.deepEqual(refreshed.discoveredEndpoints, []); assert.deepEqual(policy(refreshed), original);
            const empty = await displayed(consent.id); assert.ok(empty.html.includes('No data sources are currently recorded for this consent.'));
            const noop = await command(consent.id, []); assert.equal(noop.json.state, 'unchanged');
            journeys.push({ approvalChoice: broadChoice ? 'explicit-manual-V-only' : 'service-provided', consentId: consent.id, scope: a.json.scope, issuedLifetimeSeconds: a.json.expires_in, sourceA: expected('ho-a'), sourceB: expected('ho-b'), freshRemovedSourceIntrospection: false, removedSourceAfter31Seconds: removedSource.status, freshLiveTokenAfterEmpty: false, preservedPolicy: true, finalVersion: refreshed.meta.versionId });
            pass(broadChoice ? 'explicit-broad-a-add-b-remove-a-empty' : 'ordinary-a-add-b-remove-a-empty');
        }
        // Restore only the named transport profile; source/approval/window state is preserved.
        assert.equal((await save()).status, 200);
    }
    const output = { preset: config.conformance.preset, status: 'pass', nativeFiltersDuringGrantProof: true, maximumPositiveCacheSeconds: 30, journeys, scenarios };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
}
main().catch(error => { console.error({ message: error.message, stack: error.stack, status: error.response?.status }); process.exitCode = 1; });
