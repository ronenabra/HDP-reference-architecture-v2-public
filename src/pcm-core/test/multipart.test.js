'use strict';

/** Exercise upload rejection over HTTP and byte-preserving multipart parsing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { captureMultipartBody, parseMultipartForm } = require('../src/multipart');

/** Build a multipart body with a text field and an unmodified file payload. */
function multipart(payload, name = 'bundle') {
    return Buffer.concat([
        Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="replace"\r\n\r\nfalse\r\n--test-boundary\r\nContent-Disposition: form-data; name="${name}"; filename="test.source.transaction.json"\r\nContent-Type: application/json\r\n\r\n`),
        payload, Buffer.from('\r\n--test-boundary--\r\n')
    ]);
}

/** Run a disposable HTTP receiver with a small limit, without any FHIR mutation. */
async function receiver(t, limit = 512) {
    const app = express();
    let handled = 0;
    app.use((req, res, next) => captureMultipartBody(req, res, next, limit));
    app.use((req, res) => {
        handled++;
        const parsed = parseMultipartForm(req);
        const streamed = req.rawMultipartWasStreamed === true;
        const temporary = req.rawBodyPath;
        req.rawBodyCleanup?.();
        res.json({ handled, streamed, temporaryRemoved: temporary ? !fs.existsSync(temporary) : true,
            payload: parsed.files.bundle?.buffer.toString('hex') });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const close = () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
    t.after(close);
    return { url: `http://127.0.0.1:${server.address().port}`, handled: () => handled, server, close };
}

test('accepted clinical uploads stream to disk and preserve the file bytes', { timeout: 15000 }, async t => {
    const { url } = await receiver(t);
    const payload = Buffer.from([0, 255, 13, 10, 34, 92]);
    const response = await fetch(`${url}/api/fhir-servers/ho-a/imports`, {
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test-boundary' }, body: multipart(payload)
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { handled: 1, streamed: true, temporaryRemoved: true, payload: payload.toString('hex') });
});

test('known oversized uploads return readable HTTP 413 without reaching the import handler', { timeout: 15000 }, async t => {
    const { url, handled } = await receiver(t);
    const response = await fetch(`${url}/api/fhir-servers/ho-a/imports`, {
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test-boundary' }, body: multipart(Buffer.alloc(2048))
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /exceeds 0\.000512 MB \(512 bytes\).*clinicalData.limits.maxBytes/);
    assert.equal(handled(), 0);
});

for (const endpoint of ['/api/fhir-servers/ho-a/imports', '/config/certificate']) {
    test(`chunked oversized upload returns one HTTP 413 for ${endpoint}`, { timeout: 15000 }, async t => {
        const { url, handled } = await receiver(t);
        const result = await new Promise((resolve, reject) => {
            const request = http.request(`${url}${endpoint}`, { method: 'POST', headers: {
                'Content-Type': 'multipart/form-data; boundary=test-boundary', 'Transfer-Encoding': 'chunked'
            } }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
            });
            request.on('error', reject);
            request.write(Buffer.alloc(400));
            request.write(Buffer.alloc(400));
            request.end(Buffer.alloc(400));
        });
        assert.equal(result.status, 413);
        assert.match(result.body.error, /exceeds 0\.000512 MB \(512 bytes\)/);
        assert.equal(handled(), 0);
    });
}

test('multipart parsing preserves UTF-8, quoted boundaries and embedded boundary text', () => {
    const payload = Buffer.from('שלום\r\n--test-boundary is content\r\n');
    const parsed = parseMultipartForm({ rawBody: multipart(payload, 'certificate'), get: () => 'multipart/form-data; boundary="test-boundary"' });
    assert.equal(parsed.fields.replace, 'false');
    assert.deepEqual(parsed.files.certificate.buffer, payload);
    assert.equal(parsed.files.certificate.content, payload.toString('utf8'));
});

test('non-multipart requests bypass capture', () => {
    let called = false;
    captureMultipartBody({ get: () => 'application/json' }, {}, () => { called = true; }, 512);
    assert.equal(called, true);
});

/** Test large declared sizes without allocating a deployment-sized upload. */
test('large upload headers use the shared ceiling and readable 413 units', async () => {
    const { PassThrough } = require('node:stream');
    const { DEFAULT_LIMITS } = require('../../shared/clinical-import-limits');
    const limit = DEFAULT_LIMITS.maxBytes + 1048576;
    for (const size of [700 * 1048576, limit, limit + 1]) {
        const req = new PassThrough();
        req.method = 'POST';
        req.path = '/api/fhir-servers/ho-a/imports';
        req.get = name => name === 'content-type' ? 'multipart/form-data; boundary=test-boundary' : String(size);
        let accepted = false;
        let rejected = false;
        const res = { status(code) { assert.equal(code, 413); return this; }, json(body) {
            rejected = true;
            assert.match(body.error, /exceeds 806\.4 MB \(806354944 bytes\)/);
        } };
        await new Promise((resolve, reject) => {
            captureMultipartBody(req, res, error => {
                if (error) return reject(error);
                accepted = true;
                req.rawBodyCleanup();
                resolve();
            }, limit);
            req.end(multipart(Buffer.from('{}')));
            if (rejected) resolve();
        });
        assert.equal(accepted, size <= limit);
        assert.equal(rejected, size > limit);
    }
});

/** A cancelled upload must not keep a failed test's owned listener alive forever. */
test('receiver teardown closes an unfinished multipart request without invoking import', { timeout: 15000 }, async t => {
    const f = await receiver(t), received = require('node:events').once(f.server, 'request');
    const request = http.request(f.url + '/api/fhir-servers/ho-a/imports', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test-boundary' } });
    const interrupted = new Promise(resolve => request.once('error', resolve));
    request.write('--test-boundary\r\n');
    await received; await f.close();
    assert.equal((await interrupted).code, 'ECONNRESET');
    assert.equal(f.handled(), 0);
});
