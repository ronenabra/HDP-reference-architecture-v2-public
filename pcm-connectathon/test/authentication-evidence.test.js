'use strict';
/** The local exception cannot invent observation or survive tighter source policy. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { VERSION, TRANSPORT, SIGNATURE, normalizeAuthenticationEvidence: normalize, normalizePrivateAuthentication, simulationOptions } = require('../../src/shared/authentication-evidence');
const strict = { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true };
const allow = { allowSimulation: true, allowMissingTransport: true, controls: { clientAssertionSignature: false } };
for (const skipped of [[TRANSPORT], [SIGNATURE], [TRANSPORT, SIGNATURE]]) {
    test(`skipped ${skipped.join(',')} requires exactly matching current controls`, () => {
        const evidence = { ...strict, correlation_verified: false, simulation: { version: VERSION, skipped },
            ...(skipped.includes(TRANSPORT) ? { token_endpoint_mtls: null } : {}),
            ...(skipped.includes(SIGNATURE) ? { client_assertion_signing: null } : {}) };
        const normalized = normalize(evidence, allow);
        assert.equal(normalized.correlationVerified, false);
        assert.deepEqual(normalizePrivateAuthentication(normalized, allow), normalized);
        assert.throws(() => normalize(evidence));
        for (const changed of [{ allowSimulation: false }, ...(skipped.includes(TRANSPORT) ? [{ allowMissingTransport: false }] : []),
            ...(skipped.includes(SIGNATURE) ? [{ controls: { clientAssertionSignature: true } }] : [])]) assert.throws(() => normalize(evidence, { ...allow, ...changed }));
        for (const changed of [{ extra: true }, { correlation_verified: true },
            { simulation: { version: VERSION, skipped: [] } }, { simulation: { version: VERSION, skipped: ['invented'] } },
            { simulation: { version: VERSION, skipped: [TRANSPORT, TRANSPORT] } }, { simulation: { version: 'old', skipped } },
            ...(skipped.includes(TRANSPORT) ? [{ token_endpoint_mtls: strict.token_endpoint_mtls }] : []),
            ...(skipped.includes(SIGNATURE) ? [{ client_assertion_signing: strict.client_assertion_signing }] : [])]) assert.throws(() => normalize({ ...evidence, ...changed }, allow));
    });
}
test('verified evidence stays closed and permits no simulation metadata', () => {
    assert.equal(normalize(strict).correlationVerified, true);
    assert.throws(() => normalize({ ...strict, simulation: { version: VERSION, skipped: [] } }, allow));
    assert.throws(() => normalize({ ...strict, token_endpoint_mtls: null }));
    assert.equal(simulationOptions({ mode: 'strict', transport: { pcmPublic: { clientAuth: 'mtls' } } }).allowSimulation, false);
});
