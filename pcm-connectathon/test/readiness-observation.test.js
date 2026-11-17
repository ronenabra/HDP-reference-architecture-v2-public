'use strict';
/** Network observations distinguish metadata smoke from authenticated clinical readiness. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { diagnoseDataSource } = require('../../src/pcm-core/src/data-source-readiness');

test('metadata-only source cannot claim token, introspection or clinical success', async t => {
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push(req.url);
        res.setHeader('content-type', 'application/fhir+json');
        if (req.url.endsWith('/metadata')) res.end(JSON.stringify({ resourceType: 'CapabilityStatement' }));
        else { res.statusCode = 401; res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const result = await diagnoseDataSource({ id: 'unregistered', clientId: 'unregistered', endpoint: `http://127.0.0.1:${server.address().port}/fhir` });
    assert.equal(result.status, 'partial');
    assert.equal(result.phases.find(item => item.phase === 'introspection').status, 'not-tested');
    assert.equal(result.phases.find(item => item.phase === 'fhir').status, 'not-tested');
    assert.equal(calls.filter(url => url.endsWith('/metadata')).length, 1);
});

test('readiness observes easy access, authorized clinical results, and bounded failures', async t => {
    const calls = [];
    let mode = 'enforced';
    const server = http.createServer((req, res) => {
        calls.push({ url: req.url, authorization: req.headers.authorization });
        res.setHeader('content-type', 'application/fhir+json');
        if (mode === 'timeout') return;
        if (mode === 'redirect') { res.writeHead(302, { Location: 'http://[::ffff:a9fe:a9fe]/' }); res.end(); return; }
        if (req.url.endsWith('/metadata')) { res.end(JSON.stringify({ resourceType: 'CapabilityStatement' })); return; }
        res.statusCode = mode === 'easy' || req.headers.authorization === 'Bearer clinical-probe' ? 200 : 401;
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const source = { id: 'source-a', endpoint: `http://127.0.0.1:${server.address().port}/fhir` };
    const probe = { patient: 'synthetic', accessToken: 'clinical-probe' };
    let result = await diagnoseDataSource(source, { controls: { oauthBearer: true }, probe });
    assert.equal(result.status, 'partial');
    assert.equal(result.coverage.authenticatedClinical, true);
    assert.equal(calls.filter(call => call.authorization).length, 1);
    result = await diagnoseDataSource(source, { controls: { oauthBearer: true }, probe: { ...probe, accessToken: 'expired' } });
    assert.equal(result.status, 'fail');
    assert.equal(result.phases.at(-1).phase, 'fhir');
    result = await diagnoseDataSource(source, { controls: { oauthBearer: true }, probe: { ...probe, path: 'http://other-source.test/fhir/Observation' } });
    assert.equal(result.status, 'fail');
    mode = 'easy';
    result = await diagnoseDataSource(source, { controls: { oauthBearer: false } });
    assert.equal(result.status, 'fail', 'anonymous clinical success fails readiness in every preset');
    assert.equal(result.coverage.authenticatedClinical, false);
    mode = 'redirect';
    result = await diagnoseDataSource(source);
    assert.equal(result.status, 'fail');
    assert.equal(result.phases.at(-1).phase, 'connectivity-tls');
    mode = 'timeout';
    result = await diagnoseDataSource(source, { timeoutMs: 100 });
    assert.equal(result.status, 'fail');
    assert.equal(result.phases.at(-1).classification, 'timeout');
});
