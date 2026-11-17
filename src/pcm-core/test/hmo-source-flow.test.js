'use strict';

/** Source-driven HMO identity, current authority and bounded private Contract maintenance. */
const test = require('node:test'), assert = require('node:assert/strict');
const { dataGrantFixture, NOW, rar } = require('../../../test-support/data-grants');
const { SystemFlowStore } = require('../src/system-flow-store');
const { SystemWorkflows, CONTACT_EVIDENCE, OTP_PURPOSE, PURPOSE_SYSTEM } = require('../src/system-workflows');
const { hmoSources, resolveHmoSource } = require('../src/hmo-sources');
const { workflowSourcePlan } = require('../src/workflow-source-configuration');
const { resolveGrant } = require('../src/data-grant');
const { updatePolicy } = require('../src/fhir/system-policy');
const binding = 'owned-hmo-browser-binding-at-least-32-bytes';

/** Ordinary FHIR identity/contact data; no membership, enrollment or sidecar setup. */
function fixture() {
    const f = dataGrantFixture(); f.config.systemAuthorization.memberships = []; f.config.systemAuthorization.participatingHmos = [];
    const flows = new SystemFlowStore(f.config, { store: f.store, clock: () => NOW });
    const calls = [];
    const patient = { resourceType: 'Patient', id: 'owned-patient', identifier: [f.strongPatient], birthDate: '1980-01-02', telecom: [{ system: 'sms', value: '+972500000000', extension: [
        { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
        { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(NOW * 1000).toISOString() }] }
    ] }] };
    const workflow = new SystemWorkflows({ config: f.config, store: f.store, flows, clock: () => NOW, codeGenerator: () => '123456', request: async (source, operation) => {
        calls.push({ sourceId: source.id, operation });
        return { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: patient }] };
    } });
    return { ...f, flows, workflow, calls, patient, input: { browserBinding: binding, identifier: f.strongPatient, birthDate: patient.birthDate, homeHmoId: f.source.dataSourceOrganization.id } };
}

test('empty enrollment lists authenticate only the declared operational HMO; Patient alone still does not suffice', async () => {
    const f = fixture();
    const started = await f.workflow.authenticate(f.input);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].sourceId, f.input.homeHmoId);
    assert.equal(f.workflow.verify(started.flowId, binding, '123456').status, 'authenticated');
    for (const change of [f => { f.patient.telecom = []; }, f => { f.patient.birthDate = '1981-01-02'; }, f => { f.input.homeHmoId = 'https://caller.example/fhir'; },
        f => { f.config.healthOrganizations[0].institutionType = 'hospital'; }, f => { f.store.update({ ...f.store.get('Endpoint', f.source.endpointId), status: 'off' }); }]) {
        const failed = fixture(); change(failed); await assert.rejects(failed.workflow.authenticate(failed.input)); assert.equal(failed.workflow.transport.deliveries.size, 0);
    }
});

test('selected-source classification change during lookup prevents late OTP and invalidates private invocation', async () => {
    const f = fixture(); let release;
    f.workflow.request = async () => new Promise(resolve => { release = resolve; });
    const pending = f.workflow.authenticate(f.input);
    await Promise.resolve();
    f.config.healthOrganizations[0].institutionType = 'other';
    release({ resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: f.patient }] });
    await assert.rejects(pending); assert.equal(f.workflow.transport.deliveries.size, 0); assert.equal(f.flows.flows.size, 0);
});

test('Contract source maintenance preserves validity and identity, refuses expired or terminal policy and respects clinical Hospitals', () => {
    const f = fixture(), before = f.store.get('Contract', 'policy-patient-authentication');
    f.config.healthOrganizations[1].institutionType = 'hospital';
    const plan = workflowSourcePlan(f.store, f.config, NOW);
    assert.equal(plan.updates.length, 2); assert.equal(plan.sources.length, 2);
    for (const updated of plan.updates) {
        const old = f.store.get('Contract', updated.id);
        assert.deepEqual(updated.identifier, old.identifier); assert.deepEqual(updated.applies, old.applies); assert.equal(updated.issued, old.issued);
        updatePolicy(f.store, updated, f.config);
    }
    assert.deepEqual(f.store.get('Contract', before.id).applies, before.applies);
    f.config.healthOrganizations[0].institutionType = 'hospital';
    assert.ok(resolveGrant(f.request), 'Hospital remains a clinical Consent source');
    f.store.update({ ...f.store.get('Contract', before.id), status: 'revoked' });
    assert.throws(() => workflowSourcePlan(f.store, f.config, NOW), /not currently executed/);
    const expired = fixture(); const current = expired.store.get('Contract', before.id);
    expired.store.update({ ...current, applies: { ...current.applies, end: new Date((NOW + 1) * 1000).toISOString() } });
    expired.config.healthOrganizations[1].institutionType = 'other';
    assert.throws(() => workflowSourcePlan(expired.store, expired.config, NOW + 2), /not currently executed/);
});

