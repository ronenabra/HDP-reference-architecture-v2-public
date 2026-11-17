'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const test = require('node:test');

const { FileExpiryClaimStore, FileFirstUseWindowStore, MemoryExpiryClaimStore } = require('../src/state-store');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

test('shared file claim is atomic across store instances and expires deterministically', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-state-store-'));
    try {
        const first = new FileExpiryClaimStore(tmp);
        const second = new FileExpiryClaimStore(tmp);
        assert.equal(first.tryClaim('issuer\u0000jti', 200, 100), true);
        assert.equal(second.tryClaim('issuer\u0000jti', 200, 100), false);
        assert.equal(second.tryClaim('issuer\u0000jti', 300, 200), true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('a fresh process rejects a replay already recorded in the shared directory', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-state-store-process-'));
    try {
        const first = new FileExpiryClaimStore(tmp);
        assert.equal(first.tryClaim('client\u0000replayed-jti', 2_000_000_300, 2_000_000_000), true);
        const modulePath = path.resolve(__dirname, '..', 'src', 'state-store.js');
        const script = [
            `const { FileExpiryClaimStore } = require(${JSON.stringify(modulePath)});`,
            `const store = new FileExpiryClaimStore(${JSON.stringify(tmp)});`,
            "process.stdout.write(String(store.tryClaim('client\\u0000replayed-jti', 2000000300, 2000000000)));"
        ].join('');
        const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout, 'false');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('concurrent processes permit exactly one atomic claim', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-state-store-race-'));
    try {
        const modulePath = path.resolve(__dirname, '..', 'src', 'state-store.js');
        const script = [
            `const { FileExpiryClaimStore } = require(${JSON.stringify(modulePath)});`,
            `const store = new FileExpiryClaimStore(${JSON.stringify(tmp)});`,
            "process.stdout.write(String(store.tryClaim('client\\u0000race-jti', 2000000300, 2000000000)));"
        ].join('');
        const attempts = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', script]);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
        }));
        const outcomes = await Promise.all(attempts);
        assert.equal(outcomes.filter(value => value === 'true').length, 1);
        assert.equal(outcomes.filter(value => value === 'false').length, 7);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('memory claim store requires an explicit local-only selection', () => {
    assert.throws(() => new MemoryExpiryClaimStore(), /local\/test/);
    const local = new MemoryExpiryClaimStore({ localOnly: true });
    assert.equal(local.tryClaim('one', 20, 10), true);
    assert.equal(local.tryClaim('one', 20, 10), false);
});

test('first-use windows retain their original start and never restart after expiry', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-first-use-store-'));
    try {
        const first = new FileFirstUseWindowStore(tmp);
        const second = new FileFirstUseWindowStore(tmp);
        assert.deepEqual(first.getOrStart('consent\u0000source', 3600, 100), {
            ok: true, started: true, startedAt: 100, expiresAt: 3700
        });
        assert.deepEqual(second.getOrStart('consent\u0000source', 3600, 200), {
            ok: true, started: false, startedAt: 100, expiresAt: 3700
        });
        assert.deepEqual(second.getOrStart('consent\u0000source', 3600, 3700), {
            ok: true, started: false, startedAt: 100, expiresAt: 3700
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('concurrent first-use calls establish one shared source-specific window', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-first-use-race-'));
    try {
        const modulePath = path.resolve(__dirname, '..', 'src', 'state-store.js');
        const script = [
            `const { FileFirstUseWindowStore } = require(${JSON.stringify(modulePath)});`,
            `const store = new FileFirstUseWindowStore(${JSON.stringify(tmp)});`,
            "process.stdout.write(JSON.stringify(store.getOrStart('consent\\u0000source', 3600, 100)));"
        ].join('');
        const attempts = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', script]);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.once('error', reject);
            child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
        }));
        const outcomes = await Promise.all(attempts);
        assert.equal(outcomes.every(value => value.ok && value.startedAt === 100 && value.expiresAt === 3700), true);
        assert.equal(outcomes.filter(value => value.started).length, 1);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
