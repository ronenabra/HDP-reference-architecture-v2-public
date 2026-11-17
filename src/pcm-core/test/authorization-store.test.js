'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
    FileAuthorizationRecordRepository,
    pkceS256
} = require('../src/authorization-store');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const verifier = 'A'.repeat(43);

function withStore(callback) {
    const directory = fs.mkdtempSync(path.join(tmpRoot, 'pcm-authorization-store-'));
    let now = 1_000;
    let sequence = 0;
    const store = new FileAuthorizationRecordRepository(directory, {
        clock: () => now,
        tokenGenerator: kind => `pcm-${kind}-test-${++sequence}`
    });
    try {
        return callback(store, value => { now = value; }, directory);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function grant(overrides = {}) {
    return {
        clientId: 'pcm-sp-test-0001',
        redirectUri: 'https://app.example.test/callback',
        patient: { system: 'https://example.test/patient-id', value: 'private-patient' },
        scope: ['patient/Observation.rs', 'patient/Condition.rs'],
        codeChallenge: pkceS256(verifier),
        audience: 'https://pcm.example.test/r4',
        ...overrides
    };
}

function exchange(code, overrides = {}) {
    return {
        code,
        clientId: 'pcm-sp-test-0001',
        redirectUri: 'https://app.example.test/callback',
        codeVerifier: verifier,
        ...overrides
    };
}

test('authorization transactions expire and are consumed exactly once', () => withStore((store, setNow) => {
    const transaction = store.beginAuthorization({ clientId: 'pcm-sp-test-0001' });
    assert.equal(store.consumeAuthorization(transaction).clientId, 'pcm-sp-test-0001');
    assert.equal(store.consumeAuthorization(transaction), null);

    const expired = store.beginAuthorization({ clientId: 'pcm-sp-test-0001' });
    setNow(1_301);
    assert.equal(store.consumeAuthorization(expired), null);
}));

test('authorization code returns its complete binding and is atomic one-time state', () => withStore(store => {
    const code = store.issueCode(grant());
    const first = store.consumeCode(exchange(code));
    assert.equal(first.ok, true);
    assert.deepEqual(first.grant.patient, { system: 'https://example.test/patient-id', value: 'private-patient' });
    assert.deepEqual(first.grant.scope, ['patient/Observation.rs', 'patient/Condition.rs']);
    assert.equal(first.grant.audience, 'https://pcm.example.test/r4');
    assert.equal(store.consumeCode(exchange(code)).ok, false);
}));

test('authorization code rejects expiry and every binding mismatch', () => withStore((store, setNow) => {
    const cases = [
        { clientId: 'pcm-other-client' },
        { redirectUri: 'https://app.example.test/other' },
        { codeVerifier: 'B'.repeat(43) },
        { codeVerifier: 'short' },
        { requestedScopes: ['patient/Medication.rs'] }
    ];
    for (const mismatch of cases) {
        const result = store.consumeCode(exchange(store.issueCode(grant()), mismatch));
        assert.equal(result.ok, false);
        assert.equal(result.error, 'invalid_grant');
    }

    const narrowed = store.consumeCode(exchange(store.issueCode(grant()), {
        requestedScopes: ['patient/Observation.rs']
    }));
    assert.equal(narrowed.ok, true);

    const expired = store.issueCode(grant());
    setNow(1_121);
    assert.equal(store.consumeCode(exchange(expired)).ok, false);
}));

test('record filenames reveal neither opaque handles nor patient identifiers', () => withStore((store, setNow, directory) => {
    const code = store.issueCode(grant());
    const names = fs.readdirSync(directory).join(' ');
    assert.doesNotMatch(names, new RegExp(code));
    assert.doesNotMatch(names, /private-patient/);
}));
