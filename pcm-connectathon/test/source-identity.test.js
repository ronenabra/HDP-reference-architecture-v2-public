'use strict';
/** Prove evidence identifies dirty implementation inputs without retaining secret contents. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sourceIdentity } = require('../scripts/source-identity');

test('source identity covers dirty/new/deleted files and excludes ignored credentials', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-identity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', root]);
    fs.writeFileSync(path.join(root, '.gitignore'), 'team-secret.key\n');
    fs.writeFileSync(path.join(root, 'source.js'), 'first');
    execFileSync('git', ['add', '.gitignore', 'source.js'], { cwd: root });
    fs.writeFileSync(path.join(root, 'team-secret.key'), 'secret canary never stored');
    const before = sourceIdentity(root);
    assert.deepEqual(sourceIdentity(root), before);
    fs.writeFileSync(path.join(root, 'source.js'), 'second');
    fs.writeFileSync(path.join(root, 'new.js'), 'new implementation');
    const changed = sourceIdentity(root);
    assert.notEqual(changed.sha256, before.sha256);
    assert.ok(changed.files.some(file => file.path === 'new.js'));
    assert.ok(!changed.files.some(file => file.path === 'team-secret.key'));
    assert.ok(!JSON.stringify(changed).includes('secret canary'));
    fs.unlinkSync(path.join(root, 'source.js'));
    assert.deepEqual(sourceIdentity(root).files.find(file => file.path === 'source.js'), { path: 'source.js', deleted: true });
});


test('real Git inventory above 1MiB remains complete and deterministic with exact file, mode, symlink, deleted and ignored semantics', t => {
    const crypto = require('node:crypto'), digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-identity-large-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet', root]);
    const expected = [];
    const write = (name, bytes, executable = false) => {
        fs.writeFileSync(path.join(root, name), bytes, { mode: executable ? 0o755 : 0o644 });
        expected.push({ path: name, kind: 'file', executable, sha256: digest(bytes) });
    };
    write('.gitignore', '*.secret\nignored/\n'); write('tracked.js', 'initial'); write('deleted.js', 'delete me');
    write('run.sh', '#!/bin/sh\nexit 0\n', true); write('retained.secret', 'tracked synthetic bytes');
    fs.symlinkSync('tracked.js', path.join(root, 'source-link'));
    expected.push({ path: 'source-link', kind: 'symlink', executable: true, sha256: digest('tracked.js') });
    execFileSync('git', ['add', '-f', '.gitignore', 'tracked.js', 'deleted.js', 'run.sh', 'retained.secret', 'source-link'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.js'), 'dirty current bytes'); expected.find(row => row.path === 'tracked.js').sha256 = digest('dirty current bytes');
    fs.unlinkSync(path.join(root, 'deleted.js')); expected.splice(expected.findIndex(row => row.path === 'deleted.js'), 1, { path: 'deleted.js', deleted: true });
    fs.writeFileSync(path.join(root, 'excluded.secret'), 'ignored secret canary'); fs.mkdirSync(path.join(root, 'ignored')); fs.writeFileSync(path.join(root, 'ignored', 'child.js'), 'ignored implementation');
    fs.mkdirSync(path.join(root, 'large'));
    for (let index = 0; index < 4500; index++) write(`large/input-${String(index).padStart(5, '0')}-${'x'.repeat(220)}.js`, `owned source ${index}\n`);
    const raw = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
    assert.ok(raw.length > 1024 * 1024, 'actual Git output must exceed the old default capacity');
    expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const identity = sourceIdentity(root);
    assert.deepEqual(identity.files, expected); assert.equal(identity.schemaVersion, 'pcm-source-identity/1');
    assert.equal(identity.sha256, digest(JSON.stringify(expected))); assert.deepEqual(sourceIdentity(root), identity);
    assert.ok(!JSON.stringify(identity).includes('ignored secret canary'));
    assert.equal(identity.files.length, 4506);
});

test('Git failures and unsupported tracked entries fail without returning a partial identity', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-identity-failure-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.throws(() => sourceIdentity(root), error => error.status === 128);
    execFileSync('git', ['init', '--quiet', root]); fs.writeFileSync(path.join(root, 'entry'), 'tracked');
    execFileSync('git', ['add', 'entry'], { cwd: root }); fs.unlinkSync(path.join(root, 'entry')); fs.mkdirSync(path.join(root, 'entry'));
    assert.throws(() => sourceIdentity(root), /Unsupported source entry: entry/);
});
