'use strict';
/** Focused native read-surface, continuation, mutation and failure recovery cases on the owned sparse fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { maintenance, protectedRead } = require('./hapi-authorized-search-matrix');
const { request, localToken } = require('./hapi-authorization-matrix');
const prefix = 'authorized-search-', scope = 'patient/Observation.s';
const base = '/Observation?_count=1&_id=' + [0, 1, 2, 3].map(i => prefix + '0' + i).join(',');
const output = { status: 'running', scope: 'owned-native-read-lifecycle', cases: [] };
/** Keep failures attributable and retain the whole exact fixture response status. */
async function successful(path, grant = scope) {
    const result = await protectedRead(path, grant); assert.equal(result.status, 200, result.text); return result.body;
}
/** Every emitted continuation remains bound to its original authority and query. */
function continuation(bundle) { const u = new URL(bundle.link.find(value => value.relation === 'next').url); return u.pathname + u.search; }
/** Current-body checks must refill a retained native membership hole rather than publish stale data. */
async function mutate(name, extraQuery, grant, change) {
    const original = await maintenance('GET', '/Observation/' + prefix + '01');
    const first = await successful(base + extraQuery, grant);
    try {
        await maintenance('PUT', '/Observation/' + original.id, change(structuredClone(original)));
        const next = continuation(first), result = await successful(next.replace(/^\/fhir/, ''), grant);
        assert.deepEqual(result.entry.filter(entry => entry.search.mode === 'match').map(entry => entry.resource.id), [prefix + '02']);
        output.cases.push({ name, first: prefix + '00', next: prefix + '02' });
    } finally { await maintenance('PUT', '/Observation/' + original.id, original); }
}
/** Execute only direct seams affected by early selection; every modified owned body/config is restored. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    const configPath = process.env.TEAM_CONFIG_PATH, originalBytes = fs.readFileSync(configPath);
    try {
        for (const control of ['_summary=count', '_count=0']) {
            const counted = await successful('/Observation?_id=' + prefix + '00,' + prefix + '01&' + control);
            assert.equal(counted.total, 2); assert.deepEqual(counted.entry || [], []);
            output.cases.push({ name: control, total: counted.total });
        }
        const accurate = await successful(base + '&_total=accurate'); assert.equal(accurate.total, 4);
        output.cases.push({ name: 'accurate-total', total: accurate.total });
        assert.equal((await protectedRead(base, 'patient/Observation.r')).status, 403);
        const included = await successful('/Observation?_id=' + prefix + '00&_include=Observation:subject&_count=10', scope + ' patient/Patient.r');
        assert.equal(included.entry.filter(entry => entry.search.mode === 'include').length, 1);
        const denied = await successful('/Observation?_id=' + prefix + 'performer&_include=Observation:subject&_count=10', scope + ' patient/Patient.r');
        assert.equal(denied.entry.filter(entry => entry.search.mode === 'include').length, 0);
        output.cases.push({ name: 'r-s-and-related-include-authority' });
        const first = await successful(base), next = continuation(first);
        for (const [name, options] of [
            ['other-patient', { claims: { patient_identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000026' } } }],
            ['other-client', { claims: { sub: 'pcm-matrix-client-0000000002', client_id: 'pcm-matrix-client-0000000002' } }],
            ['other-source', { tokenHo: 'ho-b' }]
        ]) {
            const result = await request('ho-a', next, scope, options); assert.equal(result.response.status, 403, result.text);
            output.cases.push({ name: 'continuation-' + name, status: result.response.status });
        }
        const tampered = await request('ho-a', next + '&status=final', scope, { token: localToken('ho-a', scope, next) });
        assert.equal(tampered.response.status, 403); output.cases.push({ name: 'original-raw-query-tampering', status: 403 });
        const independent = await Promise.all([successful(base), successful(base)]);
        assert.notEqual(continuation(independent[0]), continuation(independent[1]));
        assert.deepEqual(independent.map(value => value.entry[0].resource.id), [prefix + '00', prefix + '00']);
        output.cases.push({ name: 'concurrent-independent-native-search-memberships' });
        await mutate('changed-client-predicate', '&status=final', scope, value => ({ ...value, status: 'preliminary' }));
        await mutate('changed-compartment-membership', '', scope, value => ({ ...value, subject: { reference: 'Patient/' + prefix + 'other' } }));
        await mutate('changed-sensitivity', '', scope + '?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V', value => ({ ...value,
            meta: { ...value.meta, security: [...value.meta.security, { system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'V' }] } }));
        for (const setting of ['maxAllocatedBytes', 'maxPageIdVisits', 'maxPageBodyVisits', 'maxPagePayloadBytes']) {
            const config = JSON.parse(originalBytes); config.clinicalQuery = { sources: { 'ho-a': { [setting]: 1 } } };
            fs.writeFileSync(configPath, JSON.stringify(config));
            const refused = await protectedRead(base, scope); assert.equal(refused.status, 503, setting + ' ' + refused.text);
            fs.writeFileSync(configPath, originalBytes);
            await successful(base);
            output.cases.push({ name: 'budget-refusal-and-recovery', setting, status: refused.status });
        }
        output.status = 'pass';
    } catch (error) { output.status = 'fail'; output.error = error.stack; throw error; }
    finally { fs.writeFileSync(configPath, originalBytes); fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(output, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
