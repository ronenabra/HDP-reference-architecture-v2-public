'use strict';
/** Synthetic-only export regressions: fidelity, snapshots, failures and resource cleanup. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLogExport, prepareLogExport } = require('../src/log-export');
const { clearConfiguredLogs } = require('../src/log-clear');

const sources = [
    { dir: 'pcm-core', role: 'pcm' },
    { dir: 'ho-a-gateway', role: 'gateway' },
    { dir: 'extensions/app', label: 'App', role: 'application', external: true, format: 'hdp-jsonl' }
];
const record = message => ({ timestamp: '2026-10-12T00:00:00Z', level: 'INFO', message,
    details: { token: 'synthetic-non-AWS-token', patient: { id: 'synthetic-patient' },
        AWS_SECRET_ACCESS_KEY: 'SYNTHETIC_AWS_SECRET', nested: { access: 'AKIA1234567890123456' } } });

/** All reads and writes are contained in owned disposable synthetic fixture roots. */
function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'export-stream-test-'));
    const root = path.join(base, 'logs'), tempRoot = path.join(base, 'staging');
    fs.mkdirSync(root); fs.mkdirSync(tempRoot);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const write = (component, content, logFile = 'current.log') => {
        const filename = path.join(root, component, logFile);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
        return filename;
    };
    return { root, tempRoot, write };
}

/** Read a prepared artifact and assert that cleanup is idempotent and complete. */
async function resultFor(t, f, selected = sources, options = {}) {
    const prepared = await prepareLogExport(f.root, selected, { tempRoot: f.tempRoot, ...options });
    t.after(prepared.cleanup);
    const raw = fs.readFileSync(prepared.filename, 'utf8');
    assert.equal(Buffer.byteLength(raw), prepared.size);
    assert.equal(fs.statSync(prepared.filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(prepared.filename)).mode & 0o777, 0o700);
    const result = JSON.parse(raw);
    await prepared.cleanup(); await prepared.cleanup();
    assert.deepEqual(fs.readdirSync(f.tempRoot), []);
    return result;
}

test('streamed export matches legacy full history, malformed/raw/Unicode fidelity and AWS-only scrubbing', async t => {
    const f = fixture(t);
    for (let index = 0; index < 9; index++) f.write('pcm-core', JSON.stringify(record(`rotation-${index}`)), `history/${index}/app.log`);
    const long = JSON.stringify(record('界'.repeat(32_000) + '😀'.repeat(18_000)));
    f.write('pcm-core', ` \t\n${JSON.stringify(record('current'))}\n\n  \t\r\n ${long} \r\nmalformed non-AWS password=synthetic 保留 AKIA1234567890123456  \n \t\n\n`);
    f.write('ho-a-gateway', '2026/10/12 01:02:03 [error] 11#22: synthetic request failed, request: "GET /synthetic HTTP/1.1"\n', 'error.log');
    f.write(sources[2].dir, `${JSON.stringify(record('extension'))}\nmalformed external with SYNTHETIC_MUST_NOT_ESCAPE\n`);
    const expected = readLogExport(f.root, sources);
    const result = await resultFor(t, f);
    assert.deepEqual(result, expected);
    assert.equal(result.complete, true);
    assert.equal(result.logs['pcm-core'].length, 13);
    assert.match(JSON.stringify(result), /synthetic-non-AWS-token/);
    assert.match(JSON.stringify(result), /synthetic-patient/);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_AWS_SECRET|AKIA1234567890123456|SYNTHETIC_MUST_NOT_ESCAPE/);
});

for (const content of ['', ' \t\r\n\n', '\n\n{}\n\n', 'a\r\n\r\nb\r\n\r\n', ' \n{bad} \n\n\t']) {
    test(`whole-file trim and nonempty-line coordinates match legacy for ${JSON.stringify(content)}`, async t => {
        const f = fixture(t); f.write('pcm-core', content);
        assert.deepEqual(await resultFor(t, f, [sources[0]]), readLogExport(f.root, [sources[0]]));
    });
}

