'use strict';

/** Owned review regressions: selective dense links, a deterministic mutation and distinct opaque grants. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const runtime = require('./demo-runtime-client');
const { approve, put, work } = require('./gateway-authorized-search-matrix');
const { gateway, matches } = require('./gateway-post-search');
const { maintenance } = require('./hapi-authorized-search-matrix');
const ho = runtime.config.healthOrganizations[0];
const system = 'http://fhir.health.gov.il/identifier/il-national-id';
const p = 'patient-review-';
const runId = crypto.randomUUID();
const report = { status: 'running', runId, cases: [], preset: runtime.config.conformance.preset };
const control = process.env.PCM_PATIENT_REVIEW_CONTROL;
const baseline = process.env.PCM_PATIENT_REVIEW_BASELINE === 'true';

/** Bound event handshakes to the owning disposable directory; no elapsed-time guess chooses the interleaving. */
async function ready(name) {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(control + '/' + name + '-ready')) {
        assert.ok(Date.now() < deadline, 'Native barrier not reached: ' + name);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
function release(name) { fs.writeFileSync(control + '/' + name + '-release', 'release'); }

/** Fresh real issuance/introspection binds a complete grant to the expected nested Patient. */
async function issued(consent, value) {
    const token = await runtime.issue(consent, 'patient/Patient.s', 0);
    assert.equal(token.status, 200, JSON.stringify(token.json));
    const active = await runtime.introspect(token.json.access_token, 0);
    assert.equal(active.json.active, true); assert.equal(active.json.patient, undefined);
    const patient = active.json.authorization_details[0].fhirContext.filter(item => item.type === 'Patient');
    assert.equal(patient.length, 1); assert.deepEqual(patient[0].identifier, { system, value });
    return token.json.access_token;
}

/** Keep exact result/work facts, without copying token or introspection credentials. */
async function record(name, result, expected) {
    assert.equal(result.status, 200, name + ': ' + result.text);
    assert.deepEqual(matches(result), expected, name);
    const counters = await work(ho, result.correlation);
    assert.equal(counters.completed, true);
    report.cases.push({ name, method: result.method, path: result.path, correlation: result.correlation,
        ids: matches(result), work: counters });
    return counters;
}

/** More matching links than PAGE permits must not defeat a selective self/linked/empty native query. */
async function selective() {
    const target = p + 'dense', value = '000000026', linked = p + 'dense-0000';
    await put(ho, [{ resourceType: 'Patient', id: target, identifier: [{ system, value }] },
        { resourceType: 'Patient', id: p + 'wrong' },
        { resourceType: 'Patient', id: p + 'wrong-link', link: [{ type: 'seealso', other: { reference: 'Patient/' + p + 'wrong' } }] }]);
    for (let offset = 0; offset < 6000; offset += 100) {
        await put(ho, Array.from({ length: 100 }, (_, i) => ({ resourceType: 'Patient',
            id: p + 'dense-' + String(offset + i).padStart(4, '0'),
            link: [{ type: 'seealso', other: { reference: 'Patient/' + target } }] })));
    }
    await put(ho, [{ resourceType: 'Patient', id: p + 'mixed', link: [
        { type: 'seealso', other: { reference: 'Patient/' + p + 'wrong' } },
        { type: 'seealso', other: { reference: 'https://foreign.invalid/fhir/Patient/' + target } }] },
        { resourceType: 'Patient', id: p + 'versioned', link: [
            { type: 'seealso', other: { reference: 'https://foreign.invalid/fhir/Patient/' + target + '/_history/1' } }] }]);
    const consent = await approve(value);
    for (const [name, query, expected] of [
        ['self', '_id=' + target, [target]],
        ['linked', '_id=' + linked, [linked]],
        ['empty', 'identifier=urn:patient-review|missing', []],
        ['repeated-comma', '_id=' + target + ',' + linked + '&_id=' + linked, [linked]],
        ['contradictory-id', '_id=' + target + '&_id=' + linked, []],
        ['wrong-patient', '_id=' + p + 'wrong-link', []],
        ['mixed-foreign-link', '_id=' + p + 'mixed', [p + 'mixed']],
        ['versioned-foreign-link', '_id=' + p + 'versioned', [p + 'versioned']],
        ['id-or-decoy', '_id=' + [target, linked, p + 'mixed', p + 'wrong-link'].join(','), [target, linked, p + 'mixed']]
    ]) for (const method of ['GET', 'POST']) {
        const token = await issued(consent, value);
        const result = await gateway('/Patient' + (method === 'POST' ? '/_search' : '?' + query), token,
            { ...(method === 'POST' ? { method, body: query } : {}), correlation: p + 'cost-' + runId + '-' + name + '-' + method });
        if (baseline) {
            assert.equal(result.status, 503, result.text);
            const counters = await work(ho, result.correlation);
            assert.equal(counters.candidateIdVisits, 5001);
            report.cases.push({ name: name + '-' + method, status: result.status, work: counters });
        } else {
            const counters = await record(name + '-' + method, result, expected);
            assert.ok(counters.candidateIdVisits <= 32, JSON.stringify(counters));
            assert.ok(counters.bodyVisits <= 8, JSON.stringify(counters));
            assert.ok(counters.allocatedBytes <= 268435456, JSON.stringify(counters));
        }
    }
    if (!baseline) {
        const broad = await gateway('/Patient', await issued(consent, value));
        assert.equal(broad.status, 503, 'a truncated probe must retain honest broad-set exhaustion');
        const counters = await work(ho, broad.correlation);
        assert.equal(counters.candidateIdVisits, 5001);
        assert.equal(counters.completed, false);
        report.cases.push({ name: 'unqualified-dense-honest-exhaustion', status: broad.status, work: counters });
        const identifiers = Array.from({ length: 40 }, (_, i) => ({ system: 'urn:patient-review-duplicates', value: 'key-' + i }));
        await put(ho, [0, 1].map(n => ({ resourceType: 'Patient', id: p + 'duplicate-' + n,
            identifier: identifiers, link: [{ type: 'seealso', other: { reference: 'Patient/' + target } }] })));
        const duplicateQuery = 'identifier=' + identifiers.map(identifier => identifier.system + '|' + identifier.value).join(',');
        const duplicate = await gateway('/Patient?' + duplicateQuery, await issued(consent, value),
            { correlation: p + 'cost-' + runId + '-duplicates' });
        assert.equal(duplicate.status, 503, 'raw-row cap is not proof that a deduplicated PID set is complete');
        const duplicateWork = await work(ho, duplicate.correlation);
        assert.equal(duplicateWork.candidateIdVisits, 5001);
        report.cases.push({ name: 'duplicate-native-probe-honest-exhaustion', status: duplicate.status,
            expectedMatchesIfBudgetAllowed: [p + 'duplicate-0', p + 'duplicate-1'], work: duplicateWork });
    }
    report.matchingLocalLinks = 6000;
}

/** Bind the final artifact to the original explicit sparse oracle on the retained owned growth fixture. */
async function sparse() {
    const consent = await approve('000000018');
    const expected = [...Array.from({ length: 14 }, (_, i) => 'authorized-search-link-' + String(i).padStart(2, '0')),
        'authorized-search-patient'];
    const { traverse } = require('./gateway-patient-selection');
    for (const method of ['GET', 'POST']) for (const query of ['', 'identifier=does-not-match']) {
        report.cases.push(await traverse(consent, method, query ? [] : expected, query));
    }
}

/** Switch a foreign match to a local match exactly between the two actual projection statements. */
async function snapshot() {
    const target = p + 'snapshot-self', mutable = p + 'snapshot-link', value = '000000059';
    await put(ho, [{ resourceType: 'Patient', id: target, identifier: [{ system, value }] }]);
    const foreign = 'https://foreign.invalid/fhir/Patient/' + target;
    // Separate writes prevent HAPI's transaction reference substitution from turning
    // the intended foreign precondition into a local link to another transaction row.
    await put(ho, [{ resourceType: 'Patient', id: mutable,
        link: [{ type: 'seealso', other: { reference: foreign } }] }]);
    const stored = await maintenance('GET', '/Patient/' + mutable);
    assert.equal(stored.link[0].other.reference, foreign, 'persisted foreign precondition');
    const localBefore = await maintenance('GET', '/Patient?_id=' + mutable + '&link=Patient/' + target);
    assert.deepEqual((localBefore.entry || []).map(entry => entry.resource.id), [], 'no local index match before transition');
    const consent = await approve(value), token = await issued(consent, value);
    const pending = gateway('/Patient?_count=10', token, { correlation: 'patient-review-snapshot-' + runId });
    await ready('snapshot');
    await put(ho, [{ resourceType: 'Patient', id: mutable, link: [{ type: 'seealso', other: { reference: 'Patient/' + target } }] }]);
    release('snapshot');
    const result = await pending;
    const expected = baseline ? [target] : [mutable, target];
    await record('foreign-to-local-between-projections', result, expected);
    report.interleaving = { localProjectionFinished: true, updateCommittedBeforeExceptionalProjection: true,
        continuouslyAuthorized: mutable, expectedComplete: [mutable, target], baselineOmitted: baseline };
    if (!baseline) {
        const connections = fs.readFileSync(control + '/snapshot-connections.txt', 'utf8').trim().split('\n')
            .map(line => { const [pid, isolation, transaction, snapshot] = line.split('|'); return { pid, isolation, transaction, snapshot }; });
        assert.equal(connections.length, 2);
        assert.equal(connections[0].isolation, 'repeatable read');
        assert.deepEqual(connections[1], connections[0], 'both projections use the same actual transaction/snapshot');
        report.interleaving.actualConnection = connections[0];
    }
}

/** Exhaust original continuations with fresh equivalent authority and reject the other Patient's cursor. */
async function finish(consent, value, first, otherToken, expected) {
    let result = first, ids = [];
    for (let page = 0; page < 10; page++) {
        assert.equal(result.status, 200, result.text); ids.push(...matches(result));
        const next = result.body.link?.find(link => link.relation === 'next')?.url;
        if (!next) break;
        const url = new URL(next), path = url.pathname.replace(/^\/fhir/, '') + url.search;
        if (page === 0) assert.equal((await gateway(path, otherToken)).status, 403);
        result = await gateway(path, await issued(consent, value));
    }
    assert.deepEqual(ids, expected); assert.equal(new Set(ids).size, ids.length);
    return ids;
}

/** Two simultaneous native searches have different verified Patient contexts and explicit independent sets. */
async function concurrent() {
    const a = p + 'a', b = p + 'b', av = '000000034', bv = '000000042', shared = p + 'shared';
    await put(ho, [{ resourceType: 'Patient', id: a, identifier: [{ system, value: av }] },
        { resourceType: 'Patient', id: b, identifier: [{ system, value: bv }] },
        ...[a, b].flatMap(target => [1, 2].map(n => ({ resourceType: 'Patient', id: target + '-' + n,
            link: [{ type: 'seealso', other: { reference: 'Patient/' + target } }] }))),
        { resourceType: 'Patient', id: shared, link: [a, b].map(target => ({ type: 'seealso', other: { reference: 'Patient/' + target } })) },
        { resourceType: 'Patient', id: p + 'concurrent-decoy', link: [{ type: 'seealso', other: { reference: 'Patient/' + p + 'wrong' } }] }]);
    const [ca, cb] = await Promise.all([approve(av), approve(bv)]);
    const [ta, tb] = await Promise.all([issued(ca, av), issued(cb, bv)]);
    const pa = gateway('/Patient?_count=2', ta, { correlation: 'patient-review-concurrent-a-' + runId });
    const pb = gateway('/Patient?_count=2', tb, { correlation: 'patient-review-concurrent-b-' + runId });
    await Promise.all([ready('concurrent-a'), ready('concurrent-b')]);
    release('concurrent-a'); release('concurrent-b');
    const [ra, rb] = await Promise.all([pa, pb]);
    await record('independent-A-first', ra, [a, a + '-1']);
    await record('independent-B-first', rb, [b, b + '-1']);
    const [idsA, idsB] = await Promise.all([finish(ca, av, ra, tb, [a, a + '-1', a + '-2', shared]),
        finish(cb, bv, rb, ta, [b, b + '-1', b + '-2', shared])]);
    report.distinctGrants = { sameQuery: '/Patient?_count=2', patients: [av, bv],
        simultaneousProjectionBarriers: ['concurrent-a', 'concurrent-b'], idsA, idsB, crossAuthorityCursorStatus: 403 };
}

/** Select exactly one review case on this exclusively owned side deployment. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    assert.equal(runtime.config.clinicalQuery, undefined, 'default budgets required');
    const phase = process.env.PCM_PATIENT_REVIEW_PHASE;
    const controls = phase === 'snapshot' ? ['snapshot-ready', 'snapshot-release', 'snapshot-sql.txt', 'snapshot-connections.txt']
        : phase === 'concurrent' ? ['concurrent-a-ready', 'concurrent-a-release', 'concurrent-b-ready', 'concurrent-b-release'] : [];
    for (const file of controls) fs.rmSync(control + '/' + file, { force: true });
    try {
        if (phase === 'selective') await selective();
        else if (phase === 'snapshot') await snapshot();
        else if (phase === 'concurrent') await concurrent();
        else if (phase === 'sparse') await sparse();
        else throw new Error('Choose a named review phase');
        report.status = baseline ? 'reproduced' : 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
