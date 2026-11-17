'use strict';
/** The release assertion must catch missing, extra and mismatched workflow membership. */
const test = require('node:test'), assert = require('node:assert/strict');
const { dataGrantFixture } = require('../../test-support/data-grants');
const { assertWorkflowProjection } = require('./workflow-contract-projection');

/** Use actual provisioned Contracts, including the separate sandbox sampling pair. */
function fixture() { const f = dataGrantFixture(); return { ...f, contracts: f.store.getAll('Contract') }; }

test('ordinary HMO membership includes all three exact policies without enrollment facts', () => {
    const f = fixture(); f.config.systemAuthorization.memberships = []; f.config.systemAuthorization.participatingHmos = [];
    assert.deepEqual(assertWorkflowProjection(f.contracts, f.source, f.config), ['presence-check', 'patient-authentication', 'dependent-discovery']);
    for (const mutate of [rows => rows.filter(r => r.id !== 'policy-dependent-discovery'), rows => rows.concat(rows.find(r => r.id === 'policy-presence')),
        rows => rows.map(r => r.id === 'policy-patient-authentication' ? { ...r, identifier: [{ system: r.identifier[0].system, value: 'wrong-business-id' }] } : r),
        rows => rows.map(r => r.id === 'policy-presence' ? { ...r, status: 'revoked' } : r)]) {
        assert.throws(() => assertWorkflowProjection(mutate(structuredClone(f.contracts)), f.source, f.config));
    }
});
for (const institutionType of ['hospital', 'other']) test(`${institutionType} visibility excludes HMO-only policy membership`, () => {
    const f = fixture(), source = { ...f.source, institutionType };
    assert.deepEqual(assertWorkflowProjection(f.contracts.filter(r => r.id === 'policy-presence'), source, f.config), ['presence-check']);
    assert.throws(() => assertWorkflowProjection(f.contracts, source, f.config));
});
