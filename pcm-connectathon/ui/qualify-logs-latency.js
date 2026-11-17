#!/usr/bin/env node
'use strict';

/** Matched serial cold/warm qualification of the maintained real operator fixture.
 * Run with idle application/browser test hosts. Cold means fresh server/browser
 * processes and context, not a privileged operating-system disk-cache flush.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const THRESHOLD_MS = 2000;
const PLAYWRIGHT_VERSION = '1.62.1';
const FIXTURE_PATH = 'pcm-connectathon/ui/ops-fixture-server.js';

/** Reject ambiguous inputs rather than comparing different fixtures or weakening the gate. */
function parseArgs(argv) {
    const allowed = new Set(['parent', 'candidate', 'output', 'pairs', 'warm-runs', 'fixture-node', 'executable-path']);
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index]?.replace(/^--/, '');
        if (!argv[index]?.startsWith('--') || !allowed.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--') || key in values) {
            throw new Error(`Expected a unique --option value; received ${argv[index]}`);
        }
        values[key] = argv[index + 1];
    }
    for (const key of ['parent', 'candidate', 'output']) if (!values[key]) throw new Error(`--${key} is required`);
    for (const [key, fallback] of [['pairs', 3], ['warm-runs', 2]]) {
        values[key] = values[key] === undefined ? fallback : Number(values[key]);
        if (!Number.isSafeInteger(values[key]) || values[key] < 1 || values[key] > 20) throw new Error(`--${key} must be an integer from 1 to 20`);
    }
    for (const key of ['parent', 'candidate', 'output']) values[key] = path.resolve(values[key]);
    if (values.parent === values.candidate) throw new Error('Parent and candidate must be separate source directories');
    values['fixture-node'] ||= process.execPath;
    return values;
}

/** Keep per-sample acceptance: a median below target never hides a slow first render. */
function summarize(samples) {
    const result = {};
    for (const variant of ['parent', 'candidate']) {
        result[variant] = {};
        for (const phase of ['cold', 'warm']) {
            const values = samples.filter(sample => sample.variant === variant && sample.phase === phase)
                .map(sample => sample.milliseconds).sort((a, b) => a - b);
            const middle = Math.floor(values.length / 2);
            result[variant][phase] = {
                count: values.length,
                medianMs: values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null,
                p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
                maxMs: values.length ? values.at(-1) : null,
                everySampleUnder2000ms: values.length > 0 && values.every(value => value < THRESHOLD_MS)
            };
        }
    }
    return result;
}

/** Both revisions must execute byte-identical maintained fixture generation code. */
function fixtureIdentity(parent, candidate) {
    const hash = root => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, FIXTURE_PATH))).digest('hex');
    const parentHash = hash(parent);
    if (hash(candidate) !== parentHash) throw new Error('Parent/candidate operator fixture files differ; qualification requires the same fixture');
    return { path: FIXTURE_PATH, sha256: parentHash, expectedRecords: 10500, expectedComponents: 14 };
}

/** Capture host contention instead of silently calling a busy host controlled. */
function hostSample() {
    return { at: new Date().toISOString(), loadAverage: os.loadavg(), freeMemoryBytes: os.freemem(),
        cpuTimes: os.cpus().map(cpu => cpu.times) };
}

/** Revision/dirty metadata is evidence only; no checkout, fetch, or state modification. */
function sourceIdentity(root) {
    const git = args => {
        const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
        return result.status === 0 ? result.stdout.trim() : null;
    };
    return { root, commit: git(['rev-parse', 'HEAD']), workingTree: git(['status', '--short']) };
}

/** Shut down only a child created by this run and wait before starting the next one. */
async function stopFixture(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await stopped; } finally { clearTimeout(force); }
}

