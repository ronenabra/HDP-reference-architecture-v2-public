#!/usr/bin/env node
'use strict';
/** Compare full-export implementations on one owned synthetic fixture over loopback.
 * Usage: node scripts/benchmark-log-export.js --baseline /old/checkout --candidate /new/checkout --output /report.json
 * Each sample has a fresh server process. Runs are serial and counterbalanced;
 * client transfer hashing never retains the response body. No deployment is touched.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { once } = require('node:events');
const sources = [{ dir: 'pcm-core', role: 'pcm' }];

/** Run one fresh isolated server process; export handlers match the two implementations. */
async function worker(mode, checkout, root, tempRoot) {
    const express = require(path.join(checkout, 'node_modules/express'));
    const exporter = require(path.join(checkout, 'src/pcm-core/src/log-export'));
    const app = express();
    app.get('/ping', (_req, res) => res.end('ok'));
    app.get('/admin/logs/download', (req, res) => {
        if (req.get('x-admin-password') !== 'synthetic-benchmark-password') return res.status(401).end();
        const metrics = { mode, rssStart: process.memoryUsage().rss };
        const started = performance.now();
        let lastTick = started, maxEventLoopDelayMs = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - lastTick - 5); lastTick = now;
        }, 5);
        const close = new Promise(resolve => res.once('close', resolve));
        (async () => {
            if (mode === 'candidate') {
                await exporter.sendLogExport(req, res, root, sources, { metrics, tempRoot });
            } else {
                let readMs = 0, inputBytes = 0;
                const nativeRead = fs.readFileSync;
                fs.readFileSync = function(filename, ...args) {
                    const start = performance.now(), result = nativeRead.call(this, filename, ...args);
                    if (typeof filename === 'number') { readMs += performance.now() - start; inputBytes += Buffer.byteLength(result); }
                    return result;
                };
                let result;
                const start = performance.now();
                try { result = exporter.readLogExport(root, sources); }
                finally { fs.readFileSync = nativeRead; }
                metrics.readParseProjectMs = performance.now() - start;
                metrics.readMs = readMs; metrics.inputBytes = inputBytes;
                metrics.parseProjectMs = metrics.readParseProjectMs - readMs;
                metrics.records = Object.values(result.logs).reduce((sum, rows) => sum + rows.length, 0);
                metrics.rssAfterRead = process.memoryUsage().rss;
                const serialize = performance.now();
                // Express res.json performs this same serialization before .send.
                const body = JSON.stringify(result);
                metrics.serializeMs = performance.now() - serialize;
                metrics.rssAfterSerialize = process.memoryUsage().rss;
                res.status(result.complete ? 200 : 207).type('json').send(body);
                await close;
            }
            metrics.serverWorkMs = performance.now() - started;
            metrics.responseFinished = res.writableFinished;
            await new Promise(resolve => setTimeout(resolve, 20));
            clearInterval(timer);
            metrics.maxEventLoopDelayMs = maxEventLoopDelayMs;
            metrics.peakRss = process.resourceUsage().maxRSS * 1024;
            metrics.stagingRemaining = fs.readdirSync(tempRoot).length;
            process.send({ type: 'result', metrics });
        })().catch(error => { clearInterval(timer); process.send({ type: 'error', error: error.stack }); });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.send({ type: 'ready', port: server.address().port });
    process.on('message', message => {
        if (message === 'stop') { server.closeAllConnections(); server.close(() => process.exit(0)); }
    });
}

/** Await a typed IPC message without losing messages that arrive before the waiter. */
function mailbox(child) {
    const saved = [], waiting = [];
    child.on('message', message => {
        if (message.type === 'error') { for (const item of waiting.splice(0)) item.reject(new Error(message.error)); return; }
        const index = waiting.findIndex(item => item.type === message.type);
        if (index >= 0) waiting.splice(index, 1)[0].resolve(message); else saved.push(message);
    });
    return type => {
        const index = saved.findIndex(message => message.type === type);
        if (index >= 0) return Promise.resolve(saved.splice(index, 1)[0]);
        return new Promise((resolve, reject) => waiting.push({ type, resolve, reject }));
    };
}

/** Request a response while hashing chunks; retain timing/byte counts only. */
function download(port, abortAfterMs) {
    return new Promise((resolve, reject) => {
        const started = performance.now(), hash = createHash('sha256');
        let firstByteMs = null, bytes = 0, timer;
        const req = http.get({ host: '127.0.0.1', port, path: '/admin/logs/download', agent: false,
            headers: { 'x-admin-password': 'synthetic-benchmark-password' } }, res => {
            res.on('data', chunk => {
                if (firstByteMs === null) firstByteMs = performance.now() - started;
                bytes += chunk.length; hash.update(chunk);
            });
            res.on('end', () => {
                clearTimeout(timer);
                const totalMs = performance.now() - started;
                resolve({ httpStatus: res.statusCode, firstByteMs, totalMs, transferMs: totalMs - firstByteMs, bytes, sha256: hash.digest('hex') });
            });
            res.on('error', error => { if (!abortAfterMs) reject(error); });
        });
        req.setTimeout(10_000, () => req.destroy(new Error('10-second socket inactivity timeout')));
        req.on('error', error => {
            clearTimeout(timer);
            if (abortAfterMs) resolve({ cancelledAtMs: performance.now() - started, bytes }); else reject(error);
        });
        if (abortAfterMs) timer = setTimeout(() => req.destroy(new Error('Owned benchmark cancellation')), abortAfterMs);
    });
}

