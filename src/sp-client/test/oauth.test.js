'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwkThumbprint } = require('../../shared/assertion-keys');
const {
    ExpiringTokenCache,
    buildTokenForm,
    createClientAssertion,
    effectiveManagementScope,
    validateTokenResponse
} = require('../src/oauth');
const { CONSENT_POLICY, SCOPES } = require('../src/constants');

test('SP-001 /token assertions are header-clean ES256 with exact audience, fresh jti, and optional cnf', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    let counter = 0;
    const options = {
        clientId: 'pcm-sp-test-0001', privateKey,
        audience: 'https://pcm.example/token', clock: () => 1_700_000_000_000,
        jtiGenerator: () => `jti-${++counter}`, cnfThumbprint: 'A'.repeat(43)
    };
    const first = createClientAssertion(options);
    const second = createClientAssertion(options);
    const header = jwt.decode(first, { complete: true }).header;
    assert.deepEqual(header, { alg: 'ES256', typ: 'JWT', kid: jwkThumbprint(publicKey) });
    const claims = jwt.verify(first, publicKey, { algorithms: ['ES256'], audience: options.audience, clockTimestamp: 1_700_000_001 });
    assert.equal(claims.iss, options.clientId);
    assert.equal(claims.sub, options.clientId);
    assert.equal(claims.exp - claims.iat, 300);
    assert.deepEqual(claims.cnf, { 'x5t#S256': 'A'.repeat(43) });
    assert.notEqual(jwt.decode(first).jti, jwt.decode(second).jti);
    assert.throws(() => createClientAssertion({ ...options, clientId: 'https://legacy.example/Organization/1' }), /opaque/);
    assert.throws(() => createClientAssertion({ ...options, cnfThumbprint: 'not-a-thumbprint' }), /thumbprint/);
    const trailing = createClientAssertion({ ...options, audience: 'https://pcm.example/token/' });
    assert.equal(jwt.decode(trailing).aud, 'https://pcm.example/token/');
});

test('management form retains one RFC 8707 resource without artificial RAR', () => {
    const form = buildTokenForm({ assertion: 'assertion', scope: SCOPES.management, resource: 'https://pcm.example/r4' });
    assert.equal(form.getAll('resource').length, 1);
    assert.equal(form.get('scope'), 'system/*.crus');
    assert.equal(form.has('authorization_details'), false);
});

test('SP-001 token response cache expires from response lifetime and never returns stale values', () => {
    let now = 10_000;
    const cache = new ExpiringTokenCache({ clock: () => now, skewMs: 0 });
    cache.put('key', { access_token: 'opaque', token_type: 'Bearer', expires_in: 30, scope: 'system/*.crus' });
    assert.equal(cache.get('key'), 'opaque');
    const details = cache.details('key'); details.scope = 'changed';
    assert.equal(cache.details('key').scope, 'system/*.crus');
    now = 40_000;
    assert.equal(cache.get('key'), null);
    assert.throws(() => validateTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 30, extra: true }), /closed/);
    assert.equal(validateTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 300, scope: 'system/*.crus' }).expires_in, 300);
    assert.throws(() => validateTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 86401, scope: 'system/*.crus' }), /closed/);
    assert.throws(() => validateTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 0, scope: 'system/*.crus' }), /closed/);
    assert.throws(() => validateTokenResponse({ access_token: 'x', token_type: 'Bearer', expires_in: 30 }), /closed/);
});

test('SP-001 system/*.crus legacy management spelling is available only through its named adapter', () => {
    const strict = { compatibility: { enabledAdapters: [] } };
    const compatible = { compatibility: { enabledAdapters: ['legacy-management-scope-cruds'] } };
    assert.throws(() => effectiveManagementScope(strict, SCOPES.legacyManagement), /Unsupported/);
    assert.equal(effectiveManagementScope(compatible, SCOPES.legacyManagement), SCOPES.management);
});


test('continued SP cache use reclaims distinct expired keys while retaining active tokens', () => {
    let now = 10_000;
    const cache = new ExpiringTokenCache({ clock: () => now, skewMs: 0 });
    const response = { access_token: 'opaque', token_type: 'Bearer', expires_in: 30, scope: 'system/*.crus' };
    for (let index = 0; index < 65; index++) cache.put(`expired-${index}`, response);
    now += 30_000;
    cache.put('active', { ...response, access_token: 'active-token' });
    assert.ok(cache.records.size >= 65 - 16 + 1, 'put must reclaim only one batch');
    for (let index = 0; index < 20; index++) {
        const before = cache.records.size;
        assert.equal(cache.get('active'), 'active-token');
        assert.ok(before - cache.records.size <= 16);
    }
    assert.equal(cache.records.size, 1);
    cache.clear();
    assert.equal(cache.get('active'), null);
});

test('test-environment token lifetime never extends a positive Doctor cache beyond 30 seconds', () => {
    let now = 1000;
    const cache = new ExpiringTokenCache({ clock: () => now, skewMs: 0 });
    const response = { access_token: 'test-token', token_type: 'Bearer', scope: 'patient/Observation.rs', expires_in: 86400 };
    cache.put('test', response);
    now += 29999; assert.equal(cache.get('test'), 'test-token');
    now += 1; assert.equal(cache.get('test'), null);
    assert.equal(response.expires_in, 86400);
});


test('approved P-384 assertion producer emits ES384 with its independent JWK thumbprint', () => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const value = createClientAssertion({ clientId: 'pcm-client-p384', privateKey: pair.privateKey, audience: 'https://pcm.test/token' });
    assert.deepEqual(jwt.decode(value, { complete: true }).header, { alg: 'ES384', typ: 'JWT', kid: jwkThumbprint(pair.publicKey) });
    assert.equal(jwt.verify(value, pair.publicKey, { algorithms: ['ES384'] }).iss, 'pcm-client-p384');
});
