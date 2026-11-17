'use strict';
/** Small deterministic native PAGE acceptance; uses signed adapter context, independently known CI IDs. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { request, localToken } = require('./hapi-authorization-matrix');

/** Primary results alone consume page slots; includes are checked separately. */
function primary(bundle) { return (bundle.entry || []).filter(e => e.search?.mode === 'match').map(e => e.resource.id); }
/** Follow actual public links, minting fresh equivalent verified authority on each request. */
async function traverse(ho, uri, scope, expected, options = {}) {
    const ids = [], pages = [];
    for (let n = 0; n < 100; n++) {
        const result = await request(ho, uri, scope, options);
        assert.equal(result.response.status, 200, `${ho} ${uri}: ${result.response.status} ${result.text}`);
        assert.equal(result.body.type, 'searchset'); assert.equal(result.body.total, undefined);
        const selected = primary(result.body), next = result.body.link?.find(e => e.relation === 'next')?.url;
        const count = Number(new URL(`https://test${uri}`).searchParams.get('_count') || 20);
        assert.ok(selected.length <= Math.min(count, 100));
        assert.ok(!next || selected.length > 0, 'successful nonterminal pages must be useful');
        ids.push(...selected); pages.push({ uri, ids: selected, next: !!next, entries: result.body.entry?.length || 0 });
        if (!next) break;
        const parsed = new URL(next);
        assert.equal(parsed.origin, `https://${ho}-gateway:8080`, 'configured public source origin');
        assert.equal(parsed.pathname, '/fhir');
        assert.ok(!parsed.searchParams.has('_getpagesoffset'), 'native positions are authenticated inside cursors');
        uri = parsed.pathname + parsed.search;
        assert.ok(n < 99, 'bounded traversal');
    }
    assert.deepEqual(ids, expected, `${ho} independently expected traversal IDs`);
    assert.equal(new Set(ids).size, ids.length, 'no duplicates');
    return pages;
}

/** Exercise changed seams, never repeat COUNT's large-data qualification. */
async function runPageHo(ho) {
    const all = [1, 2, 3, 4].map(n => `observation-${ho}-000${n}`), scope = 'patient/Observation.s';
    const cases = [];
    for (const n of [1, 2, 3, 999999999]) cases.push({ name: `count-${n}`,
        pages: await traverse(ho, `/fhir/Observation?_count=${n}&_sort=date`, scope, all) });
    cases.push({ name: 'default', pages: await traverse(ho, '/fhir/Observation', scope, all) });
    cases.push({ name: 'sort-desc', pages: await traverse(ho, '/fhir/Observation?_count=1&_sort=-date', scope, [...all].reverse()) });
    cases.push({ name: 'filtered', pages: await traverse(ho, '/fhir/Observation?_count=1', 'patient/Observation.s?status=preliminary', [all[1]]) });
    cases.push({ name: 'all-denied', pages: await traverse(ho, '/fhir/Observation?_count=1', 'patient/Observation.s?status=entered-in-error', []) });
    cases.push({ name: 'true-empty', pages: await traverse(ho, '/fhir/Observation?_count=1&status=entered-in-error', scope, []) });
    cases.push({ name: 'duplicate-union', pages: await traverse(ho, '/fhir/Observation?_count=1&_sort=date', `${scope} ${scope}`, all) });
    for (const value of ['-1','1.5','2147483648','00','+1','1&_count=2']) {
        const r = await request(ho, `/fhir/Observation?_count=${value}`, scope);
        assert.equal(r.response.status, 400, `invalid ${value}`); assert.equal(r.body.resourceType, 'OperationOutcome');
    }
    const first = await request(ho, '/fhir/Observation?_count=1&_sort=date', scope);
    const next = new URL(first.body.link.find(e => e.relation === 'next').url), uri = next.pathname + next.search;
    for (const other of ['patient/Observation.s?status=final', 'patient/Observation.s patient/Observation.r']) {
        const r = await request(ho, uri, other); assert.equal(r.response.status, 403, 'changed effective grant');
    }
    for (const suffix of ['&status=final', '&_count=2', '&_getpagesoffset=2']) {
        assert.equal((await request(ho, uri + suffix, scope)).response.status, suffix === '&_count=2' ? 400 : 403);
    }
    const altered = new URL(next); altered.searchParams.set('_getpages', next.searchParams.get('_getpages').replace('.1.', '.2.'));
    assert.equal((await request(ho, altered.pathname + altered.search, scope)).response.status, 403, 'forged offset');
    assert.equal((await request(ho === 'ho-a' ? 'ho-b' : 'ho-a', uri, scope)).response.status, 403, 'cross-HO cursor');
    for (const control of ['_count=0', '_summary=count&_total=accurate']) {
        const counted = await request(ho, `/fhir/Observation?${control}`, scope);
        assert.equal(counted.response.status, 200, counted.text);
        assert.equal(counted.body.total, 4); assert.deepEqual(counted.body.entry || [], []);
    }
    const include = await request(ho, `/fhir/Observation?_id=${all[0]}&_count=1&_include=Observation%3Asubject`, 'patient/Observation.s patient/Patient.r');
    assert.equal(include.response.status, 200, include.text);
    assert.deepEqual(primary(include.body), [all[0]]);
    assert.equal(include.body.entry.filter(e => e.search?.mode === 'include').length, 1);
    cases.push({ name: 'included-supporting-read', entries: include.body.entry.map(e => ({ id: e.resource.id, mode: e.search.mode })) });
    console.log(`PAGE ${ho} PASS ${cases.length} positive traversal/control/security/include cases`);
    return { ho, status: 'pass', cases };
}
async function main() {
    const results = [];
    for (const ho of ['ho-a','ho-b','ho-c']) results.push(await runPageHo(ho));
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify({ status: 'pass', nativeSignedContext: true, results }, null, 2));
}
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { main, runPageHo, primary, traverse };
