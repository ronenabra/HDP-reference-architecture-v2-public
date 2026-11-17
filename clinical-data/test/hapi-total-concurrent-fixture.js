'use strict';
/** Deterministic real-native count/page mutation race using only one temporary Practitioner. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { request } = require('./hapi-authorization-matrix');
const { maintenance } = require('./hapi-page-small-fixture');
const root = '/artifacts';
async function wait(name) {
    const start = Date.now();
    while (!fs.existsSync(`${root}/${name}`)) {
        assert.ok(Date.now() - start < 6000, `bounded orchestration wait ${name}`);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}
async function main() {
    const uri = '/fhir/Observation?date=ge2020&_count=1&_total=accurate', scope = 'patient/Observation.s';
    const pending = request('ho-a', uri, scope), start = performance.now();
    fs.writeFileSync(`${root}/started`, '1');
    let created = false;
    try {
        await wait('write-now');
        await maintenance('PUT', '/Practitioner/ds-total-concurrent-writer', { resourceType: 'Practitioner', id: 'ds-total-concurrent-writer', active: true });
        created = true; fs.writeFileSync(`${root}/writer-done`, '1');
        const result = await pending;
        assert.equal(result.response.status, 503, result.text); assert.equal(result.body.resourceType, 'OperationOutcome');
        assert.equal(result.body.total, undefined);
        const recovery = await request('ho-a', uri, scope);
        assert.equal(recovery.response.status, 200, recovery.text); assert.equal(recovery.body.total, 4);
        const output = { status: 'pass', scope: 'total-small-native-concurrent-mutation', blockedCount: true,
            committedWriteBeforeRelease: true, statusCode: result.response.status, elapsedMs: performance.now() - start, recoveryTotal: 4 };
        fs.writeFileSync(`${root}/concurrent.json`, JSON.stringify(output, null, 2)); console.log(JSON.stringify(output));
    } finally { if (created) await maintenance('DELETE', '/Practitioner/ds-total-concurrent-writer'); }
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
