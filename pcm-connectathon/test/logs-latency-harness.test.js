'use strict';

/** Guard the matched benchmark's acceptance threshold and reproducibility contract. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { THRESHOLD_MS, parseArgs, summarize, fixtureIdentity } = require('../ui/qualify-logs-latency');

test('benchmark requires two source roots and does not expose a threshold waiver', () => {
    const options = parseArgs(['--parent', '/tmp/parent', '--candidate', '/tmp/candidate', '--output', '/tmp/benchmark.json']);
    assert.equal(options.pairs, 3);
    assert.equal(options['warm-runs'], 2);
    assert.equal(THRESHOLD_MS, 2000);
    const base = ['--parent', '/tmp/parent', '--candidate', '/tmp/candidate', '--output', '/tmp/benchmark.json'];
    for (const extra of [['--threshold', '9999'], ['--pairs', '0'], ['--warm-runs', '1.5'], ['--pairs', '1', '--pairs', '2']]) {
        assert.throws(() => parseArgs([...base, ...extra]));
    }
    assert.throws(() => parseArgs(['--parent', '/tmp/same', '--candidate', '/tmp/same', '--output', '/tmp/out.json']));
    assert.throws(() => parseArgs(['--parent', '/tmp/parent']));
});

test('a slow sample or missing phase cannot be hidden by a fast median', () => {
    const samples = [100, 200, 4271].map(milliseconds => ({ variant: 'candidate', phase: 'cold', milliseconds }));
    samples.push({ variant: 'parent', phase: 'warm', milliseconds: 2000 });
    const result = summarize(samples);
    assert.equal(result.candidate.cold.medianMs, 200);
    assert.equal(result.candidate.cold.p95Ms, 4271);
    assert.equal(result.candidate.cold.everySampleUnder2000ms, false);
    assert.equal(result.parent.warm.everySampleUnder2000ms, false);
    assert.equal(result.parent.cold.count, 0);
    assert.equal(result.parent.cold.medianMs, null);
    assert.equal(result.parent.cold.everySampleUnder2000ms, false);
    assert.equal(summarize([{ variant: 'parent', phase: 'cold', milliseconds: 1999 }]).parent.cold.everySampleUnder2000ms, true);
});

test('parent and candidate must have byte-identical fixture generators', t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'log-benchmark-contract-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const roots = ['parent', 'candidate'].map(name => path.join(temporary, name));
    for (const root of roots) {
        fs.mkdirSync(path.join(root, 'pcm-connectathon/ui'), { recursive: true });
        fs.writeFileSync(path.join(root, 'pcm-connectathon/ui/ops-fixture-server.js'), 'same fixture\n');
    }
    assert.equal(fixtureIdentity(...roots).expectedRecords, 10500);
    fs.appendFileSync(path.join(roots[1], 'pcm-connectathon/ui/ops-fixture-server.js'), 'changed\n');
    assert.throws(() => fixtureIdentity(...roots), /fixture files differ/);
});