/** Measure health responsiveness with at most one concurrent independent HTTP request. */
function ping(port) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        http.get({ host: '127.0.0.1', port, path: '/ping', agent: false }, res => {
            res.resume(); res.on('end', () => resolve(performance.now() - start));
        }).on('error', reject);
    });
}

/** Execute one sample, ensuring its worker terminates even when verification fails. */
async function sample(mode, checkout, fixture, abortAfterMs = 0) {
    const child = fork(__filename, ['--worker', mode, checkout, fixture.root, fixture.tempRoot], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const next = mailbox(child);
    try {
        const { port } = await next('ready');
        let active = true;
        const pingTimes = [];
        const pings = (async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
            while (active) { pingTimes.push(await ping(port)); await new Promise(resolve => setTimeout(resolve, 25)); }
        })();
        const client = await download(port, abortAfterMs);
        const { metrics } = await next('result');
        active = false; await pings;
        return { mode, cancelled: Boolean(abortAfterMs), ...client, ...metrics,
            pingCount: pingTimes.length, maxPingMs: pingTimes.length ? Math.max(...pingTimes) : null };
    } finally {
        const exited = once(child, 'exit'); child.send('stop'); await exited;
    }
}

/** Populate retained JSONL history and current.log; the input is reused unchanged. */
function createFixture(base, bytes) {
    const root = path.join(base, 'logs'), tempRoot = path.join(base, 'staging');
    fs.mkdirSync(tempRoot, { recursive: true });
    const raw = JSON.stringify({ timestamp: '2026-10-01T00:00:00Z', level: 'INFO', message: 'Synthetic full-history performance record',
        details: { type: 'HTTP', token: 'synthetic-non-aws-token', payload: 'x'.repeat(800),
            patient: { resourceType: 'Patient', id: 'synthetic-export-patient', name: [{ family: 'Synthetic', given: ['Export'] }],
                identifier: [{ system: 'urn:synthetic:export', value: 'NOT-REAL' }] }, AWS_SECRET_ACCESS_KEY: 'SYNTHETIC_AWS_SECRET' } }) + '\n';
    const records = Math.ceil(bytes / Buffer.byteLength(raw)), hash = createHash('sha256');
    const groups = 9, count = Math.floor(records / groups), block = raw.repeat(1000);
    for (let index = 0; index < groups; index++) {
        const file = index === groups - 1 ? 'current.log' : `history/2026-10-${String(index + 1).padStart(2, '0')}/app.log`;
        const filename = path.join(root, 'pcm-core', file); fs.mkdirSync(path.dirname(filename), { recursive: true });
        const fd = fs.openSync(filename, 'w'), lines = index === groups - 1 ? records - count * index : count;
        for (let line = 0; line < lines; line += 1000) {
            const part = line + 1000 <= lines ? block : raw.repeat(lines - line);
            fs.writeSync(fd, part); hash.update(part);
        }
        fs.closeSync(fd);
    }
    return { root, tempRoot, inputBytes: records * Buffer.byteLength(raw), records, files: groups, sha256: hash.digest('hex') };
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--worker') return worker(...args.slice(1));
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2].replace(/^--/, ''), args[index * 2 + 1]]));
    if (!options.baseline || !options.candidate || !options.output) throw new Error('Supply --baseline, --candidate and --output');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hdp-export-benchmark-'));
    try {
        const fixture = createFixture(base, Number(options.bytes || 120_000_000));
        const samples = [];
        for (const mode of ['baseline', 'candidate', 'candidate', 'baseline']) {
            const result = await sample(mode, path.resolve(options[mode]), fixture); samples.push(result);
            process.stderr.write(`${mode}: ${result.firstByteMs.toFixed(0)} ms first byte, ${Math.round(result.peakRss / 1048576)} MiB peak RSS\n`);
        }
        const responsesMatch = samples.every(value => value.sha256 === samples[0].sha256 && value.bytes === samples[0].bytes);
        if (!responsesMatch) throw new Error('Matched fixture produced different export bytes');
        const cancellation = [];
        for (const mode of ['baseline', 'candidate']) cancellation.push(await sample(mode, path.resolve(options[mode]), fixture, 50));
        const { root, tempRoot, ...manifest } = fixture;
        const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
            fixture: manifest, method: 'Serial ABBA fresh Node processes; one unchanged synthetic 120 MB fixture; minimal Express loopback handler, not a deployed full-stack measurement',
            timeout: 'Unchanged 10,000 ms client socket-inactivity timer, not a wall-clock deadline', responsesMatch, samples, cancellation };
        fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
        fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
