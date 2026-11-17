'use strict';
/** Socket deadlines distinguish upload and HAPI response wait. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { clinicalDeadlines, deadlineFetch } = require('../deadlines');

test('deadline configuration is bounded and stage-specific', () => {
    assert.deepEqual(clinicalDeadlines({}),
        { connectUploadMs: 120000, transactionWaitMs: 3600000, verificationMs: 300000 });
    assert.deepEqual(clinicalDeadlines({ CLINICAL_DATA_CONNECT_UPLOAD_TIMEOUT_MS: '5000',
        CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '900000', CLINICAL_DATA_VERIFICATION_TIMEOUT_MS: '2000' }),
    { connectUploadMs: 5000, transactionWaitMs: 900000, verificationMs: 2000 });
    assert.throws(() => clinicalDeadlines({ CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '0' }), /must be an integer/);
    assert.equal(clinicalDeadlines({ CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '3600000' }).transactionWaitMs, 3600000);
    assert.throws(() => clinicalDeadlines({ CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '3600001' }), /must be an integer/);
});

test('a deliberately slow private HAPI response completes inside the configured transaction wait', async t => {
    const server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => setTimeout(() => {
            response.setHeader('Content-Type', 'application/fhir+json');
            response.end(JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response', entry: [] }));
        }, 1250));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const fetch = deadlineFetch(undefined, { connectUploadMs: 1000, transactionWaitMs: 2500, verificationMs: 1000 });
    const started = Date.now();
    const result = await fetch(`http://127.0.0.1:${server.address().port}/fhir`, { method: 'POST', body: '{}' });
    assert.equal(result.status, 200);
    assert.ok(Date.now() - started >= 1200);
});

test('a HAPI wait over its own deadline fails with a recorded stage', async t => {
    const server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => setTimeout(() => response.end('{}'), 1500));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const fetch = deadlineFetch(undefined, { connectUploadMs: 1000, transactionWaitMs: 1000, verificationMs: 1000 });
    await assert.rejects(fetch(`http://127.0.0.1:${server.address().port}/fhir`, { method: 'POST', body: '{}' }), error => {
        assert.equal(error.clinicalFailureStage, 'hapi-transaction-wait');
        assert.equal(error.clinicalDeadlineMs, 1000);
        return true;
    });
});
