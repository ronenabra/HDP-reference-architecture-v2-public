'use strict';

/** Public qualification accepts fresh work and rejects historical pass reuse. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertFreshRun, main } = require('../scripts/run-full-verification');
const { reportTests } = require('../scripts/browser-report');

test('fresh configuration remains admissible', () => {
    assert.doesNotThrow(() => assertFreshRun({ 'run-id': '20261117T120000Z', 'no-build': true }));
});

test('retired and unknown continuation flags fail before setup', async () => {
    for (const mode of ['fast-gate', 'browser-repair', 'source-form-repair', 'strict-demo', 'doctor-help', 'mtls-gateway', 'unknown']) {
        await assert.rejects(main(['node', 'verify', `--resume-${mode}`, '/does/not/exist']), /start a fresh full verification run/);
    }
});

test('report traversal retains nested project identities and live result objects', () => {
    const result = { projectName: 'mobile', results: [{ status: 'failed' }] };
    const rows = reportTests({ suites: [{ suites: [{ specs: [{ file: 'flow.spec.js', title: 'authorization', tests: [result] }] }] }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'flow.spec.js|authorization|mobile');
    assert.equal(rows[0].test, result);
    assert.deepEqual(reportTests({}), []);
});
