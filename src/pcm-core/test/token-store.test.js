'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { FileTokenStore, TOKEN_KINDS, EXPIRED_TOKEN_RETENTION_SECONDS, EXPIRY_BATCH_SIZE } = require('../src/token-store');

test('typed token repository issues every kind with injected clock and opaque generator', () => {
    const directory = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-token-store-'));
    let sequence = 0;
    const store = new FileTokenStore(directory, {
        clock: () => 1000,
        tokenGenerator: () => `opaque-${++sequence}`
    });
    try {
        for (const kind of TOKEN_KINDS) {
            const issued = store.issue(kind, { active: true, scope: 'scope' }, 30);
            assert.equal(issued.record.kind, kind);
            assert.equal(issued.record.iat, 1000);
            assert.equal(issued.record.exp, 1030);
            assert.deepEqual(store.get(issued.token), issued.record);
        }
        assert.equal(store.size, TOKEN_KINDS.length);
        assert.throws(() => store.issue('unknown', {}, 30), /Unsupported token kind/);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('typed token repository stores no bearer value in its filename and fails closed on malformed records', () => {
    const directory = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-token-store-'));
    const token = 'sensitive-bearer-value';
    const store = new FileTokenStore(directory);
    try {
        store.set(token, { kind: 'management', iat: 1, exp: 31, active: true });
        assert.equal(fs.readdirSync(directory).some(name => name.includes(token)), false);
        assert.throws(() => store.set('bad', { iat: 1, exp: 2 }), /explicit kind/);
        store.clear();
        assert.equal(store.size, 0);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});


test('continued reads reclaim distinct expired token files after restart with bounded I/O', t => {
    const directory = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-token-reap-'));
    let now = 10_000;
    const first = new FileTokenStore(directory, { clock: () => now });
    for (let index = 0; index < 65; index++) first.issue('management', {}, 30);
    first.close();
    now += 30 + EXPIRED_TOKEN_RETENTION_SECONDS;
    const store = new FileTokenStore(directory, { clock: () => now });
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const active = store.issue('management', {}, 300);
    assert.ok(store.size >= 65 - EXPIRY_BATCH_SIZE + 1, 'issuance must reclaim only one batch');
    const firstUse = path.join(directory, 'first-use-window.json');
    fs.writeFileSync(firstUse, JSON.stringify({ startedAt: 1, expiresAt: 2 }));
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (file, ...args) {
        if (String(file).startsWith(directory)) reads++;
        return originalRead.call(this, file, ...args);
    };
    try {
        for (let index = 0; index < 20; index++) {
            reads = 0;
            assert.deepEqual(store.get(active.token), active.record);
            assert.ok(reads <= EXPIRY_BATCH_SIZE + 1, `one request read ${reads} token files`);
        }
    } finally { fs.readFileSync = originalRead; }
    assert.equal(store.size, 1);
    assert.equal(fs.existsSync(firstUse), true);
});

test('backdated simulation records survive the documented interval but are eventually reclaimed', t => {
    const directory = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-token-retention-'));
    let now = 10_000;
    const store = new FileTokenStore(directory, { clock: () => now });
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const issued = store.issue('data_source_access', {}, -3600);
    assert.ok(issued.record.exp < now, 'retention must not extend authorization expiry');
    assert.deepEqual(store.get(issued.token), issued.record);
    now = issued.record.exp + EXPIRED_TOKEN_RETENTION_SECONDS - 1;
    assert.deepEqual(store.get(issued.token), issued.record);
    now++;
    for (let index = 0; index < 3; index++) store.get('unrelated-key');
    assert.equal(store.get(issued.token), undefined);
    assert.equal(store.size, 0);
});

test('diagnostic peek never reclaims expired records or changes revocation files', t => {
    const directory = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-token-peek-'));
    let now = 1000;
    const store = new FileTokenStore(directory, { clock: () => now });
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const issued = store.issue('data_source_access', {}, 30);
    store.revoke(issued.token); store.close();
    const snapshot = () => fs.readdirSync(directory).sort().map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]);
    const before = snapshot();
    assert.equal(store.peek(issued.token).revoked, true);
    now = issued.record.exp + EXPIRED_TOKEN_RETENTION_SECONDS;
    assert.equal(store.peek(issued.token), undefined); assert.equal(store.peek('unknown'), undefined);
    assert.deepEqual(snapshot(), before);
});
