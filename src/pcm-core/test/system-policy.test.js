'use strict';

/** Contract validity, authorization visibility and search boundary regression tests. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { FHIRStore } = require('../src/fhir/store');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { executeSearch } = require('../src/fhir/search');
const { provisionSystemPolicies, validatePolicy, evaluatePolicy, canReadPolicy, transitionPolicy, resolveIdentifier, timestamp } = require('../src/fhir/system-policy');
const NOW = 2_000_000_000;

/** Build an isolated store with explicit active source hierarchy and entitlement. */
function fixture() {
    const config = buildTeamConfig();
    config.systemAuthorization.participatingHmos = [config.healthOrganizations[0].id];
    const store = new FHIRStore();
    for (const resource of require('../src/bootstrap').buildSeedResources(config)) store.add(resource);
    const ho = config.healthOrganizations[0];
    require('../src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    provisionSystemPolicies(store, config, NOW);
    const policy = store.get('Contract', 'policy-presence');
    const request = { store, config, identifier: policy.identifier[0], clientId: config.oauthClients.presenceOrchestrator.clientId, targetOrganizationId: ho.dataSourceOrganization.id, now: NOW };
    return { store, config, policy, request };
}

test('provisioning preserves stable identifiers and never reactivates terminal policies', () => {
    const { store, config, policy } = fixture();
    assert.equal(store.getAll('Contract').length, 3);
    assert.equal(store.getAll('HealthcareService').filter(service => require('../src/fhir/system-policy').isSystemService(service)).length, 0);
    for (const contract of store.getAll('Contract')) assert.ok(validatePolicy(store, contract, config.organizations.pcm.id));
    transitionPolicy(store, policy.id, 'revoked', config);
    provisionSystemPolicies(store, config, NOW + 100);
    assert.equal(store.get('Contract', policy.id).status, 'revoked');
    assert.throws(() => transitionPolicy(store, policy.id, 'policy', config), /terminal/);
});

test('policy evaluation requires explicit entitlement, source membership and inclusive validity', () => {
    const { store, policy, request } = fixture();
    assert.ok(evaluatePolicy(request));
    assert.equal(evaluatePolicy({ ...request, now: NOW - 1 }), null);
    assert.ok(evaluatePolicy({ ...request, now: timestamp(policy.applies.end) }));
    assert.equal(evaluatePolicy({ ...request, now: timestamp(policy.applies.end) + 0.001 }), null);
    assert.equal(evaluatePolicy({ ...request, clientId: 'unregistered' }), null);
    store.add({ ...policy, status: 'draft' });
    assert.equal(evaluatePolicy(request), null);
});

test('HMO policies use institution classification and scenario-specific entitlement independently of old participation lists', () => {
    const { store, config, request } = fixture();
    const policy = store.get('Contract', 'policy-patient-authentication');
    const authentication = { ...request, identifier: policy.identifier[0], clientId: config.oauthClients.authenticationOrchestrator.clientId };
    config.systemAuthorization.participatingHmos = [];
    assert.ok(evaluatePolicy(authentication));
    config.healthOrganizations[0].institutionType = 'hospital';
    assert.equal(evaluatePolicy(authentication), null);
    config.healthOrganizations[0].institutionType = 'hmo';
    assert.ok(evaluatePolicy(authentication));
    assert.equal(evaluatePolicy({ ...authentication, clientId: request.clientId }), null);
});

test('unknown and duplicate business identifiers fail closed; malformed ownership and timestamps fail', () => {
    const { store, config, policy, request } = fixture();
    assert.equal(resolveIdentifier(store, 'Contract', { system: policy.identifier[0].system, value: policy.id }), null);
    store.add({ ...policy, id: 'duplicate' });
    assert.equal(evaluatePolicy(request), null);
    for (const invalid of ['2026-01-01', '2026-02-30T01:00:00Z', 'invalid']) assert.throws(() => timestamp(invalid));
    for (const change of [{ author: { reference: 'Organization/other' } }, { applies: { start: policy.applies.end, end: policy.applies.start } }, { subType: [] }]) {
        assert.throws(() => validatePolicy(store, { ...policy, ...change }, config.organizations.pcm.id));
    }
});

test('inactive policy visibility does not permit minting and search paging remains caller-bound', () => {
    const { store, config, policy, request } = fixture();
    transitionPolicy(store, policy.id, 'revoked', config);
    const caller = { client_id: request.clientId };
    assert.ok(canReadPolicy(store, config, policy, caller));
    assert.equal(evaluatePolicy(request), null);
    assert.equal(canReadPolicy(store, config, policy, { client_id: 'other' }), false);
    const search = { store, type: 'Contract', raw: { _count: '1' }, authorize: () => true, baseUrl: config.contract.operational.fhirBase, callerKey: 'admin' };
    const first = executeSearch(search);
    assert.equal(first.entry.length, 1);
    assert.ok(first.entry[0].fullUrl.startsWith(config.contract.operational.fhirBase));
    const raw = Object.fromEntries(new URL(first.link.find(link => link.relation === 'next').url).searchParams);
    assert.throws(() => executeSearch({ ...search, raw, callerKey: 'other' }), /caller or query/);
    assert.equal(executeSearch({ ...search, raw, authorize: () => false }).entry.length, 0);
    for (const value of ['0', '101', '1.5', ['1', '2']]) assert.throws(() => executeSearch({ ...search, raw: { _count: value } }));
    assert.throws(() => executeSearch({ ...search, raw: { _include: 'Contract:author' } }), /Unsupported include/);
});
