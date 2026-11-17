'use strict';
/** Four temporary resources prove supported native write/import/delete and rollback invalidation. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { request } = require('./hapi-authorization-matrix');
const { maintenance, observation } = require('./hapi-page-small-fixture');
const { primary } = require('./hapi-page-matrix');
function next(bundle) { const url = new URL(bundle.link.find(l => l.relation === 'next').url); return url.pathname + url.search; }
async function main() {
    const ids = [0,1,2,3].map(n => `ds-total-mutation-${n}`), scope = 'patient/Observation.s';
    const query = `/fhir/Observation?_id=${ids.join(',')}&status=final&_count=1&_total=accurate&_sort=date`;
    const rows = ids.map(id => observation(id, 'final')), result = { status: 'running', created: ids.length, cases: [] };
    async function initial(expected) {
        const r = await request('ho-a', query, scope); assert.equal(r.response.status, 200, r.text);
        assert.equal(r.body.total, expected); return r.body;
    }
    async function changed(before, expected) {
        const r = await request('ho-a', next(before), scope);
        assert.equal(r.response.status, 410, r.text); assert.equal(r.body.total, undefined);
        const fresh = await initial(expected); result.cases.push({ status: 'pass', continuationStatus: 410, freshTotal: fresh.total });
    }
    try {
        await maintenance('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: rows.map(resource => ({ resource, request: { method: 'PUT', url: `Observation/${resource.id}` } })) });
        let first = await initial(4); assert.deepEqual(primary(first), [ids[0]]);
        await maintenance('PUT', `/Observation/${ids[1]}`, { ...rows[1], status: 'amended' });
        await changed(first, 3);
        first = await initial(3); await maintenance('DELETE', `/Observation/${ids[3]}`); await changed(first, 2);
        first = await initial(2);
        await maintenance('PUT', `/Observation/${ids[3]}`, rows[3]); await changed(first, 3);
        // Failed transaction attempts a real write then an invalid resource operation; current resources remain unchanged.
        first = await initial(3);
        const rolled = await fetch('https://ho-a-hapi:8080/fhir', { method: 'POST', headers: {
            'content-type': 'application/fhir+json', 'X-PCM-Import-Credential': process.env.PCM_A_IMPORT_CREDENTIAL },
            body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: [
                { resource: { ...rows[0], status: 'amended' }, request: { method: 'PUT', url: `Observation/${ids[0]}` } },
                { resource: { ...rows[1], subject: { reference: 'https://external.invalid/Patient/total-rollback' } }, request: { method: 'PUT', url: `Observation/${ids[1]}` } }
            ] }), signal: AbortSignal.timeout(15000) });
        assert.ok(rolled.status >= 400); await rolled.text();
        assert.equal((await initial(3)).total, 3);
        const continuation = await request('ho-a', next(first), scope);
        // Native may reject before entering any write hook; either unchanged continuation or conservative invalidation is safe.
        assert.ok([200,410].includes(continuation.response.status), continuation.text);
        if (continuation.response.status === 200) assert.equal(continuation.body.total, 3);
        result.rollback = { transactionStatus: rolled.status, continuationStatus: continuation.response.status, unchangedTotal: 3 };
        result.status = 'pass';
    } finally {
        const failures = [];
        for (const id of ids) try { await maintenance('DELETE', `/Observation/${id}`); } catch (error) { failures.push(error.message); }
        result.cleanup = { deleted: ids.length, failures }; assert.deepEqual(failures, []);
        if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
