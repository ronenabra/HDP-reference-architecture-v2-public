'use strict';
/** Regression for rejected extensions without weakening selected-source safety. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { readUnifiedPage, readUnifiedDetail } = require('../src/unified-log-page');
const { readLogExport } = require('../src/log-export');
const { openLogFile } = require('../src/log-source');
const sources = [
    { dir: 'pcm-core', label: 'PCM Core', role: 'pcm' },
    { dir: 'extensions/rejected', label: 'Rejected extension', role: 'security', external: true, format: 'hdp-jsonl' }
];
const record = message => ({ timestamp: '2026-10-08T00:00:00Z', level: 'INFO', message,
    details: { type: 'REQUEST', token: 'synthetic-non-aws-token', AWS_SECRET_ACCESS_KEY: 'FAKE_ISOLATION_SECRET' } });

/** Populate only owned synthetic logs, returning pre-fault selected references. */
function fixture(t, root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-isolation-'))) {
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (source, value, file = 'current.log') => {
        const target = path.join(root, source, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(value) + '\n');
        return target;
    };
    write('pcm-core', record('healthy'));
    const extension = write('extensions/rejected', record('extension'));
    const page = readUnifiedPage(root, sources, { diagnostics: 'true' });
    return { root, write, extension, references: Object.fromEntries(page.entries.map(row => [row.component, row.reference])) };
}

for (const kind of ['relative-valid', 'dangling', 'directory']) {
    test(`rejected ${kind} extension isolates healthy detail and honest full export`, t => {
        const f = fixture(t);
        if (kind === 'directory') {
            fs.renameSync(path.dirname(f.extension), path.dirname(f.extension) + '-backup');
            fs.symlinkSync('rejected-backup', path.dirname(f.extension), 'dir');
        } else {
            fs.renameSync(f.extension, f.extension + '.backup');
            fs.symlinkSync(kind === 'relative-valid' ? 'current.log.backup' : 'missing.log', f.extension);
        }
        const page = readUnifiedPage(f.root, sources, { diagnostics: 'true' });
        assert.deepEqual(page.entries.map(row => row.message), ['healthy']);
        assert.equal(page.sources.find(source => source.componentId === sources[1].dir).state, 'error');
        assert.ok(page.coverage.reasons.includes('unreadable-streams'));
        assert.ok(page.failures.some(failure => failure.component === sources[1].dir));
        const detail = readUnifiedDetail(f.root, sources, f.references['PCM Core']);
        assert.equal(detail.message, 'healthy');
        assert.equal(detail.details.token, 'synthetic-non-aws-token');
        assert.doesNotMatch(JSON.stringify(detail), /FAKE_ISOLATION_SECRET/);
        assert.throws(() => readUnifiedDetail(f.root, sources, f.references['Rejected extension']), /symlinks/);
        const result = readLogExport(f.root, sources);
        assert.equal(result.status, 'partial');
        assert.equal(result.complete, false);
        assert.equal(result.logs['pcm-core'][0].message, 'healthy');
        assert.equal(Object.hasOwn(result.logs, sources[1].dir), false);
        assert.deepEqual(result.failures.map(item => item.component), [sources[1].dir]);
        assert.match(result.failures[0].error, /symlinks/);
        assert.doesNotMatch(JSON.stringify(result), /FAKE_ISOLATION_SECRET/);
    });
}

test('full export reads all rotations, identifies non-file failures and recovers after repair', t => {
    const f = fixture(t);
    for (let index = 0; index < 8; index++) f.write('pcm-core', record(`history-${index}`), `history/${index}/app.log`);
    fs.unlinkSync(f.extension);
    fs.mkdirSync(f.extension);
    let result = readLogExport(f.root, sources);
    assert.equal(result.complete, false);
    assert.equal(result.logs['pcm-core'].length, 9);
    assert.equal(result.failures.length, 1);
    fs.rmdirSync(f.extension);
    f.write(sources[1].dir, record('restored'));
    result = readLogExport(f.root, sources);
    assert.equal(result.complete, true);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.failures, []);
    assert.equal(result.logs[sources[1].dir][0].message, 'restored');
});

test('untrusted selected references cannot escape a registered source', t => {
    const f = fixture(t);
    const original = JSON.parse(Buffer.from(f.references['PCM Core'], 'base64url').toString());
    for (const name of ['pcm-core/../extensions/rejected/current.log', 'pcm-core-foreign/current.log', '/etc/passwd', '../current.log']) {
        const reference = Buffer.from(JSON.stringify({ ...original, name })).toString('base64url');
        assert.throws(() => readUnifiedDetail(f.root, sources, reference), /Invalid/);
    }
    assert.throws(() => readUnifiedDetail(f.root, sources, Buffer.from('null').toString('base64url')), /Invalid/);
});

for (const dangling of [false, true]) {
    test(`extension history rotation symlink is reported, including dangling=${dangling}`, t => {
        const f = fixture(t);
        f.write(sources[1].dir, record('rotation'), 'history/real/app.log');
        fs.symlinkSync(dangling ? 'missing' : 'real', path.join(f.root, sources[1].dir, 'history/linked'), 'dir');
        const page = readUnifiedPage(f.root, sources, { diagnostics: 'true' });
        assert.ok(page.failures.some(item => item.component === sources[1].dir && /symlinks/.test(item.error)));
        assert.equal(readUnifiedDetail(f.root, sources, f.references['PCM Core']).message, 'healthy');
        const exported = readLogExport(f.root, sources);
        assert.equal(exported.complete, false);
        assert.equal(Object.hasOwn(exported.logs, sources[1].dir), false);
        assert.match(exported.failures[0].error, /symlinks/);
    });
}

