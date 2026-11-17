'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');

const {
    CLIENT_ASSERTION_TYPE,
    COMPATIBILITY_WARNING_CODES,
    createClientAssertionVerifier
} = require('../src/client-assertion');
const { MemoryExpiryClaimStore } = require('../src/state-store');

const NOW = 2_000_000_000;
const CLIENT_ID = 'pcm-client-test-0001';
const LEGACY_CLIENT_ID = 'http://pcm.fhir.health.gov.il/Organization/org-test';
const TOKEN_AUDIENCE = 'https://pcm.example.test/token';
const INTROSPECTION_AUDIENCE = 'https://pcm.example.test/introspect';
const TLS_THUMBPRINT = 'A'.repeat(43);

test('authentication assertions reject business and unknown claims before replay consumption', () => {
    for (const extra of [{ extensions: { 'hl7-b2b': {} } }, { patient: '123' }, { nbf: NOW }, { authorization_details: [] }]) {
        const { verify } = harness();
        const clean = claims();
        assertInvalid(verify(sign({ ...clean, ...extra })), /unsupported authentication claims/);
        assert.equal(verify(sign(clean)).client.clientId, CLIENT_ID);
    }
});

function keyPair(type) {
    if (type === 'rsa') return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return crypto.generateKeyPairSync('ec', { namedCurve: type });
}

const keys = {
    ES256: keyPair('prime256v1'),
    ES384: keyPair('secp384r1'),
    RS256: keyPair('rsa'),
    wrong: keyPair('prime256v1')
};

const client = {
    clientId: CLIENT_ID,
    mtlsThumbprint: TLS_THUMBPRINT,
    assertionKeys: Object.fromEntries(Object.entries(keys)
        .filter(([algorithm]) => algorithm !== 'wrong')
        .map(([algorithm, pair]) => [algorithm, pair.publicKey]))
};

