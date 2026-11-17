'use strict';

/** Disposable opaque-token Patient growth regression; no client identity hint narrows selection. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const runtime = require('./demo-runtime-client');
const { approve, put, work } = require('./gateway-authorized-search-matrix');
const { call, matches } = require('./gateway-post-search');
const p = 'authorized-search-', target = p + 'patient', other = p + 'other';
const ho = runtime.config.healthOrganizations[0];
const report = { status: 'running', cases: [], limits: {
    maxAllocatedBytes: 268435456, maxPageIdVisits: 5000, maxPageBodyVisits: 5000,
    timeoutMilliseconds: 10000, maxConcurrentQueries: 2
} };

/** Traverse the single native ordered stream, including fresh GET continuations of POST searches. */
async function traverse(consent, method, expected, query = '') {
    const path = '/Patient' + (method === 'POST' ? '/_search' : query ? '?' + query : '');
    let result = await call(consent, path, method === 'POST' ? { method, body: query } : {});
    const ids = [], pages = [];
    for (let page = 0; page < 20; page++) {
        assert.equal(result.status, 200, result.text);
        assert.equal(result.body.total, undefined);
        const counters = await work(ho, result.correlation);
        assert.equal(counters.completed, true);
        assert.ok(counters.candidateIdVisits <= 128, JSON.stringify(counters));
        assert.ok(counters.bodyVisits <= 128, JSON.stringify(counters));
        assert.ok(counters.allocatedBytes <= report.limits.maxAllocatedBytes, JSON.stringify(counters));
        ids.push(...matches(result)); pages.push({ correlation: result.correlation, work: counters });
        const next = result.body.link?.find(link => link.relation === 'next')?.url;
        if (!next) break;
        const parsed = new URL(next);
        result = await call(consent, parsed.pathname.replace(/^\/fhir/, '') + parsed.search, {});
    }
    assert.deepEqual(ids, expected);
    assert.equal(new Set(ids).size, ids.length);
    return { method, query, ids, pages };
}

/** Build a link-free self, independent link directions, overlap and unrelated growth with an explicit oracle. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    assert.equal(runtime.config.clinicalQuery, undefined, 'growth uses unchanged built-in limits');
    const identity = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
    try {
        await put(ho, [{ resourceType: 'Patient', id: target, identifier: [identity] },
            { resourceType: 'Patient', id: other },
            ...Array.from({ length: 14 }, (_, i) => ({ resourceType: 'Patient', id: p + 'link-' + String(i).padStart(2, '0'),
                link: [{ other: { reference: 'Patient/' + target }, type: 'seealso' },
                    { other: { reference: 'Patient/' + target }, type: 'replaces' }] })),
            { resourceType: 'Patient', id: p + 'wrong-link', link: [{ other: { reference: 'Patient/' + other }, type: 'seealso' }] }]);
        const consent = await approve(identity.value);
        const expected = [...Array.from({ length: 14 }, (_, i) => p + 'link-' + String(i).padStart(2, '0')), target];
        for (const population of [1000, 10000]) {
            for (let offset = population === 1000 ? 0 : 1000; offset < population; offset += 100) {
                await put(ho, Array.from({ length: 100 }, (_, i) => ({ resourceType: 'Patient', id: p + 'unrelated-' + (offset + i) })));
            }
            if (process.env.PCM_PATIENT_REPRODUCE === 'true' && population === 1000) continue;
            if (process.env.PCM_PATIENT_REPRODUCE === 'true') {
                const result = await call(consent, '/Patient', {});
                report.cases.push({ population, status: result.status, work: await work(ho, result.correlation) });
                assert.equal(result.status, 503, result.text);
                report.status = 'reproduced'; return;
            }
            for (const method of ['GET', 'POST']) {
                for (const query of ['', '_count=3', 'identifier=does-not-match']) {
                    report.cases.push({ population, ...await traverse(consent, method, query.includes('identifier') ? [] : expected, query) });
                }
            }
        }
        // A named single-source selection reuses the original sparse growth proof independently.
        if (process.env.PCM_PATIENT_PHASE === 'growth') { report.status = 'pass'; return; }
        const issued = await runtime.issue(consent, undefined, 0);
        assert.equal(issued.status, 200);
        assert.equal((await runtime.introspect(issued.json.access_token, 0)).json.patient, undefined);
        const { read } = require('./gateway-authorized-search-matrix');
        const rejected = await read(runtime.config.healthOrganizations[1].endpoint + '/Patient', issued.json.access_token);
        assert.ok([401, 403].includes(rejected.status), rejected.text);
        report.cases.push({ name: 'cross-HO-Patient-token-refused', status: rejected.status, correlation: rejected.correlation });
        report.cases.push(await isolation(consent));
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}

/** A second native HO resolves the same business identity to its own independent logical ID. */
async function isolation(consent) {
    const source = runtime.config.healthOrganizations[1], id = 'patient-selection-independent-ho-b';
    await put(source, [{ resourceType: 'Patient', id,
        identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }] }]);
    const issued = await runtime.issue(consent, undefined, 1);
    assert.equal(issued.status, 200);
    const { read } = require('./gateway-authorized-search-matrix');
    const result = await read(source.endpoint + '/Patient', issued.json.access_token);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(matches(result), [id]);
    return { name: 'second-HO-own-Patient-resolution', source: source.id, status: result.status,
        correlation: result.correlation, work: await work(source, result.correlation) };
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main, isolation, traverse };
