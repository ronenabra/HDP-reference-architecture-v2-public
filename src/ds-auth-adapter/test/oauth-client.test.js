'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { jwkThumbprint } = require('../../shared/assertion-keys');
const {
    ASSERTION_TYPE,
    INTROSPECTION_SCOPE,
    IntrospectionCredentialCache,
    assertion,
    bearerIntrospectionForm,
    bearerTokenForm,
    directIntrospectionForm,
    validateBearerResponse
} = require('../src/oauth-client');

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const CLIENT = 'pcm-ds-client-0001';

test('ES256 assertion has exact claims and a fresh jti without key-selection headers', () => {
    const first = assertion(CLIENT, 'https://pcm.test/introspect', privateKey, () => 1000);
    const second = assertion(CLIENT, 'https://pcm.test/introspect', privateKey, () => 1000);
    const decoded = jwt.decode(first, { complete: true });
    assert.deepEqual(Object.keys(decoded.header).sort(), ['alg', 'kid', 'typ']);
    assert.deepEqual(decoded.header, { alg: 'ES256', typ: 'JWT', kid: jwkThumbprint(privateKey) });
    assert.equal(decoded.payload.iss, CLIENT);
    assert.equal(decoded.payload.sub, CLIENT);
    assert.equal(decoded.payload.aud, 'https://pcm.test/introspect');
    assert.equal(decoded.payload.iat, 1000);
    assert.equal(decoded.payload.exp, 1300);
    assert.notEqual(decoded.payload.jti, jwt.decode(second).jti);
});

test('bearer acquisition and both introspection modes use exact closed forms', () => {
    assert.deepEqual(Object.fromEntries(bearerTokenForm('assertion', 'https://pcm.test/introspect')), {
        grant_type: 'client_credentials',
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: 'assertion',
        scope: INTROSPECTION_SCOPE,
        resource: 'https://pcm.test/introspect'
    });
    assert.deepEqual(Object.fromEntries(directIntrospectionForm('subject', 'assertion')), {
        token: 'subject', token_type_hint: 'access_token', client_assertion_type: ASSERTION_TYPE, client_assertion: 'assertion'
    });
    assert.deepEqual(Object.fromEntries(bearerIntrospectionForm('subject')), { token: 'subject', token_type_hint: 'access_token' });
});

test('introspection bearer responses are closed and cached only for returned lifetime', () => {
    let now = 1000;
    const cache = new IntrospectionCredentialCache({ clock: () => now });
    const response = { access_token: 'opaque', token_type: 'Bearer', expires_in: 30, scope: INTROSPECTION_SCOPE };
    assert.equal(cache.put(response), 'opaque');
    now += 29999;
    assert.equal(cache.get(), 'opaque');
    now += 1;
    assert.equal(cache.get(), null);
    for (const invalid of [
        { ...response, extra: true }, { ...response, token_type: 'bearer' },
        ...[0, -1, 31, '30', 1.5, Infinity, NaN].map(expires_in => ({ ...response, expires_in })), { ...response, scope: 'introspection' }
    ]) assert.throws(() => validateBearerResponse(invalid), /Invalid closed/);
    for (const seconds of [1, 7, 30]) assert.equal(validateBearerResponse({ ...response, expires_in: seconds }).expires_in, seconds);
});

test('test credentials retain the original receipt deadline and reject beyond the environment maximum', () => {
    let now = 1000;
    const cache = new IntrospectionCredentialCache({ clock: () => now, maximumSeconds: 86400 });
    const response = { access_token: 'test', token_type: 'Bearer', expires_in: 86400, scope: INTROSPECTION_SCOPE };
    cache.put(response); now += 86399999; assert.equal(cache.get(), 'test');
    now++; assert.equal(cache.get(), null);
    for (const expires_in of [86401, '86400', 0]) assert.throws(() => cache.put({ ...response, expires_in }), /Invalid closed/);
});