function encoded(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign(payload, algorithm = 'ES256', header = { alg: algorithm, typ: 'JWT' }, signingKey = keys[algorithm].privateKey) {
    const input = `${encoded(header)}.${encoded(payload)}`;
    const digest = algorithm === 'ES384' ? 'sha384' : 'sha256';
    const signature = algorithm.startsWith('ES')
        ? crypto.sign(digest, Buffer.from(input), { key: signingKey, dsaEncoding: 'ieee-p1363' })
        : crypto.sign(digest, Buffer.from(input), signingKey);
    return `${input}.${signature.toString('base64url')}`;
}

function claims(overrides = {}) {
    return {
        iss: CLIENT_ID,
        sub: CLIENT_ID,
        aud: TOKEN_AUDIENCE,
        jti: crypto.randomUUID(),
        iat: NOW,
        exp: NOW + 300,
        ...overrides
    };
}

function policy(adapters = []) {
    const algorithms = ['ES256', 'ES384'];
    if (adapters.includes('legacy-rs256-assertion')) algorithms.push('RS256');
    return {
        mode: adapters.length ? 'connectathon' : 'strict',
        assertion: { algorithms },
        compatibility: {
            enabledAdapters: adapters,
            warnings: adapters.map(adapter => `connectathon adapter ${adapter} accepted a test assertion`)
        }
    };
}

function harness(adapters = [], options = {}) {
    const warnings = [];
    const replayStore = options.replayStore || new MemoryExpiryClaimStore({ localOnly: true });
    const verifier = createClientAssertionVerifier({
        findClient: id => (id === CLIENT_ID ? options.client || client : null),
        resolveLegacyClientId: id => (id === LEGACY_CLIENT_ID ? CLIENT_ID : null),
        getPolicy: () => options.policy || policy(adapters),
        replayStore,
        clock: options.clock || (() => NOW),
        logger: { warn: (message, details) => warnings.push({ message, details }) }
    });
    const verify = (assertion, overrides = {}) => verifier({
        assertion,
        assertionType: CLIENT_ASSERTION_TYPE,
        exactAudience: TOKEN_AUDIENCE,
        tlsIdentity: { thumbprint: TLS_THUMBPRINT },
        ...overrides
    });
    return { replayStore, verifier, verify, warnings };
}

function assertInvalid(result, pattern) {
    assert.equal(result.errorStatus, 401);
    assert.equal(result.errorBody.error, 'invalid_client');
    if (pattern) assert.match(result.errorBody.error_description, pattern);
}

test('strict verifier accepts exact ES256 assertions and optional matching payload cnf', () => {
    const first = harness().verify(sign(claims()));
    assert.equal(first.client.clientId, CLIENT_ID);
    const second = harness().verify(sign(claims({ cnf: { 'x5t#S256': TLS_THUMBPRINT } })));
    assert.equal(second.client.clientId, CLIENT_ID);
});

test('transport ownership is independent of cnf and cannot be disabled by signature simulation', () => {
    for (const controls of [{}, { clientAssertionSignature: false }]) {
        for (const cnf of [undefined, { 'x5t#S256': 'B'.repeat(43) }]) {
            const result = harness().verify(sign(claims(cnf ? { cnf } : {})), {
                tlsIdentity: { thumbprint: 'B'.repeat(43) }, controls
            });
            assertInvalid(result, /transport role/);
        }
    }
    const { verify } = harness();
    const assertion = sign(claims());
    assertInvalid(verify(assertion, { tlsIdentity: { thumbprint: 'B'.repeat(43) } }));
    assert.equal(verify(assertion).client.clientId, CLIENT_ID, 'role denial does not consume assertion replay state');
});

test('same-client transport rollover accepts only currently registered thumbprints', () => {
    client.mtlsThumbprints = [TLS_THUMBPRINT, 'B'.repeat(43)];
    try {
        assert.equal(harness().verify(sign(claims()), { tlsIdentity: { thumbprint: 'B'.repeat(43) } }).transportVerified, true);
        client.mtlsThumbprints = [TLS_THUMBPRINT];
        assertInvalid(harness().verify(sign(claims()), { tlsIdentity: { thumbprint: 'B'.repeat(43) } }), /transport role/);
    } finally { delete client.mtlsThumbprints; }
});

test('required PCM mTLS rejects absent identity independently of source transport switches', () => {
    for (const mode of ['strict', 'connectathon']) {
        const effective = { ...policy(), mode, transport: { pcmPublic: { clientAuth: 'mtls' } } };
        const { verify } = harness([], { policy: effective });
        assertInvalid(verify(sign(claims()), { tlsIdentity: null, controls: { publicClientMtls: false } }), /transport role/);
        assert.equal(verify(sign(claims())).transportVerified, true);
    }
});

test('certificate key selection normalizes DER, PEM text and registered files to the same signing evidence', () => {
    const fs = require('node:fs'), path = require('node:path');
    const directory = require('../../../test-support/certificates').certificates();
    const filename = path.join(directory, 'sp-client-assertion.crt');
    const certificate = new crypto.X509Certificate(fs.readFileSync(filename));
    const signingKey = fs.readFileSync(path.join(directory, 'sp-client-assertion.key'));
    const expected = crypto.createHash('sha256').update(certificate.raw).digest('base64url');
    for (const material of [filename, certificate.raw, certificate.toString(), Buffer.from(certificate.toString())]) {
        const timestamp = Math.floor(Date.now() / 1000);
        const { verify } = harness([], { clock: () => timestamp, client: { ...client, assertionKeys: { ES256: material } } });
        const result = verify(sign(claims({ iat: timestamp, exp: timestamp + 300 }), 'ES256', { alg: 'ES256', typ: 'JWT', kid: jwkThumbprint(certificate.publicKey) }, signingKey));
        assert.equal(result.assertionSigningThumbprint, expected);
        assert.notEqual(result.assertionKeyThumbprint, expected);
        assert.equal(result.signatureVerified, true);
    }
});

test('registered signing certificates reject outside validity even with a fresh assertion', () => {
    const fs = require('node:fs'), path = require('node:path');
    const directory = require('../../../test-support/certificates').certificates();
    const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(directory, 'sp-client-assertion.crt')));
    const key = fs.readFileSync(path.join(directory, 'sp-client-assertion.key'));
    for (const timestamp of [Math.floor(Date.parse(certificate.validFrom) / 1000) - 1, Math.floor(Date.parse(certificate.validTo) / 1000) + 1]) {
        const { verify } = harness([], { clock: () => timestamp, client: { ...client, assertionKeys: { ES256: certificate.toString() } } });
        assertInvalid(verify(sign(claims({ iat: timestamp, exp: timestamp + 120 }), 'ES256', { alg: 'ES256', typ: 'JWT' }, key)), /key selection/);
    }
});

