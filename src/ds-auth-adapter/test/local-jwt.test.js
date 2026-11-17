'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const localJwt = require('../src/local-jwt');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

function withEnv(values, fn) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
    try { return fn(); } finally {
        for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
}

function fixture() {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'local-jwt-'));
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = path.join(tmp, 'key.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    return { tmp, keyPath };
}

function payload() {
    return {
        schema: 'pcm-ds-local-token/5', authorization_schema: 'pcm-ds-authorization-context/4',
        ho_id: 'ho-a', kind: 'data-source-access', sub: 'pcm-sp-client-0001', client_id: 'pcm-sp-client-0001',
        scope: 'patient/Observation.rs', pcm_issuer: 'https://pcm.test', pcm_audience: 'https://ho-a.test/fhir',
        pcm_expires_at: 1030, authentication: { correlationVerified: true }
    };
}

test('metadata and JWKS publish one private fixed issuer and RS256 key', () => {
    const value = fixture();
    try {
        withEnv({ HO_ID: 'ho-a', LOCAL_JWT_SIGNING_KEY_PATH: value.keyPath, LOCAL_JWT_KEY_ID: 'ho-a-key' }, () => {
            const metadata = localJwt.getAuthorizationServerMetadata();
            assert.equal(metadata.issuer, 'https://ds-auth-adapter.internal/ho-a');
            assert.equal(metadata.jwks_uri, 'https://ds-auth-adapter.internal/ho-a/.well-known/jwks.json');
            assert.deepEqual(metadata.grant_types_supported, []);
            assert.deepEqual(localJwt.getJwks().keys.map(key => [key.kid, key.alg]), [['ho-a-key', 'RS256']]);
        });
    } finally { fs.rmSync(value.tmp, { recursive: true, force: true }); }
});

test('local JWT has closed claims, exact bindings, and source-capped lifetime', () => {
    const value = fixture();
    try {
        withEnv({ LOCAL_JWT_SIGNING_KEY_PATH: value.keyPath }, () => {
            const token = localJwt.signLocalJwt(payload(), {
                issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', sourceExpiresAt: 1009, clock: () => 1000
            });
            const header = jwt.decode(token, { complete: true }).header;
            const claims = jwt.verify(token, crypto.createPublicKey({ key: localJwt.getJwks().keys[0], format: 'jwk' }), {
                algorithms: ['RS256'], issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', clockTimestamp: 1000
            });
            assert.deepEqual(Object.keys(header).sort(), ['alg', 'kid', 'typ']);
            assert.equal(claims.iat, 1000);
            assert.equal(claims.exp, 1009);
            assert.throws(() => jwt.verify(token, crypto.createPublicKey({ key: localJwt.getJwks().keys[0], format: 'jwk' }), {
                algorithms: ['RS256'], clockTimestamp: 1009
            }), /expired/);
            assert.throws(() => jwt.verify(token, crypto.createPublicKey({ key: localJwt.getJwks().keys[0], format: 'jwk' }), { audience: 'urn:ho-b:fhir', clockTimestamp: 1000 }), /audience/);
        });
    } finally { fs.rmSync(value.tmp, { recursive: true, force: true }); }
});

test('local signing rejects arbitrary claims and expired source authorization', () => {
    const value = fixture();
    try {
        withEnv({ LOCAL_JWT_SIGNING_KEY_PATH: value.keyPath }, () => {
            assert.throws(() => localJwt.signLocalJwt({ sub: 'legacy' }, { sourceExpiresAt: 1010, clock: () => 1000 }), /claim schema/);
            assert.throws(() => localJwt.signLocalJwt(payload(), { sourceExpiresAt: 1000, clock: () => 1000 }), /expired/);
        });
    } finally { fs.rmSync(value.tmp, { recursive: true, force: true }); }
});

test('mapping a cached authorization preserves its one-second remaining deadline', () => {
    const { ActiveIntrospectionCache } = require('../src/authorization-cache');
    const { validateIntrospectionResponse } = require('../src/introspection-contract');
    const { mapIdentity } = require('../src/mapper');
    const { AUDIENCE, NOW, dataSourceResponse, options } = require('../test-support/introspection-fixture');
    const value = fixture();
    let now = NOW;
    const binding = { hoId: 'ho-a', expectedAudience: AUDIENCE };
    const context = validateIntrospectionResponse({ ...dataSourceResponse(), exp: NOW + 2 }, options);
    const cache = new ActiveIntrospectionCache({ clock: () => now * 1000 });
    cache.put('near-deadline', binding, context);
    try {
        withEnv({ LOCAL_JWT_SIGNING_KEY_PATH: value.keyPath }, () => {
            now += 1;
            const mapping = { hoId: 'ho-a', issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir',
                requestBinding: { method: 'GET', uri: '/fhir/Observation' }, identityOverrides: {}, clock: () => now };
            const token = mapIdentity(cache.get('near-deadline', binding), mapping);
            assert.equal(jwt.decode(token).exp, NOW + 2);
            now += 1;
            assert.equal(cache.get('near-deadline', binding), null);
            assert.throws(() => mapIdentity(context, mapping), /expired/);
        });
    } finally { fs.rmSync(value.tmp, { recursive: true, force: true }); }
});

test('private token reductions enforce the captured exact bound without transport expansion', () => {
    const value = fixture();
    try { withEnv({LOCAL_JWT_SIGNING_KEY_PATH:value.keyPath}, () => {
        const options = {sourceExpiresAt:1030,clock:()=>1000};
        const token = localJwt.signLocalJwt(payload(),options), size = Buffer.byteLength(token);
        assert.equal(Buffer.byteLength(localJwt.signLocalJwt(payload(),{...options,maxPrivateAuthorizationBytes:size})),size);
        assert.throws(()=>localJwt.signLocalJwt(payload(),{...options,maxPrivateAuthorizationBytes:size-1}), error => {
            assert.match(error.message, /maxPrivateAuthorizationBytes=.*observed=/);
            assert.deepEqual(error.budgetFailure, {setting:'maxPrivateAuthorizationBytes',threshold:size-1,observed:size,unit:'bytes'});
            assert.equal(Object.isFrozen(error.budgetFailure),true); return true;
        });
        assert.throws(()=>localJwt.signLocalJwt(payload(),{...options,maxPrivateAuthorizationBytes:57345}),/Invalid/);
    }); } finally { fs.rmSync(value.tmp,{recursive:true,force:true}); }
});