test('source failure rolls back all of its history without losing preceding healthy buffered output', async t => {
    const f = fixture(t);
    f.write('pcm-core', JSON.stringify(record('healthy')));
    const bad = f.write(sources[2].dir, JSON.stringify(record('unreadable')));
    f.write(sources[2].dir, JSON.stringify(record('must roll back')), 'history/old/app.log');
    // Deterministic I/O error after a source has already staged earlier history.
    const nativeRead = fs.read;
    const badInode = fs.statSync(bad).ino;
    t.mock.method(fs, 'read', function(fd, buffer, offset, length, position, callback) {
        if (fs.fstatSync(fd).ino === badInode) {
            const error = Object.assign(new Error('Synthetic source read failure'), { code: 'EIO' });
            return process.nextTick(() => callback(error));
        }
        return nativeRead.call(this, fd, buffer, offset, length, position, callback);
    });
    const result = await resultFor(t, f);
    assert.equal(result.complete, false);
    assert.deepEqual(result.logs['pcm-core'], readLogExport(f.root, [sources[0]]).logs['pcm-core']);
    assert.equal(Object.hasOwn(result.logs, sources[2].dir), false);
    assert.deepEqual(result.failures, [{ component: sources[2].dir, error: 'Synthetic source read failure' }]);
});

test('rejected dangling extension symlinks preserve healthy sources and explicit partial verdict', async t => {
    const f = fixture(t); f.write('pcm-core', JSON.stringify(record('healthy')));
    const bad = f.write(sources[2].dir, ''); fs.unlinkSync(bad); fs.symlinkSync('missing', bad);
    const result = await resultFor(t, f);
    assert.equal(result.complete, false);
    assert.equal(Object.hasOwn(result.logs, sources[2].dir), false);
    assert.match(result.failures[0].error, /symlink/);
    assert.equal(result.logs['pcm-core'][0].message, 'healthy');
});

test('append after snapshot is excluded and rename after safe open retains the captured descriptor', async t => {
    const f = fixture(t), first = JSON.stringify(record('snapshot')) + '\n';
    const filename = f.write('pcm-core', first);
    const nativeRead = fs.read;
    let changed = false;
    t.mock.method(fs, 'read', function(fd, ...args) {
        if (!changed) {
            changed = true;
            fs.appendFileSync(filename, JSON.stringify(record('late append')) + '\n');
            fs.renameSync(filename, filename + '.rotated');
            fs.writeFileSync(filename, JSON.stringify(record('new current')) + '\n');
        }
        return nativeRead.call(this, fd, ...args);
    });
    const result = await resultFor(t, f, [sources[0]]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.logs['pcm-core'].map(entry => entry.message), ['snapshot']);
});

for (const kind of ['replace', 'truncate']) {
    test(`${kind} during export cannot become a silently complete mixed source`, async t => {
        const f = fixture(t);
        f.write('pcm-core', JSON.stringify(record('history')), 'history/old/app.log');
        const current = f.write('pcm-core', JSON.stringify(record('current')));
        const nativeRead = fs.read;
        let changed = false;
        t.mock.method(fs, 'read', function(fd, ...args) {
            if (!changed) {
                changed = true;
                if (kind === 'replace') { fs.renameSync(current, current + '.old'); fs.writeFileSync(current, JSON.stringify(record('replacement'))); }
                if (kind === 'truncate') fs.truncateSync(current, 0);
            }
            return nativeRead.call(this, fd, ...args);
        });
        const result = await resultFor(t, f, [sources[0]]);
        assert.equal(result.complete, false);
        assert.equal(Object.hasOwn(result.logs, 'pcm-core'), false);
        assert.equal(result.failures[0].component, 'pcm-core');
    });
}

