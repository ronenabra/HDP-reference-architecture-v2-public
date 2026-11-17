'use strict';

/** Native log startup preflight must be scoped and detect inaccessible reused mounts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { permits, prepareHapiLogMounts } = require('../scripts/hapi-log-preflight');

test('service access respects owner/group/other bits rather than host writability', () => {
    const stat = { uid: 1001, gid: 1002, mode: 0o750 };
    assert.equal(permits(stat, 1001, 9999, 7), true);
    assert.equal(permits(stat, 1000, 1002, 7), false);
    assert.equal(permits(stat, 1000, 1003, 7), false);
});

test('fresh and reused logs are checked without touching data or following symlinks', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-logs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const uid = process.getuid();
    const gid = process.getgid();
    fs.mkdirSync(path.join(root, 'state'));
    fs.writeFileSync(path.join(root, 'state', 'owner'), 'keep');
    const directory = path.join(root, 'logs', 'ho-a-hapi');
    assert.deepEqual(prepareHapiLogMounts(root, [{ id: 'ho-a' }], uid, gid), [directory, path.join(root, 'logs', 'ho-a-hapi-runtime')]);
    const file = path.join(directory, 'current.log');
    fs.writeFileSync(file, 'keep logs');
    assert.deepEqual(prepareHapiLogMounts(root, [{ id: 'ho-a' }], uid, gid), [directory, file, path.join(root, 'logs', 'ho-a-hapi-runtime')]);
    assert.throws(() => prepareHapiLogMounts(root, [{ id: 'ho-a' }], uid + 10000, gid + 10000), /not writable by service.*correct ownership/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep logs');
    assert.equal(fs.readFileSync(path.join(root, 'state', 'owner'), 'utf8'), 'keep');
    fs.symlinkSync(path.join(root, 'state', 'owner'), path.join(directory, 'link'));
    assert.throws(() => prepareHapiLogMounts(root, [{ id: 'ho-a' }], uid, gid), /must not be a symlink/);
});


test('a symlinked log root is rejected before creating any unrelated HO directory', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-log-parent-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const team = path.join(root, 'team');
    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(team);
    fs.mkdirSync(unrelated);
    fs.symlinkSync(unrelated, path.join(team, 'logs'));
    assert.throws(() => prepareHapiLogMounts(team, [{ id: 'ho-a' }], process.getuid(), process.getgid()), /log root must not be a symlink/);
    assert.deepEqual(fs.readdirSync(unrelated), []);
});

test('service must traverse the shared log parent even when its HO directory is writable', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hapi-log-traverse-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const logRoot = path.join(root, 'logs');
    const directory = path.join(logRoot, 'ho-a-hapi');
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(logRoot, 0o700);
    fs.chmodSync(directory, 0o777);
    assert.throws(() => prepareHapiLogMounts(root, [{ id: 'ho-a' }], process.getuid() + 10000, process.getgid() + 10000), /not traversable by service/);
});
