#!/usr/bin/env node
'use strict';

/** Read-only representative timing evidence for an explicitly selected local Admin target. */
const fs = require('node:fs');
const { parseArgs } = require('./lib');
const { PRIVATE_DATA_STATE_TIMEOUT_MS } = require('../../clinical-data/transaction-bundle');
// The interactive server deadline allows slow diagnostics; release timing has
// its own unchanged acceptance bound and must not inherit that longer timeout.
const COUNT_ACCEPTANCE_MS = 30000;

/** Validate three observed warm reads; partial/empty fixtures cannot qualify the timing gate. */
function validateCountMeasurements(report) {
    if (report?.schemaVersion !== 'pcm-private-count-timing/1' || report.runs?.length !== 3) throw new Error('Three warm count measurements are required');
    for (const run of report.runs) {
        if (!Number.isSafeInteger(run.actualResourceCount) || run.actualResourceCount < 4010
            || !run.actualCounts || Object.values(run.actualCounts).some(value => !Number.isSafeInteger(value) || value < 0)
            || Object.values(run.actualCounts).reduce((sum, value) => sum + value, 0) !== run.actualResourceCount) {
            throw new Error('Representative count evidence requires at least 4010 exact resources and consistent per-type totals');
        }
        if (!(run.elapsedMilliseconds >= 0 && run.elapsedMilliseconds < COUNT_ACCEPTANCE_MS)
            || !(run.requestCount > 0) || !(run.responseBytes > 0)) throw new Error(`Every warm count read must finish under ${COUNT_ACCEPTANCE_MS / 1000} seconds with request/payload evidence`);
    }
    const normalized = counts => JSON.stringify(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
    if (report.runs.some(run => normalized(run.actualCounts) !== normalized(report.runs[0].actualCounts))) throw new Error('Representative target changed between measurements');
    return true;
}

/** Warm once, then measure three unchanged exact target reads with the real Admin deadline. */
async function measurePrivateCounts({ adminUrl, serverId = 'ho-a', adminPassword, fetchImpl = fetch, clock = () => performance.now() }) {
    const url = new URL(adminUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Select an explicit local disposable Admin URL');
    }
    if (!/^ho-[abc]$/.test(serverId)) throw new Error('Select one managed CI target: ho-a, ho-b or ho-c');
    const endpoint = new URL(`/admin/api/fhir-servers/${serverId}/data`, url);
    const reads = [];
    for (let i = 0; i < 4; i++) {
        const started = clock();
        const response = await fetchImpl(endpoint, { headers: { Accept: 'application/json', ...(adminPassword ? { 'x-admin-password': adminPassword } : {}) }, signal: AbortSignal.timeout(PRIVATE_DATA_STATE_TIMEOUT_MS + 5000) });
        if (!response.ok) throw new Error(`Count request failed: HTTP ${response.status}`);
        const state = await response.json();
        reads.push({ elapsedMilliseconds: clock() - started, actualResourceCount: state.actualResourceCount,
            actualCounts: state.actualCounts, hasHistory: state.hasHistory,
            requestCount: state.diagnostics?.requests, responseBytes: state.diagnostics?.responseBytes });
    }
    const report = { schemaVersion: 'pcm-private-count-timing/1', target: serverId, adminOrigin: url.origin,
        observedAt: new Date().toISOString(), warmup: reads[0], runs: reads.slice(1) };
    validateCountMeasurements(report);
    return report;
}

async function main(argv = process.argv) {
    const args = parseArgs(argv);
    const report = await measurePrivateCounts({ adminUrl: args['admin-url'], serverId: args['server-id'], adminPassword: process.env.PCM_UI_ADMIN_PASSWORD });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) fs.writeFileSync(args.output, output);
    console.log(output);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { measurePrivateCounts, validateCountMeasurements };
