'use strict';
/** Consumer boundaries for candidate 0.4.2: person login, synthetic fixtures and source budgets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { dataGrantFixture, NOW, rar } = require('../../../test-support/data-grants');
const { SystemFlowStore } = require('../src/system-flow-store');
const { SystemWorkflows, joinDependents } = require('../src/system-workflows');
const { resolveGrant } = require('../src/data-grant');
const { LocalTrustedSsoProvider, BrowserAuthenticatedIdentityProvider } = require('../src/sandbox-identity-provider');
const ID = 'http://fhir.health.gov.il/identifier/pna-national-id';
const binding = 'private-test-browser-binding-04107';

/** Fresh private flow store with deterministic provider deadlines. */
function fixture(identifier, facts) {
    const h = dataGrantFixture();
    let now = NOW;
    if (identifier) h.config.systemAuthorization.memberships = [{ identifier, homeHmoId: h.source.id, ...(facts ? { loginEligibility: facts } : {}) }];
    const flows = new SystemFlowStore(h.config, { clock: () => now });
    const workflow = new SystemWorkflows({ config: h.config, flows, clock: () => now });
    return { ...h, flows, workflow, advance: seconds => { now += seconds; } };
}

for (const [identifier, facts, allowed] of [
    [{ system: ID, value: '000123' }, undefined, true],
    [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }, undefined, true],
    [{ system: 'http://hl7.org/fhir/sid/passport-USA', value: 'FIXTURE' }, { foreignPassportEligible: true, israeliNationalWithId: false }, true],
    [{ system: 'http://hl7.org/fhir/sid/passport-USA', value: 'FIXTURE' }, undefined, false],
    [{ system: 'http://hl7.org/fhir/sid/passport-USA', value: 'FIXTURE' }, { foreignPassportEligible: true, israeliNationalWithId: true }, false],
    [{ system: 'http://hl7.org/fhir/sid/passport-ISR', value: 'FIXTURE' }, { foreignPassportEligible: true, israeliNationalWithId: false }, false],
    [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }, undefined, false]
]) test(`person login eligibility ${identifier.system.split('/').at(-1)} ${JSON.stringify(facts)} => ${allowed}`, () => {
    const h = fixture(identifier, facts);
    const begin = () => h.flows.begin({ identifier, homeHmoId: h.source.dataSourceOrganization.id, birthDate: '1980-01-02', browserBinding: binding,
        foreignPassportEligible: true, syntheticFixture: true });
    if (allowed) assert.ok(begin()); else assert.throws(begin);
    assert.throws(() => h.flows.begin({ identifier, birthDate: '1980-01-02', browserBinding: binding, homeHmoId: 'ho-c' }));
});

test('trusted SSO result is one-use, private, fresh, browser/client-bound and skips OTP', () => {
    const h = fixture();
    const member = h.config.systemAuthorization.memberships[0];
    member.localSso = { birthDate: '1980-01-02', name: [{ text: 'Fabricated SSO' }] };
    const provider = h.workflow.identityProvider, client = h.config.oauthClients.discoveryOrchestrator.clientId;
    assert.throws(() => h.workflow.acceptSso({}, binding));
    for (const denial of ['browser', 'client', 'expired', 'future']) {
        const result = provider.issue('local-sso-0', binding, client);
        if (denial === 'expired') h.advance(60);
        if (denial === 'future') h.advance(-1);
        assert.throws(() => provider.consume(result, denial === 'browser' ? 'other-browser' : binding, denial === 'client' ? 'other-client' : client));
    }
    const result = provider.issue('local-sso-0', binding, client);
    const accepted = h.workflow.acceptSso(result, binding);
    assert.equal(accepted.status, 'authenticated');
    assert.equal(h.workflow.transport.deliveries.size, 0);
    assert.equal(h.flows.invocation(accepted.flowId, client).phase, 'authenticated');
    assert.equal(h.flows.invocation(accepted.flowId, 'other-client'), null);
    assert.throws(() => h.workflow.acceptSso(result, binding));
    assert.throws(() => h.workflow.verify(accepted.flowId, binding, '123456'));
});

for (const value of ['1', '2']) test(`HTEST ${value} requires explicit private fixture enrollment and cannot resolve Consent self`, async () => {
    const identifier = { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value };
    const h = fixture(identifier);
    const member = h.config.systemAuthorization.memberships[0];
    member.fixtureBirthDate = '1980-01-02';
    await assert.rejects(h.workflow.authenticateFixture(value, binding));
    member.sandboxFixture = true;
    assert.throws(() => h.flows.begin({ identifier, birthDate: member.fixtureBirthDate, browserBinding: binding }));
    const id = h.flows.begin({ identifier, birthDate: member.fixtureBirthDate, browserBinding: binding }, { syntheticFixture: true });
    const authClient = h.config.oauthClients.authenticationOrchestrator;
    const invocation = h.flows.invocation(id, authClient.clientId);
    const options = { ...h.request, client: { clientId: authClient.clientId, role: 'system', organizationId: authClient.organizationId },
        requested: rar('Contract', 'PCM-POLICY-PATIENT-AUTHENTICATION-001', [identifier]), scope: 'patient/Patient.s', invocation };
    assert.equal(resolveGrant(options).scenario, 'patient-authentication');
    assert.throws(() => resolveGrant({ ...options, invocation: null }));
    h.flows.flows.get(id).phase = 'authenticated';
    const provider = new BrowserAuthenticatedIdentityProvider([], h.flows);
    const req = { headers: { cookie: `pcmSystemFlow=${id}; pcmSystemBrowser=${binding}` } };
    assert.equal(provider.resolve('authenticated-self', req), null);
    const child = { resourceType: 'Patient', id: 'child', identifier: [identifier] };
    const rp = { resourceType: 'RelatedPerson', id: 'rp', active: true, identifier: [identifier], patient: { reference: 'Patient/child' }, relationship: [{ coding: [{ system: 'urn:test', code: 'parent' }] }] };
    assert.equal(joinDependents([child], [rp], identifier, [{ system: 'urn:test', code: 'parent' }], h.source.endpoint).length, 0);
    assert.equal(joinDependents([child], [rp], identifier, [{ system: 'urn:test', code: 'parent' }], h.source.endpoint, { syntheticFixture: true }).length, 1);
});

