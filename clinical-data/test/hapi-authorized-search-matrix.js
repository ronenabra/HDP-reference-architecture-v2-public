'use strict';

/** Owned native PAGE regression. Signed-context evidence is explicitly separate from opaque gateway qualification. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { localToken } = require('./hapi-authorization-matrix');
const source = process.env.PCM_AUTHORIZED_SEARCH_HO || 'ho-a';
const base = `https://${source}-hapi:8080/fhir`;
const credential = process.env.PCM_AUTHORIZED_SEARCH_IMPORT_CREDENTIAL;
const report = { scope: 'owned-native-signed-context', source, status: 'running', cases: [], cleanup: null };
const prefix = 'authorized-search-';
const identitySystem = 'http://fhir.health.gov.il/identifier/il-national-id';
const selectedIdentity = { system: identitySystem, value: '000000018' };
const emptyIdentity = { system: identitySystem, value: '000000026' };
const target = prefix + 'patient', empty = prefix + 'empty', other = prefix + 'other';
const bucket = { system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'laboratoryTests' };
const observed = [];

/** The private maintenance credential only constructs the disposable fixture and client-predicate oracle. */
async function maintenance(method, path, body) {
    const response = await fetch(base + path, { method, headers: {
        'content-type': 'application/fhir+json', 'X-PCM-Import-Credential': credential
    }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text);
}

/** Read correlated actual PAGE work from the existing bounded native summary emitter. */
async function work(correlation) {
    const path = process.env.PCM_AUTHORIZED_SEARCH_NATIVE_LOG;
    assert.ok(path, 'native counter log required');
    for (let attempt = 0; attempt < 100; attempt++) {
        const records = fs.readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
        const event = records.findLast(row => row.details?.correlationId === correlation && row.details?.pageWork);
        if (event) return { ...event.details.pageWork, selection: event.details.nativeSelection };
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`No actual native work for ${correlation}`);
}

/** A fresh signed context retains original URI binding. This runner makes no opaque-token claim. */
async function protectedRead(path, scope, identity = selectedIdentity) {
    const uri = '/fhir' + path, correlation = 'authorized-search-' + require('node:crypto').randomUUID();
    const token = localToken(source, scope, uri, { patient_identifier: identity });
    const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}`,
        'X-PCM-Request-Method': 'GET', 'X-PCM-Request-URI': uri, 'X-Correlation-Id': correlation }, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch (_) { /* retain complete failure text */ }
    return { status: response.status, body, text, correlation };
}

/** The fixture has ordered ties, alternate/repeated paths and an unauthorized-resource decoy. */
function observation(id, patient, extra = {}) {
    return { resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '718-7' }] },
        meta: { security: [bucket] }, effectiveDateTime: '2026-01-01T00:00:00Z', subject: { reference: `Patient/${patient}` }, ...extra };
}

/** Import small owned transactions; no protected read receives a maintenance credential. */
async function put(resources) {
    for (let offset = 0; offset < resources.length; offset += 100) {
        const batch = resources.slice(offset, offset + 100);
        await maintenance('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: batch.map(resource => ({ resource,
            request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` } })) });
    }
}

/** Follow every useful page and compare exact ordered IDs, totals and actual first-page work. */
async function traverse(name, path, scope, expected, identity = selectedIdentity) {
    const ids = [], pages = [];
    for (let page = 0; page < 100; page++) {
        const result = await protectedRead(path, scope, identity);
        assert.equal(result.status, 200, `${name}: ${result.status} ${result.text}`);
        const selected = (result.body.entry || []).filter(entry => entry.search?.mode === 'match').map(entry => entry.resource.id);
        const counters = await work(result.correlation);
        assert.equal(counters.completed, true);
        pages.push({ ids: selected, work: counters }); ids.push(...selected);
        const next = result.body.link?.find(link => link.relation === 'next')?.url;
        if (!next) break;
        assert.ok(selected.length > 0, 'nonterminal pages must be useful');
        const parsed = new URL(next); path = parsed.pathname.replace(/^\/fhir/, '') + parsed.search;
    }
    assert.deepEqual(ids, expected, name);
    assert.equal(new Set(ids).size, ids.length);
    const value = { name, expected, ids, pages }; report.cases.push(value); return value;
}

