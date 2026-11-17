'use strict';
/** A newly inserted primary must appear in a fresh accurate traversal; old membership cannot be reused. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { request } = require('./hapi-authorization-matrix');
const { maintenance, observation } = require('./hapi-page-small-fixture');
const { traverseTotal } = require('./hapi-total-matrix');
async function main() {
    const ids = [0,1,2].map(n => `ds-total-cache-${n}`), scope = 'patient/Observation.s';
    const rows = ids.map(id => ({ ...observation(id, 'final'), meta: { tag: [{ system: 'urn:ds-total-cache', code: 'small' }] } }));
    const uri = '/fhir/Observation?_tag=urn%3Ads-total-cache%7Csmall&_total=accurate&_count=1&_sort=_id';
    const result = { status: 'running', temporaryResources: 3 };
    try {
        await maintenance('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: rows.slice(0,2).map(resource => ({ resource, request: { method: 'PUT', url: `Observation/${resource.id}` } })) });
        const before = await traverseTotal('ho-a', uri, scope, ids.slice(0,2));
        const first = await request('ho-a', uri, scope); assert.equal(first.response.status, 200, first.text);
        const next = new URL(first.body.link.find(link => link.relation === 'next').url);
        await maintenance('PUT', `/Observation/${ids[2]}`, rows[2]);
        const old = await request('ho-a', next.pathname + next.search, scope); assert.equal(old.response.status, 410, old.text);
        const fresh = await traverseTotal('ho-a', uri, scope, ids);
        result.status = 'pass'; result.before = before.ids; result.after = fresh.ids; result.oldCursorStatus = 410;
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