test('real presence orchestration chunks 105 patients per source and isolates failed entries/source/EULA', async () => {
    const h = fixture();
    const patients = Array.from({ length: 105 }, (_, i) => ({ system: ID, value: String(i + 1) }));
    h.config.legacyDataSource.enabled = false;
    h.config.systemAuthorization.presenceEligiblePatients = patients;
    h.config.presence.sources = { 'ho-a': { maxPatients: 105, maxPayloadBytes: 262144 }, 'ho-b': { maxPatients: 40 }, 'ho-c': { maxPatients: 20 } };
    const batches = [];
    h.workflow.request = async (source, operation) => {
        batches.push([source.healthOrganizationId, operation.patients.length]);
        assert.equal(operation.body.entry.length, operation.patients.length);
        if (source.healthOrganizationId === 'ho-c') throw new Error('unavailable source');
        return { resourceType: 'Bundle', type: 'batch-response', entry: operation.patients.map(patient => ({ response: { status: patient.value === '3' ? '500' : '200' }, resource: { resourceType: 'Bundle', type: 'searchset', total: patient.value === '1' ? 1 : 0 } })) };
    };
    const result = await h.workflow.presence(patients);
    assert.deepEqual(batches.filter(item => item[0] === 'ho-a').map(item => item[1]), [105]);
    assert.deepEqual(batches.filter(item => item[0] === 'ho-b').map(item => item[1]), [40, 40, 25]);
    assert.equal(result.results.length, 315);
    assert.equal(result.results.filter(item => item.state === 'unknown').length, 107);
    h.config.systemAuthorization.presenceEligiblePatients = patients.slice(0, 104);
    batches.length = 0;
    const dependent = await h.workflow.presence(patients);
    assert.ok(dependent.results.filter(item => item.identifier.value === '105').every(item => item.reason === 'patient-source-list-not-eligible' && item.state === 'unknown'));
    assert.ok(batches.every(item => item[1] <= 104));
});

test('conflicting dependent identities fail the whole source and repeated exact identifiers remain one identity', () => {
    const h = fixture();
    const representative = h.strongPatient, identity = { system: ID, value: 'dependent' };
    const patient = { resourceType: 'Patient', id: 'child', identifier: [identity, identity] };
    const related = { resourceType: 'RelatedPerson', id: 'rp', identifier: [representative], active: true, relationship: [{ coding: [{ system: 'urn:test', code: 'parent' }] }], patient: { reference: 'Patient/child' } };
    const join = () => joinDependents([patient], [related], representative, [{ system: 'urn:test', code: 'parent' }], h.source.endpoint);
    assert.equal(join().length, 1);
    patient.identifier.push({ system: ID, value: 'conflict' });
    assert.throws(join);
});

test('presence payload budgets split source batches and one source deadline bounds every chunk', async () => {
    const h = fixture();
    h.config.legacyDataSource.enabled = false;
    const patients = Array.from({ length: 5 }, (_, i) => ({ system: ID, value: String(i) }));
    h.config.systemAuthorization.presenceEligiblePatients = patients;
    h.config.presence.sources = { 'ho-a': { maxPatients: 5, maxPayloadBytes: 500 } };
    const calls = [];
    h.workflow.request = async (source, operation) => {
        calls.push({ source: source.healthOrganizationId, patients: operation.patients, deadline: operation.deadlineMilliseconds });
        const response = { resourceType: 'Bundle', type: 'searchset', total: 0 };
        if (source.healthOrganizationId === 'ho-a') h.advance(5);
        return operation.method === 'GET' ? response : { resourceType: 'Bundle', type: 'batch-response', entry: operation.patients.map(() => ({ response: { status: '200' }, resource: response })) };
    };
    const result = await h.workflow.presence(patients);
    assert.equal(calls.filter(value => value.source === 'ho-a').length, 1, 'expired source issues no later chunk');
    assert.ok(calls.find(value => value.source === 'ho-a').patients.length < 5, 'payload budget chunks before dispatch');
    assert.ok(result.results.filter(value => value.sourceId === h.config.healthOrganizations[0].dataSourceOrganization.id).every(value => value.state === 'unknown'));
    assert.ok(result.results.filter(value => value.sourceId === h.config.healthOrganizations[1].dataSourceOrganization.id).every(value => value.state === 'absent'));
});

test('explicit discovery totals detect missing terminal pages and retain unknown instead of complete', async () => {
    const h = fixture();
    h.config.systemAuthorization.memberships[0].localSso = { birthDate: '1980-01-02' };
    const started = h.workflow.authenticateSso('local-sso-0', binding);
    h.workflow.request = async () => ({ resourceType: 'Bundle', type: 'batch-response', entry: [
        { response: { status: '200' }, resource: { resourceType: 'Bundle', type: 'searchset', total: 2, entry: [] } },
        { response: { status: '200' }, resource: { resourceType: 'Bundle', type: 'searchset', entry: [] } }
    ] });
    const result = await h.workflow.discover(started.flowId, binding);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.dependents, []);
});