test('HMO source reclassification/removal and endpoint substitution invalidate earlier authority even after restoration', () => {
    const f = fixture(), clientId = f.config.oauthClients.authenticationOrchestrator.clientId;
    const options = { ...f.request, client: { clientId }, scope: 'patient/Patient.s', requested: rar('Contract', 'PCM-POLICY-PATIENT-AUTHENTICATION-001', [f.strongPatient]),
        invocation: { id: 'private', clientId, identifier: f.strongPatient, homeHmoId: f.input.homeHmoId, phase: 'authenticating', expiresAt: NOW + 30 } };
    const original = resolveGrant(options);
    f.config.healthOrganizations[0].institutionType = 'hospital'; f.store.authorityState.observeConfig(f.config);
    assert.throws(() => resolveGrant(options));
    f.config.healthOrganizations[0].institutionType = 'hmo';
    const current = resolveGrant(options);
    assert.equal(require('../src/grant-authority-state').authorityStillAllowed(original.authority, current.authority), false);
    assert.equal(hmoSources(f.config, f.store).length, 3);
    const flowId = f.flows.begin(f.input);
    const endpoint = f.store.get('Endpoint', f.source.endpointId);
    f.store.update({ ...endpoint, address: 'https://substituted.example.test/fhir' });
    assert.equal(resolveHmoSource(f.config, f.input.homeHmoId, { store: f.store }).endpoint, 'https://substituted.example.test/fhir');
    assert.equal(f.flows.invocation(flowId, clientId), null, 'existing private flow cannot follow a changed Endpoint');
});

test('non-operational other HMO is reported unknown without dispatch, rather than silently omitted or called empty', async () => {
    const f = fixture(), started = await f.workflow.authenticate(f.input);
    f.workflow.verify(started.flowId, binding, '123456');
    const unavailable = f.config.healthOrganizations[1];
    f.store.update({ ...f.store.get('Organization', unavailable.dataSourceOrganization.id), active: false });
    f.workflow.request = async () => ({ resourceType: 'Bundle', type: 'batch-response', entry: [
        { response: { status: '200' }, resource: { resourceType: 'Bundle', type: 'searchset', entry: [] } },
        { response: { status: '200' }, resource: { resourceType: 'Bundle', type: 'searchset', entry: [] } }
    ] });
    const result = await f.workflow.discover(started.flowId, binding);
    const outcome = result.sources.find(source => source.sourceId === unavailable.dataSourceOrganization.id);
    assert.equal(outcome.state, 'unknown'); assert.ok(outcome.checkedAt); assert.match(outcome.reason, /readiness/); assert.equal(result.status, 'partial');
    f.flows.cancel(started.flowId);
});

test('current owner-controlled Endpoint replacement is resolved without rewriting config or reviving inactive participants', () => {
    const f = fixture(); const endpoint = f.store.get('Endpoint', f.source.endpointId);
    f.store.add({ ...endpoint, id: 'owned-replacement', address: 'https://owned-replacement.example.test/fhir' });
    const organization = f.store.get('Organization', f.source.dataSourceOrganization.id);
    f.store.update({ ...organization, endpoint: [{ reference: 'Endpoint/owned-replacement' }] });
    const resolved = resolveHmoSource(f.config, organization.id, { store: f.store });
    assert.equal(resolved.endpointId, 'owned-replacement'); assert.equal(resolved.endpoint, 'https://owned-replacement.example.test/fhir');
    const originalConfig = structuredClone(f.config);
    f.store.update({ ...f.store.get('Organization', organization.id), active: false });
    require('../src/data-sources').syncDataSourcesToStore(f.store, f.config, null, { preserveExisting: true });
    assert.equal(f.store.get('Organization', organization.id).active, false);
    assert.deepEqual(f.store.get('Organization', organization.id).endpoint, [{ reference: 'Endpoint/owned-replacement' }]);
    assert.deepEqual(f.config, originalConfig);
});

test('unchanged expired or revoked source graph reports unavailable policy without reviving it', () => {
    const f = fixture(), contract = f.store.get('Contract', 'policy-patient-authentication');
    f.store.update({ ...contract, status: 'revoked' });
    const plan = workflowSourcePlan(f.store, f.config, NOW);
    assert.equal(plan.updates.length, 0); assert.deepEqual(plan.missingScenarios, []);
    assert.equal(plan.policies.find(policy => policy.id === contract.id).validNow, false);
    assert.equal(f.store.get('Contract', contract.id).status, 'revoked');
});