test('strict verifier rejects malformed JOSE headers and every forbidden key selector', async t => {
    assertInvalid(harness().verify(sign(claims(), 'ES256', { alg: 'ES256' })), /typ/);
    assertInvalid(harness().verify(sign(claims(), 'ES256', { alg: 'ES256', typ: 'at+jwt' })), /typ/);
    for (const forbidden of ['x5c', 'x5t', 'x5t#S256', 'jku', 'jwk', 'x5u']) {
        await t.test(forbidden, () => {
            assertInvalid(harness().verify(sign(claims(), 'ES256', {
                alg: 'ES256', typ: 'JWT', [forbidden]: forbidden === 'x5c' ? ['value'] : 'value'
            })), /Forbidden/);
        });
    }
    assertInvalid(harness().verify(sign(claims(), 'RS256')), /algorithm/);
});

test('strict verifier rejects missing, mismatched, and incorrectly typed registered claims', async t => {
    for (const name of ['iss', 'sub', 'aud', 'jti', 'iat', 'exp']) {
        await t.test(`missing ${name}`, () => {
            const payload = claims();
            delete payload[name];
            assertInvalid(harness().verify(sign(payload)), /requires/);
        });
    }
    assertInvalid(harness().verify(sign(claims({ sub: 'pcm-other-client' }))), /iss and sub/);
    assertInvalid(harness().verify(sign(claims({ aud: 'https://pcm.example.test/wrong' }))), /audience/);
    assertInvalid(harness().verify(sign(claims({ aud: [TOKEN_AUDIENCE] }))), /requires/);
    assertInvalid(harness().verify(sign(claims({ iat: String(NOW) }))), /integer/);
});