/** Wait for the fixture's own readiness record, never a listener belonging to another run. */
function startFixture(root, executable) {
    const child = spawn(executable, [path.join(root, FIXTURE_PATH)], {
        cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    const ready = new Promise((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => reject(new Error('Owned operator fixture did not become ready within 30 seconds')), 30000);
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Owned operator fixture exited (${code}): ${stderr}`)); });
        child.stdout.on('data', data => {
            buffer += data;
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                try {
                    const metadata = JSON.parse(line);
                    if (metadata.url && metadata.records) { clearTimeout(timeout); resolve(metadata); }
                } catch (_) { /* Fixture logger output is not a readiness record. */ }
            }
        });
    });
    return { child, ready };
}

/** Alternate A/B and B/A blocks; never run candidate and parent servers concurrently. */
async function qualify(options) {
    const output = {
        schemaVersion: 1, startedAt: new Date().toISOString(), status: 'blocked', thresholdMs: THRESHOLD_MS,
        qualification: options['executable-path'] ? 'supplemental-custom-browser' : 'pinned-playwright-browser',
        coldDefinition: 'Fresh server/browser processes and context; first navigation. OS filesystem caches are not flushed.',
        measurement: 'Date.now before page.goto through the first visible .log-row, matching ui-ops-rem.spec.js',
        policy: 'Every measured navigation must be strictly below 2000 ms. No threshold override. Stop unrelated suites before running.',
        host: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model,
            logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), harnessNode: process.version },
        sources: { parent: sourceIdentity(options.parent), candidate: sourceIdentity(options.candidate) },
        pairs: options.pairs, warmRunsPerBlock: options['warm-runs'], samples: []
    };
    const write = () => {
        output.summary = summarize(output.samples);
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
        fs.writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`);
    };
    try {
        output.fixture = fixtureIdentity(options.parent, options.candidate);
        const actualVersion = require('playwright/package.json').version;
        if (actualVersion !== PLAYWRIGHT_VERSION) throw new Error(`Expected Playwright ${PLAYWRIGHT_VERSION}, found ${actualVersion}; run npm ci in pcm-connectathon/ui`);
        const { chromium, expect } = require('@playwright/test');
        output.playwrightVersion = actualVersion;
        const fixtureVersion = spawnSync(options['fixture-node'], ['--version'], { encoding: 'utf8' });
        if (fixtureVersion.status !== 0) throw new Error('Could not identify the shared fixture Node executable');
        output.fixtureNode = { executable: options['fixture-node'], version: fixtureVersion.stdout.trim() };
        for (let pair = 0; pair < options.pairs; pair++) {
            const order = pair % 2 ? ['candidate', 'parent'] : ['parent', 'candidate'];
            for (const variant of order) {
                let browser;
                let fixture;
                try {
                    browser = await chromium.launch({ headless: true,
                        ...(options['executable-path'] ? { executablePath: options['executable-path'] } : {}) });
                    output.browser = { version: browser.version(), executable: options['executable-path'] || chromium.executablePath() };
                    fixture = startFixture(options[variant], options['fixture-node']);
                    const metadata = await fixture.ready;
                    if (metadata.records !== 10500 || metadata.components !== 14) throw new Error(`Unexpected ${variant} fixture size: ${metadata.records}/${metadata.components}`);
                    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
                    const pageErrors = [];
                    page.on('pageerror', error => pageErrors.push(error.message));
                    for (let run = 0; run <= options['warm-runs']; run++) {
                        const before = hostSample();
                        const started = Date.now();
                        await page.goto(`${metadata.url}/logs-view?diagnostics=true`);
                        await expect(page.locator('.log-row').first()).toBeVisible({ timeout: 30000 });
                        const milliseconds = Date.now() - started;
                        const rows = await page.locator('.log-row').count();
                        if (rows > 200) throw new Error(`${variant} exceeded the unchanged 200-row bound`);
                        if (pageErrors.length) throw new Error(`${variant} page errors: ${pageErrors.join('; ')}`);
                        output.samples.push({ pair, variant, phase: run === 0 ? 'cold' : 'warm', run,
                            milliseconds, rows, timings: await page.evaluate(() => window.logPageTimings), before, after: hostSample() });
                        write();
                    }
                } finally {
                    try { if (browser) await browser.close(); }
                    finally { await stopFixture(fixture?.child); }
                }
            }
        }
        output.status = output.samples.every(sample => sample.milliseconds < THRESHOLD_MS) ? 'pass' : 'target-missed';
        output.acceptanceQualified = output.status === 'pass' && !options['executable-path'];
        output.finishedAt = new Date().toISOString();
        write();
        return output;
    } catch (error) {
        output.error = error.message;
        output.acceptanceQualified = false;
        output.finishedAt = new Date().toISOString();
        write();
        throw error;
    }
}

if (require.main === module) {
    (async () => {
        const options = parseArgs(process.argv.slice(2));
        const result = await qualify(options);
        console.log(JSON.stringify({ status: result.status, qualification: result.qualification,
            acceptanceQualified: result.acceptanceQualified, output: options.output, summary: result.summary }, null, 2));
        if (result.status !== 'pass') process.exitCode = 1;
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { THRESHOLD_MS, parseArgs, summarize, fixtureIdentity };