test('cancellation during staging closes source descriptors and removes the private temporary output', async t => {
    const f = fixture(t);
    f.write('pcm-core', (JSON.stringify(record('cancel')) + '\n').repeat(4000));
    const controller = new AbortController(), nativeRead = fs.read;
    let reads = 0, readFd;
    t.mock.method(fs, 'read', function(fd, ...args) {
        reads++; readFd = fd;
        const callback = args.pop();
        return nativeRead.call(this, fd, ...args, (...result) => { controller.abort(); callback(...result); });
    });
    await assert.rejects(prepareLogExport(f.root, [sources[0]], { tempRoot: f.tempRoot, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(reads, 1);
    assert.throws(() => fs.fstatSync(readFd), { code: 'EBADF' });
    assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('asynchronous chunk processing lets unrelated requests/timers run before staging completes', async t => {
    const f = fixture(t);
    f.write('pcm-core', (JSON.stringify(record('yield')) + '\n').repeat(10_000));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1); t.after(() => clearInterval(timer));
    const metrics = {};
    const result = await resultFor(t, f, [sources[0]], { metrics });
    assert.equal(result.logs['pcm-core'].length, 10_000);
    assert.ok(ticks > 2, `expected event-loop yields, observed ${ticks}`);
    assert.equal(metrics.records, 10_000);
    assert.ok(metrics.inputBytes > 1_000_000);
});

for (const phase of ['read', 'final close']) {
    test(`clear during ${phase} invalidates the entire prepared export and removes staging`, async t => {
        const f = fixture(t); f.write('pcm-core', JSON.stringify(record('clear me')));
        let changed = false;
        if (phase === 'read') {
            const nativeRead = fs.read;
            t.mock.method(fs, 'read', function(fd, ...args) {
                if (!changed) { changed = true; clearConfiguredLogs(f.root, [sources[0]]); }
                return nativeRead.call(this, fd, ...args);
            });
        } else {
            const nativeOpen = fs.promises.open;
            t.mock.method(fs.promises, 'open', async function(...args) {
                const handle = await nativeOpen.call(this, ...args), close = handle.close.bind(handle);
                handle.close = async () => {
                    await close();
                    if (!changed) { changed = true; clearConfiguredLogs(f.root, [sources[0]]); }
                };
                return handle;
            });
        }
        await assert.rejects(prepareLogExport(f.root, [sources[0]], { tempRoot: f.tempRoot }), { code: 'LOG_EXPORT_CHANGED' });
        assert.equal(changed, true);
        assert.deepEqual(fs.readdirSync(f.tempRoot), []);
    });
}

test('temporary disk failure is fatal, never mislabelled as a source failure, and cleans staging', async t => {
    const f = fixture(t); f.write('pcm-core', (JSON.stringify(record('disk')) + '\n').repeat(1000));
    const nativeOpen = fs.promises.open;
    let writes = 0, closed = false;
    t.mock.method(fs.promises, 'open', async function(...args) {
        const handle = await nativeOpen.call(this, ...args), write = handle.write.bind(handle), close = handle.close.bind(handle);
        handle.write = async (...values) => {
            if (++writes === 2) throw Object.assign(new Error('Synthetic staging disk full'), { code: 'ENOSPC' });
            return write(...values);
        };
        handle.close = async () => { await close(); closed = true; };
        return handle;
    });
    await assert.rejects(prepareLogExport(f.root, [sources[0]], { tempRoot: f.tempRoot }), { code: 'ENOSPC' });
    assert.equal(writes, 2); assert.equal(closed, true);
    assert.deepEqual(fs.readdirSync(f.tempRoot), []);
});

test('OTel nested AWS semantic keys remain scrubbed in normalized and raw export data', async t => {
    const f = fixture(t), source = { ...sources[2], format: 'otel-log-record' };
    const kv = (key, value) => ({ key, value: { stringValue: value } });
    const row = { timeUnixNano: '1791763200000000000', severityText: 'INFO',
        body: { kvlistValue: { values: [kv('AccessKeyId', 'synthetic-access'), kv('SecretAccessKey', 'synthetic-secret'), kv('SessionToken', 'synthetic-session')] } },
        attributes: [kv('AWS_SECRET_ACCESS_KEY', 'synthetic-aws-secret'), kv('x-amz-security-token', 'synthetic-security-token'), kv('non-aws-token', 'keep-synthetic')] };
    f.write(source.dir, JSON.stringify(row) + '\n');
    const result = await resultFor(t, f, [source]);
    assert.deepEqual(result, JSON.parse(JSON.stringify(readLogExport(f.root, [source]))));
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /synthetic-access|synthetic-secret|synthetic-session|synthetic-aws-secret|synthetic-security-token/);
    assert.match(output, /keep-synthetic/);
    assert.match(output, /AWS_CREDENTIAL_BLOCKED/);
    assert.equal(result.logs[source.dir][0].rawRedacted, true);
    assert.equal(result.logs[source.dir][0].details.visibility, 'diagnostic');
});
