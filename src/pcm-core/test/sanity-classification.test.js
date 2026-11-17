'use strict';
/** Owner decision: hide only PCM's harness failure aggregate, preserving its real failure evidence. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeLogEntry } = require('../src/log-normalization');

test('retained sanity-summary correction is limited to configured PCM and preserves the recorded flow flag', () => {
    const details = { type: 'SANITY_CHECK_FAILED', category: 'harness', visibility: 'default', causesSystemFlow: true };
    for (const componentId of ['pcm-core', 'ho-b-gateway', 'sp-client', 'extensions/custom']) {
        const input = { message: 'Sanity Check Failed', level: 'ERROR', details, event: { source: { componentId } } };
        const copy = JSON.stringify(input), result = normalizeLogEntry(input);
        assert.equal(result.details.visibility, componentId === 'pcm-core' ? 'diagnostic' : 'default');
        assert.equal(result.details.causesSystemFlow, true); assert.equal(JSON.stringify(input), copy);
    }
    for (const type of ['GATEWAY_ERROR', 'OUTGOING_ERROR', 'PROCESS_LISTENER_ERROR', 'SANITY_UNRECOGNIZED_FAILURE']) {
        assert.equal(normalizeLogEntry({ event: { source: { componentId: 'pcm-core' } }, level: 'ERROR', details: { type } }).details.visibility, 'default');
    }
});

test('actual Admin sanity producer emits diagnostic failure; OFF notice, ON/detail and export retain exact summary', async t => {
    require('../../../test-support/team-config').installTestRuntime();
    const runtime = path.dirname(process.env.TEAM_CONFIG_PATH), root = process.env.SHARED_LOGS_DIR;
    // This bounded child returns fabricated CLI output without contacting any configured target.
    const script = path.join(runtime, 'owned-sanity-runner.js');
    fs.writeFileSync(script, "process.stdout.write(JSON.stringify({status:'fail',checks:[{name:'owned synthetic source',status:'fail'}]}));process.stderr.write('owned runner fixture');process.exitCode=1;\n");
    process.env.SANITY_SCRIPT = script; process.env.LOG_DIR = path.join(root, 'pcm-core');
    const file = path.join(root, 'ho-b-gateway/current.log'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-10-01T00:00:00.000Z', level: 'ERROR', message: 'Underlying request failure', details: { type: 'GATEWAY_ERROR', url: '/wrong-path', method: 'GET' } }) + '\n');
    const app = require('../src/index').createUiApp();
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    t.after(async () => { await app.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(runtime, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/admin/sanity-check', { method: 'POST', headers: { Accept: 'application/json' } });
    assert.equal(response.status, 500); assert.equal((await response.json()).ok, false);
    const emitted = fs.readFileSync(path.join(root, 'pcm-core/current.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const summary = emitted.find(row => row.details.type === 'SANITY_CHECK_FAILED');
    assert.equal(summary.details.visibility, 'diagnostic'); assert.equal(summary.details.causesSystemFlow, true);
    assert.equal(summary.details.failedChecks[0].name, 'owned synthetic source'); assert.match(summary.details.stderr, /owned runner fixture/);
    const off = await (await fetch(base + '/api/unified-logs?page=true&diagnostics=false')).json();
    assert.equal(off.entries.some(row => row.details.type === 'SANITY_CHECK_FAILED'), false);
    assert.ok(off.entries.some(row => row.details.type === 'GATEWAY_ERROR'));
    assert.equal(off.criticalDiagnostic.details.type, 'SANITY_CHECK_FAILED');
    const on = await (await fetch(base + '/api/unified-logs?page=true&diagnostics=true')).json();
    assert.ok(on.entries.some(row => row.details.type === 'SANITY_CHECK_FAILED'));
    const detail = await (await fetch(base + '/api/unified-logs/detail?reference=' + encodeURIComponent(off.criticalDiagnostic.reference))).json();
    assert.equal(detail.entry.id, off.criticalDiagnostic.id); assert.equal(detail.source.componentId, 'pcm-core');
    assert.equal(detail.raw, emitted.map(JSON.stringify).find(raw => JSON.parse(raw).details.type === 'SANITY_CHECK_FAILED'));
    const exported = await fetch(base + '/admin/logs/download'); assert.equal(exported.status, 200); assert.match(await exported.text(), /SANITY_CHECK_FAILED/);
});