test('built-in permission failures cannot masquerade as complete empty exports', t => {
    const f = fixture(t);
    // Deterministic EACCES simulation also exercises privileged CI hosts where
    // chmod(000) alone cannot stop root from reading a fixture directory.
    const originalStat = fs.statSync;
    t.mock.method(fs, 'statSync', function(filename, ...args) {
        if (String(filename).startsWith(path.join(f.root, 'pcm-core') + path.sep)) {
            const error = new Error('Permission denied for configured log source');
            error.code = 'EACCES'; throw error;
        }
        return originalStat.call(this, filename, ...args);
    });
    const exported = readLogExport(f.root, sources);
    assert.equal(exported.complete, false);
    assert.deepEqual(exported.failures.map(item => item.component), ['pcm-core']);
    assert.equal(Object.hasOwn(exported.logs, 'pcm-core'), false);
    assert.equal(exported.logs[sources[1].dir][0].message, 'extension');
    const page = readUnifiedPage(f.root, sources, { diagnostics: 'true' });
    assert.ok(page.failures.some(item => item.component === 'pcm-core'));
});

test('ordinary-file checks reject FIFOs before opening and nonblocking safe-open covers a last-moment swap', t => {
    const f = fixture(t);
    const nativeStat = fs.statSync(f.extension);
    const fifoStat = { isFile: () => false, isSymbolicLink: () => false, dev: nativeStat.dev, ino: nativeStat.ino };
    const originalStat = fs.statSync;
    t.mock.method(fs, 'statSync', function(filename, ...args) {
        return filename === f.extension ? fifoStat : originalStat.call(this, filename, ...args);
    });
    const exported = readLogExport(f.root, sources);
    assert.equal(exported.complete, false);
    assert.match(exported.failures[0].error, /not a regular file/);
    assert.equal(exported.logs['pcm-core'][0].message, 'healthy');
    t.mock.restoreAll();
    let closed = false;
    const io = {
        lstatSync: fs.lstatSync.bind(fs),
        openSync(filename, flags) {
            assert.equal(filename, f.extension);
            if (typeof fs.constants.O_NONBLOCK === 'number') assert.ok(flags & fs.constants.O_NONBLOCK);
            assert.ok(flags & fs.constants.O_NOFOLLOW);
            return 123;
        },
        fstatSync: () => fifoStat,
        closeSync(fd) { assert.equal(fd, 123); closed = true; }
    };
    assert.throws(() => openLogFile(f.root, { component: sources[1], filename: f.extension }, io), /changed while opening/);
    assert.equal(closed, true);
});

/** Use plain HTTP against the actual UI app; no Docker or live clinical claim. */
function request(server, route, authenticated = false) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.address().port, path: route,
            headers: authenticated ? { 'x-admin-password': 'synthetic-isolation-password' } : {} }, res => {
            let body = ''; res.setEncoding('utf8'); res.on('data', value => { body += value; });
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
        });
        req.on('error', reject);
    });
}

test('actual HTTP listener keeps healthy detail 200, rejected detail 409 and authenticated partial export 207', async t => {
    require('../../../test-support/team-config').installTestRuntime({ observability: { sources: [
        { id: 'rejected', label: 'Rejected extension', role: 'security', format: 'hdp-jsonl' }
    ] } });
    const previousPassword = process.env.TEAM_ADMIN_PASSWORD;
    process.env.TEAM_ADMIN_PASSWORD = 'synthetic-isolation-password';
    t.after(() => { if (previousPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previousPassword; });
    const f = fixture(t, process.env.SHARED_LOGS_DIR);
    const server = require('../src/index').createUiApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const pageBefore = await request(server, '/api/unified-logs?page=true&diagnostics=true');
    assert.equal(pageBefore.status, 200);
    const reference = message => pageBefore.body.entries.find(row => row.message === message).reference;
    fs.renameSync(f.extension, f.extension + '.backup');
    fs.symlinkSync('current.log.backup', f.extension);
    const pageAfter = await request(server, '/api/unified-logs?page=true&diagnostics=true');
    assert.equal(pageAfter.status, 200);
    assert.ok(pageAfter.body.failures.some(item => item.component === sources[1].dir));
    assert.equal((await request(server, `/api/unified-logs/detail?reference=${encodeURIComponent(reference('healthy'))}`)).status, 200);
    assert.equal((await request(server, `/api/unified-logs/detail?reference=${encodeURIComponent(reference('extension'))}`)).status, 409);
    for (const route of ['/admin/logs', '/admin/logs/download']) {
        assert.equal((await request(server, route)).status, 401);
        const exported = await request(server, route, true);
        assert.equal(exported.status, 207);
        assert.equal(exported.body.complete, false);
        assert.equal(exported.body.status, 'partial');
        assert.equal(exported.body.logs['pcm-core'][0].message, 'healthy');
        assert.equal(Object.hasOwn(exported.body.logs, sources[1].dir), false);
        assert.ok(exported.body.failures.some(item => item.component === sources[1].dir));
    }
    fs.unlinkSync(f.extension); fs.renameSync(f.extension + '.backup', f.extension);
    const restored = await request(server, '/admin/logs/download', true);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.complete, true);
    assert.deepEqual(restored.body.failures, []);
});
