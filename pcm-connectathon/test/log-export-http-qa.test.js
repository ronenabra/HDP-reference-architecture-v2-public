'use strict';
/** Independent loopback HTTP qualification using only owned synthetic logs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { installTestRuntime } = require('../../test-support/team-config');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-export-http-'));
const stagingRoot = path.join(base, 'temporary'); fs.mkdirSync(stagingRoot);
const priorTmp = process.env.TMPDIR, priorPassword = process.env.TEAM_ADMIN_PASSWORD;
process.env.TMPDIR = stagingRoot;
process.env.TEAM_ADMIN_PASSWORD = 'synthetic-qa-export-password';
const config = installTestRuntime({ observability: { sources: [{ id: 'qa-extension', label: 'QA extension', role: 'application', format: 'hdp-jsonl' }] } });
const root = process.env.SHARED_LOGS_DIR;
const sources = require('../../src/pcm-core/src/log-ordering').configuredLogComponents(config);
const { readLogExport } = require('../../src/pcm-core/src/log-export');
let server;
const stageDirectories = () => fs.readdirSync(stagingRoot).filter(name => name.startsWith('pcm-log-export-'));
const write = (source, contents, file = 'current.log') => {
    const target = path.join(root, source, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); return target;
};
const record = message => ({ timestamp: '2026-10-12T00:00:00Z', level: 'INFO', message,
    details: { token: 'synthetic-non-AWS-token', patientId: 'synthetic-patient', AWS_SECRET_ACCESS_KEY: 'FAKE_QA_AWS_SECRET' } });
async function until(predicate, description) {
    const expires = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > expires) throw new Error(description); await delay(5); }
}
function request(route, password = 'synthetic-qa-export-password', method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
            headers: { Accept: 'application/json', ...(password ? { 'x-admin-password': password } : {}) } }, res => {
            const chunks = []; res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, json: JSON.parse(bytes.toString('utf8')) }); });
            res.on('error', reject);
        }); req.on('error', reject); req.end();
    });
}
function startExport(onResponse) {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/admin/logs/download',
        headers: { 'x-admin-password': 'synthetic-qa-export-password' } }, onResponse);
    // Deliberately destroyed synthetic client sockets produce expected ECONNRESET.
    req.on('error', error => { if (!['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) throw error; });
    return req;
}

test.before(async () => { server = require('../../src/pcm-core/src/index').createUiApp().listen(0, '127.0.0.1'); await once(server, 'listening'); });
test.after(async () => {
    server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve));
    if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp;
    if (priorPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = priorPassword;
    fs.rmSync(base, { recursive: true, force: true });
});

test('real HTTP export enforces both route auth boundaries and preserves complete full-history projection', async () => {
    const lines = [JSON.stringify(record('Unicode 保留 😀')), 'null', '42', '[1,"two"]', 'malformed non-AWS cookie=synthetic 保留', JSON.stringify(record('界'.repeat(30_000)))];
    write('pcm-core', ` \r\n${lines.join('\r\n')}\r\n \t\r\n`);
    for (let rotation = 0; rotation < 8; rotation++) write('pcm-core', JSON.stringify(record(`rotation-${rotation}`)), `history/${rotation}/app.log`);
    write('extensions/qa-extension', JSON.stringify(record('extension')));
    const expected = readLogExport(root, sources);
    for (const route of ['/admin/logs', '/admin/logs/download']) {
        assert.equal((await request(route, null)).status, 401);
        assert.equal((await request(route, 'wrong-synthetic-password')).status, 401);
        const result = await request(route);
        assert.equal(result.status, 200); assert.deepEqual(result.json, expected);
        assert.equal(Number(result.headers['content-length']), result.bytes.length);
        assert.match(result.headers['content-type'], /application\/json/);
        assert.match(result.bytes.toString(), /synthetic-non-AWS-token|synthetic-patient/);
        assert.doesNotMatch(result.bytes.toString(), /FAKE_QA_AWS_SECRET/);
        await until(() => !stageDirectories().length, 'completed export staging was not removed');
    }
});

test('real HTTP partial207 omits a rejected source and recovers without poisoning healthy sources', async () => {
    const extension = path.join(root, 'extensions/qa-extension/current.log');
    fs.renameSync(extension, extension + '.backup'); fs.symlinkSync('nonexistent-owned-fixture', extension);
    for (const route of ['/admin/logs', '/admin/logs/download']) {
        const result = await request(route);
        assert.equal(result.status, 207); assert.equal(result.json.complete, false); assert.equal(result.json.status, 'partial');
        assert.ok(result.json.logs['pcm-core'].some(row => row.message === 'Unicode 保留 😀'));
        assert.equal(Object.hasOwn(result.json.logs, 'extensions/qa-extension'), false);
        assert.deepEqual(result.json.failures.map(failure => failure.component), ['extensions/qa-extension']);
        await until(() => !stageDirectories().length, 'partial export staging was not removed');
    }
    fs.unlinkSync(extension); fs.renameSync(extension + '.backup', extension);
    assert.equal((await request('/admin/logs/download')).status, 200);
    await until(() => !stageDirectories().length, 'recovered export staging was not removed');
});

test('real client cancellation before headers interrupts staging while bounded browsing stays responsive', async t => {
    const filename = write('pcm-core', '');
    const line = JSON.stringify({ ...record('large owned fixture'), payload: 'synthetic-text-'.repeat(80) }) + '\n';
    const fd = fs.openSync(filename, 'w');
    try { for (let part = 0; part < 160; part++) fs.writeSync(fd, line.repeat(256)); } finally { fs.closeSync(fd); }
    let responded = false;
    const req = startExport(res => { responded = true; res.resume(); }); t.after(() => req.destroy());
    await until(() => stageDirectories().length > 0, 'export did not create a private staging directory');
    const directory = path.join(stagingRoot, stageDirectories()[0]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    const started = Date.now(); const browse = await request('/api/unified-logs?page=true&diagnostics=true');
    assert.equal(browse.status, 200); assert.ok(browse.json.entries.length <= 200); assert.ok(browse.json.bytesRead <= 1048576);
    assert.ok(Date.now() - started < 2000, 'bounded browse exceeded unchanged two-second budget during export');
    assert.equal(responded, false, 'fixture must still be staging when cancelled; this is not a transfer-cancellation test');
    req.destroy();
    await until(() => !stageDirectories().length, 'cancelled staging directory leaked');
    assert.equal((await request('/api/unified-logs?page=true')).status, 200);
});

test('real paused transfer applies socket backpressure and disconnect removes its staged file', async t => {
    let response;
    const headers = new Promise(resolve => {
        const req = startExport(res => { response = res; res.pause(); resolve(res); });
        t.after(() => { response?.destroy(); req.destroy(); });
    });
    const res = await headers;
    assert.equal(res.statusCode, 200); assert.ok(Number(res.headers['content-length']) > 40_000_000);
    await delay(150);
    assert.equal(stageDirectories().length, 1, 'slow client should keep the >40MB transfer staged while backpressured');
    const staged = path.join(stagingRoot, stageDirectories()[0], 'export.json');
    assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
    assert.equal((await request('/api/unified-logs?page=true')).status, 200);
    res.destroy();
    await until(() => !stageDirectories().length, 'disconnected download left its private staging file');
});


test('real authenticated clear during preparation rejects the whole export with409 and permits a fresh snapshot', async () => {
    const pending = request('/admin/logs/download');
    await until(() => stageDirectories().length > 0, 'clear race did not enter export staging');
    const cleared = await request('/admin/logs/clear', 'synthetic-qa-export-password', 'POST');
    assert.equal(cleared.status, 200); assert.equal(cleared.json.status, 'cleared');
    const stale = await pending;
    assert.equal(stale.status, 409); assert.match(stale.json.error, /cleared during export/);
    assert.equal(Object.hasOwn(stale.json, 'logs'), false);
    await until(() => !stageDirectories().length, 'clear-invalidated export staging leaked');
    const fresh = await request('/admin/logs/download');
    assert.equal(fresh.status, 200); assert.equal(fresh.json.complete, true);
    assert.equal(fresh.json.logs['pcm-core'].length, 0);
    assert.ok(fresh.json.logs['extensions/qa-extension'].some(row => row.message === 'extension'));
    await until(() => !stageDirectories().length, 'fresh export staging leaked');
});
