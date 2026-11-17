'use strict';
/** Exact consumer assertions distinguish legacy capability refusal from failed authentication. */
const assert = require('node:assert/strict');

/** A current, valid own-source presence request reaches the legacy capability refusal. */
function assertLegacyCapability(result) {
    assert.equal(result.status, 403, 'valid legacy presence must reach explicit unsupported capability');
    assert.deepEqual(result.body, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported', diagnostics:
        'Legacy Node clinical access is unavailable: this source cannot enforce approved SMART predicates. Select a qualified native HAPI source.' }] });
}

/** Neither anonymous nor foreign-source requests gain clinical data from transport simulations. */
function assertAnonymousDenied(result, label) {
    assert.ok([401, 403].includes(result.status), `${label}: clinical request must deny (${result.status})`);
    if (result.body?.resourceType) assert.equal(result.body.resourceType, 'OperationOutcome', 'authorization denial cannot contain a clinical FHIR resource');
    assert.equal(result.text.includes('Synthetic HTEST'), false);
}
module.exports = { assertLegacyCapability, assertAnonymousDenied };
