'use strict';
/** Timing acceptance must use positive, unchanged, exact observations and fail closed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { measurePrivateCounts, validateCountMeasurements } = require('../scripts/measure-private-counts');

function fixture() {
    return { actualResourceCount: 4010, actualCounts: { Patient: 1, Observation: 4009 },
        hasHistory: true, diagnostics: { requests: 25, responseBytes: 5000 } };
}

test('count measurement warms once, observes three reads and never requests a mutation', async () => {
    let calls = 0; let milliseconds = 0;
    const result = await measurePrivateCounts({ adminUrl: 'http://localhost:4999', adminPassword: 'test-only',
        clock: () => (milliseconds += 100), fetchImpl: async (url, options) => {
            calls++;
            assert.equal(url.pathname, '/admin/api/fhir-servers/ho-a/data');
            assert.equal(options.method, undefined);
            assert.equal(options.headers['x-admin-password'], 'test-only');
            return { ok: true, json: async () => fixture() };
        } });
    assert.equal(calls, 4);
    assert.equal(result.runs.length, 3);
    assert.ok(!JSON.stringify(result).includes('test-only'));
    assert.equal(validateCountMeasurements(result), true);
    result.runs[1].actualCounts = { Observation: 4009, Patient: 1 };
    assert.equal(validateCountMeasurements(result), true);
    for (const mutate of [
        report => report.runs.pop(),
        report => { report.runs[0].elapsedMilliseconds = 175000; },
        report => { report.runs[0].actualResourceCount = 0; },
        report => { report.runs[0].requestCount = undefined; },
        report => { report.runs[0].actualCounts.Patient = 2; }
    ]) { const invalid = structuredClone(result); mutate(invalid); assert.throws(() => validateCountMeasurements(invalid)); }
});

test('count acceptance keeps its 30-second bound independently of the interactive deadline', async () => {
    for (const elapsed of [29999, 30000, 174000]) {
        let milliseconds = 0;
        const observed = measurePrivateCounts({ adminUrl: 'http://localhost:4999',
            clock: () => (milliseconds += elapsed),
            fetchImpl: async () => ({ ok: true, json: async () => fixture() }) });
        if (elapsed < 30000) assert.equal(validateCountMeasurements(await observed), true);
        else await assert.rejects(observed, /under 30 seconds/);
    }
});

test('count measurement rejects remote targets, unavailable state and HTTP errors', async () => {
    await assert.rejects(measurePrivateCounts({ adminUrl: 'https://remote.example' }), /local disposable/);
    await assert.rejects(measurePrivateCounts({ adminUrl: 'http://localhost:4999', serverId: 'legacy-ds' }), /managed CI/);
    await assert.rejects(measurePrivateCounts({ adminUrl: 'http://localhost:4999', fetchImpl: async () => ({ ok: false, status: 502 }) }), /HTTP 502/);
    await assert.rejects(measurePrivateCounts({ adminUrl: 'http://localhost:4999', fetchImpl: async () => ({ ok: true, json: async () => ({ state: 'unavailable' }) }) }), /4010 exact/);
});
