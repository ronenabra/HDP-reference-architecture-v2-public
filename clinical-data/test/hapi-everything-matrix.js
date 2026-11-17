'use strict';
/** Tiny native Patient-operation proof. Expected IDs are fixture-authored, never derived from another search. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { request, localToken } = require('./hapi-authorization-matrix');

/** Follow authority-bound links while retaining exact native membership and checking every page. */
async function traverse(ho, uri, scope, expected, options = {}) {
    const found = [], pages = [];
    for (let page = 0; page < 40; page++) {
        const r = await request(ho, uri, scope, options);
        assert.equal(r.response.status, 200, `${ho} ${uri} ${r.text}`);
        assert.equal(r.body.total, undefined, 'operation totals always omitted');
        assert.equal(r.body.type, 'searchset');
        const ids = (r.body.entry || []).map(entry => {
            assert.equal(entry.search?.mode, 'match', 'actual native graph MATCH classification');
            return `${entry.resource.resourceType}/${entry.resource.id}`;
        });
        found.push(...ids);
        const next = r.body.link?.find(link => link.relation === 'next')?.url;
        pages.push({ uri, ids, next: !!next });
        assert.ok(!next || ids.length > 0, 'no false empty nonterminal page');
        if (!next) break;
        const parsed = new URL(next); assert.equal(parsed.origin, `https://${ho}-gateway:8080`);
        uri = parsed.pathname + parsed.search; assert.ok(page < 39, 'bounded fixture traversal');
    }
    assert.equal(new Set(found).size, found.length, 'native graph deduplication across all pages');
    assert.deepEqual(found.sort(), [...expected].sort());
    return pages;
}

/** Exercise native instance delegation and the changed authorization seams on eight existing resources per HO. */
async function runHo(ho) {
    const p = `Patient/patient-${ho}-0001`, obs = [1,2,3,4].map(n => `Observation/observation-${ho}-000${n}`);
    const full = 'patient/Patient.s patient/Observation.s';
    const cases = [];
    for (const route of ['/fhir/Patient/$everything', `/fhir/Patient/patient-${ho}-0001/$everything`]) {
        cases.push({ name: route, pages: await traverse(ho, `${route}?_count=1`, full, [p, ...obs]) });
        cases.push({ name: 'type-intersection', pages: await traverse(ho, `${route}?_type=Observation,Binary&_count=2`, full, obs) });
        cases.push({ name: 'mixed-r-s', pages: await traverse(ho, `${route}?_count=1`,
            'patient/Patient.s patient/Observation.s?status=preliminary patient/Observation.r', [p, obs[1]]) });
        cases.push({ name: 'no-patient-permission', pages: await traverse(ho, `${route}?_count=1`, 'patient/Observation.s', obs) });
        cases.push({ name: 'no-matching-results', pages: await traverse(ho, `${route}?_count=1`, 'patient/Observation.s?status=entered-in-error', []) });
    }
    for (const controls of ['_count=0','_summary=count','_total=accurate','_total=none','start=2020','end=2030','_since=2020','_filter=x','code=x','_mdm=true','_include=*','_count=1&_count=2']) {
        const r = await request(ho, `/fhir/Patient/$everything?${controls}`, full);
        assert.equal(r.response.status, 400, `${controls}: ${r.response.status} ${r.text}`);
    }
    for (const uri of [`/fhir/Patient/patient-${ho}-htest-1/$everything`, '/fhir/Patient/$everything?_type=Binary']) {
        assert.equal((await request(ho, uri, full)).response.status, 403);
    }
    const first = await request(ho, '/fhir/Patient/$everything?_count=1', full);
    const next = new URL(first.body.link.find(link => link.relation === 'next').url);
    const cursor = next.pathname + next.search;
    assert.equal((await request(ho, cursor, 'patient/Observation.s')).response.status, 403, 'changed grants');
    assert.equal((await request(ho === 'ho-a' ? 'ho-b' : 'ho-a', cursor, full)).response.status, 403, 'cross-HO');
    assert.equal((await request(ho, cursor + '&_type=Observation', full)).response.status, 403, 'changed operation parameters');
    assert.equal((await request(ho, '/fhir/Patient/$everything?_count=1', full, { token: localToken(ho, full, '/fhir/Patient/patient-other/$everything?_count=1') })).response.status, 403, 'original path binding');
    assert.equal((await request(ho, '/fhir/Patient/$everything', full, {claims: {patient_identifier: undefined}})).response.status, 403, 'missing trusted target');
    assert.equal((await request(ho, '/fhir/Patient/$everything', full, {claims: {patient_identifier: {system:'urn:absent',value:'none'}}})).response.status, 403, 'unresolved target');
    assert.equal((await request(ho, '/fhir/Patient/$everything', full, {claims: {iat: Math.floor(Date.now()/1000)-31}})).response.status, 403, 'expired context');
    const metadata = await request(ho, '/fhir/metadata', full);
    const resources = metadata.body.rest.flatMap(rest => rest.resource || []);
    assert.deepEqual(resources.filter(resource => resource.operation?.length).map(resource => resource.type), ['Patient']);
    assert.equal(resources.find(resource => resource.type === 'Patient').operation[0].name, 'everything');
    return { ho, status: 'pass', cases, securityCases: 20 };
}
async function main() {
    const results = [];
    for (const ho of ['ho-a','ho-b','ho-c']) results.push(await runHo(ho));
    const value = { status: 'pass', nativeSignedContext: true, smallFixtureResourcesPerHo: 8, results };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(value, null, 2));
    console.log('EVERYTHING native three-HO tiny-fixture PASS');
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main, runHo, traverse };
