'use strict';

/** Private normalization/cache boundaries cannot resurrect pre-enforcement authority. */
const test = require('node:test'), assert = require('node:assert/strict');
const { NORMALIZED_SCHEMA, validateIntrospectionResponse } = require('../src/introspection-contract');
const { ActiveIntrospectionCache } = require('../src/authorization-cache');
const { simulationStage } = require('../src/index');
const { simulationPolicyStamp, buildEffectivePolicy } = require('../../shared/conformance-policy');
const { buildTeamConfig } = require('../../../test-support/team-config');

test('normalization always rejects wrong audience, expiry, missing scope and context despite obsolete direct controls', () => {
    const fixture = require('../../../test-support/clinical-token-fixture').clinicalTokenFixture();
    const grant = require('../../pcm-core/src/data-grant').resolveGrant(fixture.request), now = fixture.request.now;
    const response = { active: true, scope: grant.scope, client_id: fixture.client.clientId, sub: fixture.client.clientId,
        iss: fixture.config.contract.operational.oauthBase, aud: fixture.source.endpoint, iat: now, exp: now + 30,
        organization_id: `${grant.requesterIdentifier.system}#${grant.requesterIdentifier.value}`,
        authorization_details: grant.authorization_details,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true } };
    const options = { expectedIssuer: response.iss, expectedAudience: response.aud, hoId: 'ho-a', clock: () => now,
        controls: { oauthBearer: false, tokenAudience: false, tokenExpiry: false, resultFiltering: false } };
    assert.equal(validateIntrospectionResponse(response, options).grant.scope, grant.scope);
    for (const patch of [{ aud: fixture.config.healthOrganizations[1].endpoint }, { exp: now }, { iat: now + 1 }, { scope: '' }, { authorization_details: [] }]) {
        assert.throws(() => validateIntrospectionResponse({ ...response, ...patch }, options));
    }
    assert.equal(simulationStage(options.controls), 'enforced');
});

test('cache schema and source policy stamp reject old entries and tightening cannot reuse a warm result', () => {
    const now = 2000000000000, cache = new ActiveIntrospectionCache({ clock: () => now });
    const config = buildTeamConfig(), policy = buildEffectivePolicy(config, {});
    const binding = { hoId: 'ho-a', expectedAudience: config.healthOrganizations[0].endpoint,
        policyStamp: simulationPolicyStamp(policy.simulation.controls, 'ho-a', 0) };
    const context = { active: true, schema: NORMALIZED_SCHEMA, hoId: 'ho-a', token: { audience: binding.expectedAudience, expiresAt: now / 1000 + 30 } };
    assert.equal(cache.put('owned', binding, { ...context, schema: 'pcm-ds-authorization-context/3' }), false);
    assert.equal(cache.put('owned', binding, context), true);
    assert.equal(cache.get('owned', binding), context);
    const tighter = { ...binding, policyStamp: simulationPolicyStamp(policy.simulation.controls, 'ho-a', 1) };
    assert.equal(cache.get('owned', tighter), null);
    assert.equal(cache.get('owned', { ...binding, hoId: 'ho-b' }), null);
});
