'use strict';
/** Exact-total backend proof over four independently known primary fixture rows per HO. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { request } = require('./hapi-authorization-matrix');
const { primary } = require('./hapi-page-matrix');

/** Traverse literal public links and compare every retained total with the independent result universe. */
async function traverseTotal(ho, uri, scope, expected) {
    const ids = [], pages = [];
    for (let n = 0; n < 10; n++) {
        const start = performance.now(), r = await request(ho, uri, scope);
        assert.equal(r.response.status, 200, `${ho} ${uri}: ${r.response.status} ${r.text}`);
        assert.equal(r.body.total, expected.length, 'exact authorized primary total on every page');
        const selected = primary(r.body), next = r.body.link?.find(link => link.relation === 'next')?.url;
        ids.push(...selected); pages.push({ ids: selected, total: r.body.total, elapsedMs: performance.now() - start, next: next || null });
        assert.ok(!next || selected.length > 0);
        if (!next) break;
        const parsed = new URL(next); assert.equal(parsed.origin, `https://${ho}-gateway:8080`);
        assert.equal(parsed.pathname, '/fhir'); uri = parsed.pathname + parsed.search;
        assert.ok(n < 9, 'bounded small traversal');
    }
    assert.deepEqual(ids, expected); assert.equal(new Set(ids).size, ids.length);
    const counted = await request(ho, '/fhir/Observation?_summary=count', scope);
    // Caller predicates can narrow the fixture; the direct count comparison is done separately for that case.
    return { ids, pages, scopeCount: counted.body.total };
}
async function runHo(ho) {
    const scope = 'patient/Observation.s', all = [1,2,3,4].map(n => `observation-${ho}-000${n}`), cases = [];
    for (const count of [1,2,3,100]) {
        const result = await traverseTotal(ho, `/fhir/Observation?_total=accurate&_count=${count}&_sort=date`, scope, all);
        assert.equal(result.scopeCount, all.length); cases.push({ name: `size-${count}`, ...result });
    }
    for (const [name, grant, extra, expected] of [
        ['scope-one', `${scope}?status=preliminary`, '', [all[1]]],
        ['scope-zero', `${scope}?status=entered-in-error`, '', []],
        ['client-zero', scope, '&status=entered-in-error', []],
        ['overlap-union', `${scope} ${scope}?status=final`, '', all],
        ['read-search-separation', `${scope}?status=preliminary patient/Observation.r`, '', [all[1]]]
    ]) {
        const result = await traverseTotal(ho, `/fhir/Observation?_total=accurate&_count=1&_sort=date${extra}`, grant, expected);
        if (!extra) assert.equal(result.scopeCount, expected.length);
        else assert.equal((await request(ho, `/fhir/Observation?_summary=count${extra}`, grant)).body.total, expected.length);
        cases.push({ name, ...result });
    }
    const include = await request(ho, `/fhir/Observation?_id=${all[0]}&_total=accurate&_count=1&_include=Observation%3Asubject`, 'patient/Observation.s patient/Patient.r');
    assert.equal(include.response.status, 200, include.text); assert.equal(include.body.total, 1);
    assert.deepEqual(primary(include.body), [all[0]]);
    assert.equal(include.body.entry.filter(e => e.search?.mode === 'include').length, 1);
    cases.push({ name: 'include-excluded', total: 1, entries: include.body.entry.length });
    for (const mode of ['', '&_total=none']) {
        const r = await request(ho, `/fhir/Observation?_count=1${mode}`, scope);
        assert.equal(r.response.status, 200, r.text); assert.equal(r.body.total, undefined);
    }
    for (const control of ['_total=estimate','_total=unknown','_total=accurate&_total=accurate','_total=none&_total=accurate','_total=','_count=0&_total=none']) {
        const r = await request(ho, `/fhir/Observation?${control}`, scope);
        assert.equal(r.response.status, 400, `${control}: ${r.text}`); assert.equal(r.body.resourceType, 'OperationOutcome');
        assert.equal(r.body.total, undefined);
    }
    const first = await request(ho, '/fhir/Observation?_count=1&_total=accurate', scope);
    const next = new URL(first.body.link.find(e => e.relation === 'next').url), uri = next.pathname + next.search;
    assert.equal((await request(ho, uri, `${scope}?status=final`)).response.status, 403);
    assert.equal((await request(ho, uri + '&_total=accurate', scope)).response.status, 403);
    assert.equal((await request(ho === 'ho-a' ? 'ho-b' : 'ho-a', uri, scope)).response.status, 403);
    console.log(`TOTAL ${ho} PASS`); return { ho, status: 'pass', cases };
}
async function main() {
    const results = [];
    for (const ho of ['ho-a','ho-b','ho-c']) results.push(await runHo(ho));
    const output = { status: 'pass', scope: 'total-native-small-fixture', results };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(output, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { traverseTotal, runHo, main };
