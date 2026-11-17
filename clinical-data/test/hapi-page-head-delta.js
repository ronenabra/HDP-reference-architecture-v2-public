'use strict';
/** Final HEAD-only compatibility delta; reuse the completed GET matrices without replaying them. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { request, localToken } = require('./hapi-authorization-matrix');
const { traverse } = require('./hapi-page-matrix');

/** Check native HEAD and unchanged signed GET traversal on the owned tiny HO-A fixture. */
async function main() {
    const ho = 'ho-a', scope = 'patient/Observation.s?status=final';
    const result = { scope: 'page-head-only-final-image-delta', status: 'running', cases: [] };
    for (let i = 0; i < 120; i++) {
        try {
            const ready = await fetch(`https://${ho}-hapi:8080/fhir/Observation?_count=1`);
            if (ready.status === 403) break;
        } catch (_) { /* connector can still be closed during the owned replacement */ }
        assert.ok(i < 119, 'protected endpoint became ready');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    result.startedAt = new Date().toISOString();
    for (const query of ['_count=1', '_summary=count']) {
        const uri = `/fhir/Observation?${query}`;
        const startedAt = new Date().toISOString();
        assert.ok(process.env.PCM_A_IMPORT_CREDENTIAL?.length >= 32, 'private native control on owned endpoint only');
        const native = await fetch(`https://${ho}-hapi:8080${uri}`, { method: 'HEAD',
            headers: { 'X-PCM-Import-Credential': process.env.PCM_A_IMPORT_CREDENTIAL } });
        const nativeBody = await native.text();
        const response = await request(ho, uri, scope, { method: 'HEAD' });
        console.log(JSON.stringify({ method: 'HEAD', query, status: response.response.status,
            statusText: response.response.statusText, headers: Object.fromEntries(response.response.headers) }));
        assert.equal(native.status, 400, 'pinned HAPI native HEAD type-search behavior');
        assert.equal(nativeBody, '');
        assert.equal(response.response.status, native.status, `clinical HEAD preserves native ${query}`);
        assert.equal(response.text, '');
        result.cases.push({ name: `verified-head-${query}`, status: native.status, nativeControlStatus: native.status, bodyBytes: 0,
            startedAt, finishedAt: new Date().toISOString() });
    }
    const uri = '/fhir/Observation?_count=1';
    const wrongMethod = await request(ho, uri, scope, { method: 'HEAD', token: localToken(ho, scope, uri, {}, 'GET') });
    // This pinned native type-search HEAD is rejected before the postprocessed hook.
    assert.equal(wrongMethod.response.status, 400);
    result.cases.push({ name: 'native-rejects-head-before-module-signature-hook', status: 400 });
    const unsigned = await fetch(`https://${ho}-hapi:8080${uri}`, { method: 'HEAD' });
    assert.equal(unsigned.status, 400);
    result.cases.push({ name: 'native-unsigned-head-rejection', status: 400 });
    const boundGet = await request(ho, uri, scope, { token: localToken(ho, scope, uri, {}, 'HEAD') });
    assert.equal(boundGet.response.status, 403);
    result.cases.push({ name: 'get-rejects-wrong-original-signed-method', status: 403 });
    const unsignedGet = await fetch(`https://${ho}-hapi:8080${uri}`);
    assert.equal(unsignedGet.status, 403);
    result.cases.push({ name: 'unsigned-get', status: 403 });
    result.getStartedAt = new Date().toISOString();
    result.getPages = await traverse(ho, '/fhir/Observation?_count=1&_sort=date',
        'patient/Observation.s?status=final patient/Observation.r',
        [1, 3, 4].map(n => `observation-${ho}-000${n}`));
    result.finishedAt = new Date().toISOString();
    result.status = 'pass';
    fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log('Final HEAD compatibility and representative GET/same-type read isolation PASS');
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