test('strict verifier enforces assertion time, registered key, client, cnf, and replay invariants', () => {
    assertInvalid(harness().verify(sign(claims({ exp: NOW + 301 }))), /lifetime/);
    assertInvalid(harness().verify(sign(claims({ exp: NOW }))), /lifetime/);
    assertInvalid(harness().verify(sign(claims({ iat: NOW + 31, exp: NOW + 100 }))), /future/);
    assertInvalid(harness().verify(sign(claims({ iat: NOW - 300, exp: NOW - 31 }))), /expired/);
    assertInvalid(harness().verify(sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT' }, keys.wrong.privateKey)), /signature/);
    assertInvalid(harness().verify(sign(claims({ iss: 'unknown-client', sub: 'unknown-client' }))), /registered/);
    assertInvalid(harness().verify(sign(claims({ cnf: { 'x5t#S256': 'short' } }))), /cnf/);
    assertInvalid(harness().verify(sign(claims({ cnf: { 'x5t#S256': 'B'.repeat(43) } }))), /does not match/);
    assertInvalid(harness().verify(sign(claims({ cnf: { 'x5t#S256': TLS_THUMBPRINT, extra: true } }))), /cnf/);

    const repeatedClaims = claims();
    const repeatedAssertion = sign(repeatedClaims);
    const replayHarness = harness();
    assert.equal(replayHarness.verify(repeatedAssertion).client.clientId, CLIENT_ID);
    assertInvalid(replayHarness.verify(repeatedAssertion), /already been used/);
});

test('each allowlisted compatibility form warns only in connectathon and is rejected in strict mode', async t => {
    const cases = [
        {
            adapter: 'legacy-rs256-assertion',
            assertion: () => sign(claims(), 'RS256')
        },
        {
            adapter: 'legacy-jose-kid',
            assertion: () => sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT', kid: 'registered-key' })
        },
        {
            adapter: 'legacy-introspection-token-audience',
            assertion: () => sign(claims({ aud: TOKEN_AUDIENCE })),
            request: { exactAudience: INTROSPECTION_AUDIENCE, compatibilityAudiences: [TOKEN_AUDIENCE] }
        },
        {
            adapter: 'legacy-organization-url-client-id',
            assertion: () => sign(claims({ iss: LEGACY_CLIENT_ID, sub: LEGACY_CLIENT_ID }))
        }
    ];

    for (const item of cases) {
        await t.test(item.adapter, () => {
            const compatible = harness([item.adapter]);
            const accepted = compatible.verify(item.assertion(), item.request);
            assert.equal(accepted.client.clientId, CLIENT_ID);
            assert.equal(compatible.warnings.length, 1);
            assert.equal(compatible.warnings[0].details.code, COMPATIBILITY_WARNING_CODES[item.adapter]);
            assertInvalid(harness().verify(item.assertion(), item.request));
        });
    }
});

test('connectathon adapters never relax key, time, issuer binding, or replay checks', () => {
    const adapters = [
        'legacy-rs256-assertion',
        'legacy-es384-assertion',
        'legacy-jose-kid',
        'legacy-introspection-token-audience',
        'legacy-organization-url-client-id'
    ];
    assertInvalid(harness(adapters).verify(
        sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT' }, keys.wrong.privateKey)
    ), /signature/);
    assertInvalid(harness(adapters).verify(sign(claims({ iat: NOW - 300, exp: NOW - 31 }))), /expired/);
    assertInvalid(harness(adapters).verify(sign(claims({ sub: 'different-client' }))), /iss and sub/);

    const assertion = sign(claims());
    const compatible = harness(adapters);
    assert.equal(compatible.verify(assertion).client.clientId, CLIENT_ID);
    assertInvalid(compatible.verify(assertion), /already been used/);
});

test('disabling replay retains signature, audience and expiry checks', () => {
    const { verify } = harness();
    const controls = { clientAssertionReplay: false };
    const assertion = sign(claims());
    assert.equal(verify(assertion, { controls }).errorStatus, undefined);
    assert.equal(verify(assertion, { controls }).errorStatus, undefined);
    for (const invalid of [sign(claims({ aud: 'https://wrong.test/token' })), sign(claims({ iat: NOW - 1000, exp: NOW - 900 })), sign(claims(), 'ES256', undefined, keys.wrong.privateKey)]) {
        assert.equal(verify(invalid, { controls }).errorStatus, 401);
    }
});

test('assertion signature, audience and expiry switches act independently', () => {
    for (const [control, assertion] of [
        ['clientAssertionSignature', sign(claims(), 'ES256', undefined, keys.wrong.privateKey)],
        ['clientAssertionAudience', sign(claims({ aud: 'https://wrong.test/token' }))],
        ['clientAssertionExpiry', sign(claims({ iat: NOW - 1000, exp: NOW - 900 }))]
    ]) {
        assert.equal(harness().verify(assertion).errorStatus, 401);
        const { verify } = harness();
        assert.equal(verify(assertion, { controls: { [control]: false } }).errorStatus, undefined, control);
        assert.equal(verify(assertion, { controls: { [control]: false } }).errorStatus, 401, 'replay still enforced');
    }
});

const { jwkThumbprint } = require('../../shared/assertion-keys');

test('normative ES256/ES384 thumbprints, SMART kid and rollover never use fallback', () => {
    for (const algorithm of ['ES256', 'ES384']) {
        const kid = jwkThumbprint(keys[algorithm].publicKey);
        const assertion = sign(claims(), algorithm, { alg: algorithm, typ: 'JWT', kid });
        assert.equal(harness().verify(assertion).assertionKeyThumbprint, kid);
        assert.equal(harness().verify(sign(claims(), algorithm)).client.clientId, CLIENT_ID);
        for (const wrong of ['', 'bad', kid + '=', 'A'.repeat(43), jwkThumbprint(keys.wrong.publicKey)]) {
            assertInvalid(harness().verify(sign(claims(), algorithm, { alg: algorithm, typ: 'JWT', kid: wrong })));
        }
        // A valid-looking unknown thumbprint must not be normalized even with legacy enabled.
        assertInvalid(harness(['legacy-jose-kid']).verify(sign(claims(), algorithm, { alg: algorithm, typ: 'JWT', kid: 'A'.repeat(43) })));
    }
    const previous = client.assertionKeys.ES256;
    client.assertionKeys.ES256 = [previous, keys.wrong.publicKey];
    try {
        assertInvalid(harness().verify(sign(claims())), /ambiguous/);
        assertInvalid(harness(['legacy-jose-kid']).verify(sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT', kid: 'legacy-key' })), /ambiguous/);
        const kid = jwkThumbprint(keys.wrong.publicKey);
        assertInvalid(harness().verify(sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT', kid })), /signature/);
        assert.equal(harness().verify(sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT', kid }, keys.wrong.privateKey)).assertionKeyThumbprint, kid);
    } finally { client.assertionKeys.ES256 = previous; }
    client.authorizationCodeGrant = true;
    try {
        assertInvalid(harness().verify(sign(claims())), /SMART.*kid/);
        for (const algorithm of ['ES256', 'ES384']) {
            const header = { alg: algorithm, typ: 'JWT', kid: jwkThumbprint(keys[algorithm].publicKey) };
            assert.equal(harness().verify(sign(claims(), algorithm, header)).client.clientId, CLIENT_ID);
        }
    }
    finally { delete client.authorizationCodeGrant; }
});

test('signature-disabled simulation preserves structural kid and certificate correlation rules', () => {
    const unknownKid = jwkThumbprint(keys.wrong.publicKey);
    const assertion = sign(claims(), 'ES256', { alg: 'ES256', typ: 'JWT', kid: unknownKid }, keys.wrong.privateKey);
    const relaxed = harness().verify(assertion, { controls: { clientAssertionSignature: false } });
    assert.equal(relaxed.client.clientId, CLIENT_ID);
    assert.equal(relaxed.assertionKeyThumbprint, null);
    assertInvalid(harness().verify(assertion));
    assertInvalid(harness().verify(sign(claims({ cnf: { 'x5t#S256': 'B'.repeat(43) } })), { controls: { clientAssertionSignature: false } }));
});


test('registered wrong curves cannot verify an otherwise correctly signed ES384 assertion', () => {
    const previous = client.assertionKeys.ES384;
    client.assertionKeys.ES384 = keys.ES256.publicKey;
    try { assertInvalid(harness().verify(sign(claims(), 'ES384')), /registered key/); }
    finally { client.assertionKeys.ES384 = previous; }
});

test('deferred replay preserves the authentication result until successful issuance commits it once', () => {
    const { verifier } = harness();
    const assertion = sign(claims());
    const input = { assertion, assertionType: CLIENT_ASSERTION_TYPE, exactAudience: TOKEN_AUDIENCE, tlsIdentity: { thumbprint: TLS_THUMBPRINT }, deferReplay: true };
    const first = verifier(input), second = verifier(input);
    assert.equal(first.client.clientId, CLIENT_ID);
    assert.equal(second.client.clientId, CLIENT_ID);
    assert.equal(first.commitReplay(), true);
    assert.equal(second.commitReplay(), false);
});
