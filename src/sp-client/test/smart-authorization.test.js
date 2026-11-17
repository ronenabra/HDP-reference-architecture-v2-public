'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    consumeAuthorizationCallback,
    createAuthorizationTransaction,
    validateSmartConfiguration
} = require('../src/smart-authorization');

test('SP-001 SMART discovery validates the required asymmetric PKCE capability set', () => {
    const metadata = {
        issuer: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4', authorization_endpoint: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4/authorize',
        token_endpoint: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4/token', introspection_endpoint: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4/introspect',
        authorization_details_types_supported: ['https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access'],
        grant_types_supported: ['authorization_code', 'client_credentials'], response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'], tls_client_certificate_bound_access_tokens: false,
        capabilities: ['launch-standalone', 'client-confidential-asymmetric', 'permission-patient', 'permission-v2']
    };
    assert.equal(validateSmartConfiguration(metadata).token_endpoint, metadata.token_endpoint);
    assert.throws(() => validateSmartConfiguration({ ...metadata, code_challenge_methods_supported: ['plain'] }), /capability/);
    assert.throws(() => validateSmartConfiguration({ ...metadata, token_endpoint: '/token' }), /absolute/);
});

test('SP-001 /authorize SMART transaction binds exact redirect, audience, state, and S256 PKCE', () => {
    let sequence = 0;
    const transaction = createAuthorizationTransaction({
        authorizationEndpoint: 'https://pcm.example/authorize', clientId: 'client-1',
        redirectUri: 'https://app.example/callback', audience: 'https://pcm.example/r4',
        scope: 'patient/Observation.rs', clock: () => 1000,
        random: bytes => `${String(sequence += 1).padStart(2, '0')}${'a'.repeat(bytes)}`
    });
    const url = new URL(transaction.authorizationUrl);
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/callback');
    assert.equal(url.searchParams.get('aud'), 'https://pcm.example/r4');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(url.searchParams.get('code_challenge'), transaction.verifier);
    const callback = consumeAuthorizationCallback(transaction, { state: transaction.state, code: 'code-1' }, { clock: () => 2000 });
    assert.equal(callback.code, 'code-1');
    assert.throws(() => consumeAuthorizationCallback(transaction, { state: transaction.state, code: 'again' }), /consumed/);
});

test('SP-001 /authorize SMART authorization fails closed on state, expiry, errors, and unsupported scopes', () => {
    const make = () => createAuthorizationTransaction({
        authorizationEndpoint: 'https://pcm.example/authorize', clientId: 'client-1',
        redirectUri: 'https://app.example/callback', audience: 'https://pcm.example/r4',
        scope: 'patient/*.rs', clock: () => 0, random: bytes => `r${'a'.repeat(bytes)}`
    });
    const state = `r${'a'.repeat(24)}`;
    assert.throws(() => consumeAuthorizationCallback(make(), { state: 'wrong', code: 'code' }, { clock: () => 1 }), /state mismatch/);
    assert.throws(() => consumeAuthorizationCallback(make(), { state, code: 'code' }, { clock: () => 300001 }), /expired/);
    assert.throws(() => consumeAuthorizationCallback(make(), { state, error: 'access_denied' }, { clock: () => 1 }), /access_denied/);
    assert.throws(() => createAuthorizationTransaction({
        authorizationEndpoint: 'https://pcm.example/authorize', clientId: 'client-1',
        redirectUri: 'https://app.example/callback', audience: 'https://pcm.example/r4', scope: 'user/*.rs'
    }), /patient-level/);
    assert.throws(() => createAuthorizationTransaction({
        authorizationEndpoint: 'https://pcm.example/authorize', clientId: 'client-1',
        redirectUri: 'https://app.example/callback', audience: 'https://pcm.example/r4', scope: 'system/Patient.rs'
    }), /patient-level/);
    assert.throws(() => createAuthorizationTransaction({
        authorizationEndpoint: 'https://pcm.example/authorize', clientId: 'client-1',
        redirectUri: 'https://app.example/callback', audience: 'https://pcm.example/r4', scope: 'patient/Observation.rs?_filter=x'
    }), /patient-level/);
    assert.doesNotThrow(() => createAuthorizationTransaction({
        authorizationEndpoint: 'https://pcm.example/authorize', clientId: 'client-1',
        redirectUri: 'https://app.example/callback', audience: 'https://pcm.example/r4', scope: 'openid patient/Observation.rs'
    }));
});