/** Compare the ordinary per-resource authorization oracle with native client matching and optimized PAGE. */
async function equivalence(name, scope, query, universe) {
    const readable = [];
    const readScope = scope.split(' ').filter(value => /\.(?:rs|s)(?:\?|$)/.test(value))
        .map(value => value.replace(/\.(?:rs|s)(?=\?|$)/, '.r')).join(' ');
    for (const id of universe) {
        const result = await protectedRead('/Observation/' + id, readScope);
        if (result.status === 200) readable.push(id);
        else assert.ok([403, 404].includes(result.status), `${name}: oracle ${id} HTTP${result.status} ${result.text}`);
    }
    const predicates = query ? query + '&' : '';
    const client = await maintenance('GET', '/Observation?' + predicates + '_id=' + universe.join(',') + '&_count=100&_sort=_id');
    const expected = (client.entry || []).map(entry => entry.resource.id).filter(id => readable.includes(id));
    return traverse(name, '/Observation?' + predicates + '_count=10', scope, expected);
}

/** Execute only this bounded sparse regression on an explicitly owned, initially empty native source. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    assert.ok(credential);
    assert.ok(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT);
    try {
        let ready = false;
        for (let attempt = 0; attempt < 90; attempt++) {
            try { await maintenance('GET', '/metadata'); ready = true; break; } catch (_) { await new Promise(resolve => setTimeout(resolve, 1000)); }
        }
        assert.ok(ready, 'owned native source ready');
        const phase = process.env.PCM_AUTHORIZED_SEARCH_PHASE || 'all';
        assert.ok(['all', 'equivalence', 'foreign'].includes(phase));
        const targets = Array.from({ length: 25 }, (_, i) => observation(prefix + String(i).padStart(2, '0'), target));
        targets.push(observation(prefix + 'performer', other, { performer: [{ reference: `Patient/${target}` }] }));
        targets.push(observation(prefix + 'repeated', other, { performer: [{ reference: `Patient/${other}` }, { reference: `Patient/${target}` }] }));
        const decoy = observation(prefix + 'unauthorized', other);
        if (phase === 'foreign') {
            const foreign = `https://foreign.invalid/fhir/Patient/${target}`;
            targets.push(observation(prefix + 'foreign', other, { subject: { reference: foreign } }));
            targets.push(observation(prefix + 'mixed', other, { performer: [{ reference: `Patient/${other}` }, { reference: foreign }] }));
            targets.push(observation(prefix + 'absolute', other, { subject: { reference: `https://${source}-hapi:8080/fhir/Patient/${target}` } }));
            await put(targets.slice(-3));
            await put([observation(prefix + 'foreign-wrong', other, { subject: { reference: `https://foreign.invalid/fhir/Patient/${other}` } })]);
        }
        const expected = targets.map(resource => resource.id).sort();
        const scope = 'patient/Observation.rs';
        if (phase === 'all') {
            await put([{ resourceType: 'Patient', id: target, identifier: [selectedIdentity] },
                { resourceType: 'Patient', id: empty, identifier: [emptyIdentity] },
                { resourceType: 'Patient', id: other }, ...targets, decoy]);
        }
        for (const population of phase === 'all' ? [1000, 10000] : []) {
            const start = observed.length;
            for (let offset = start; offset < population; offset += 100) {
                const resources = Array.from({ length: Math.min(100, population - offset) }, (_, i) => observation(prefix + 'unrelated-' + (offset + i), other));
                await put(resources); observed.push(...resources.map(resource => resource.id));
            }
            const positive = await traverse(`population-${population}-positive`, '/Observation?_count=10', scope, expected);
            const negative = await traverse(`population-${population}-empty`, '/Observation?_count=10', scope, [], emptyIdentity);
            for (const result of [positive, negative]) {
                assert.ok(result.pages[0].work.candidateIdVisits <= 128, JSON.stringify(result.pages[0].work));
                assert.ok(result.pages[0].work.bodyVisits <= 128, JSON.stringify(result.pages[0].work));
                assert.ok(result.pages[0].work.allocatedBytes <= 268435456);
            }
        }
        for (const [name, expression, query] of [
            ['scope-and-client', 'patient/Observation.rs?status=final&date=ge2025-01-01', 'status=final'],
            ['overlapping-grants', 'patient/Observation.rs?status=final patient/Observation.rs?code=http://loinc.org|718-7', 'status=final'],
            ['repeated-client-and', scope, 'status=final&status=preliminary'],
            ['conflicting-client-patient', scope, `subject=Patient/${other}`]
        ]) await equivalence(name, expression, query, [...expected, decoy.id, ...(phase === 'foreign' ? [prefix + 'foreign-wrong'] : [])]);
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { report.cleanup = 'Owned container/database teardown is required by the host runner'; fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { observation, main, maintenance, protectedRead, traverse, equivalence };
