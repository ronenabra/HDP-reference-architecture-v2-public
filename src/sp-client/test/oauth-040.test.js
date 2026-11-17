'use strict';

/** Doctor produces authentication-only JWTs and encodes authoritative Consent RAR once. */
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { consentAuthorizationDetails } = require('../../shared/data-authorization-details');
const { buildTokenForm, createClientAssertion, validateTokenResponse } = require('../src/oauth');
const { dataGrantFixture } = require('../../../test-support/data-grants');
const { resolveGrant } = require('../../pcm-core/src/data-grant');

test('Doctor sends business-identifier RAR separately from a fresh authentication-only assertion', () => {
    const f = dataGrantFixture();
    const privateKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const args = { privateKey, clientId: f.client.clientId, audience: `${f.config.contract.operational.fhirBase}/token` };
    const assertion = createClientAssertion(args);
    assert.deepEqual(Object.keys(jwt.decode(assertion)).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    assert.notEqual(jwt.decode(assertion).jti, jwt.decode(createClientAssertion(args)).jti);
    assert.throws(() => createClientAssertion({ ...args, b2b: {} }), /Legacy/);
    // The lifecycle owns the generated business value; RAR must retain its normative namespace, not the logical ID.
    const identifiers = f.consent.identifier.filter(item => item.system === 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id');
    assert.equal(identifiers.length, 1);
    assert.equal(typeof identifiers[0].value, 'string');
    assert.ok(identifiers[0].value);
    assert.notEqual(identifiers[0].value, f.consent.id);
    const expectedDetails = [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access',
        fhirContext: [{ type: 'Consent', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis',
            identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: identifiers[0].value } }] }];
    const details = consentAuthorizationDetails(f.consent);
    assert.deepEqual(details, expectedDetails);
    const form = buildTokenForm({ assertion, scope: f.request.scope, resource: f.source.endpoint, authorizationDetails: details });
    const serialized = new URLSearchParams(form.toString());
    assert.equal(serialized.get('scope'), f.request.scope);
    assert.equal(serialized.get('authorization_details'), JSON.stringify(expectedDetails));
    assert.deepEqual(JSON.parse(serialized.get('authorization_details')), expectedDetails);
    assert.throws(() => consentAuthorizationDetails({ id: f.consent.id }), /business identifier/);
    assert.throws(() => buildTokenForm({ assertion, scope: 'system/*.crus', resource: f.source.endpoint, authorizationDetails: details }), /prohibited/);
});

test('Doctor validates enriched responses and the selected environment lifetime ceiling', () => {
    const f = dataGrantFixture();
    const grant = resolveGrant(f.request);
    const response = { access_token: 'opaque', token_type: 'Bearer', expires_in: 86400, scope: grant.scope, authorization_details: grant.authorization_details };
    assert.equal(validateTokenResponse(response), response);
    assert.throws(() => validateTokenResponse(response, { maximumLifetime: 30 }));
    assert.throws(() => validateTokenResponse({ ...response, authorization_details: [] }));
    assert.throws(() => validateTokenResponse({ ...response, patient: '1' }));
});
