'use strict';

/** Reachable parser/proxy regressions for the reviewed Node 24 dependency update. */
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const zlib = require('node:zlib');
const express = require('express');

/**
 * Send synthetic bytes to the owned loopback application with a fixture deadline.
 * @param {number} port Owned HTTP listener port.
 * @param {Buffer} bytes JSON or compressed fixture payload.
 * @param {object} headers Optional encoding headers.
 * @returns {Promise<number>} Observed HTTP response status.
 */
function post(port, bytes, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path: '/', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, ...headers } }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.setTimeout(5000, () => request.destroy(new Error('owned parser fixture did not respond')));
        request.on('error', reject);
        request.end(bytes);
    });
}

test('compressed JSON accepts valid input and malformed trailing bytes cannot terminate later requests', async t => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/', (request, response) => response.json({ accepted: true }));
    app.use((error, request, response, next) => response.status(error.status || 500).json({ rejected: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const body = Buffer.from('{"synthetic":true}');
    const compressed = zlib.gzipSync(body);
    assert.equal(await post(server.address().port, compressed, { 'Content-Encoding': 'gzip' }), 200);
    const malformed = Buffer.concat([compressed, Buffer.from('invalid trailing compressed frame')]);
    assert.equal(await post(server.address().port, malformed, { 'Content-Encoding': 'gzip' }), 400);
    assert.equal(await post(server.address().port, body), 200, 'process remains available after invalid compressed input');
});

test('IPv4-mapped short trust subnets cannot authorize unrelated IPv4 clients', () => {
    const proxyAddress = require('proxy-addr');
    const trusted = proxyAddress.compile(['::ffff:10.0.0.0/8']);
    assert.equal(trusted('203.0.113.12'), false);
    assert.equal(proxyAddress.compile(['10.0.0.0/8'])('10.1.2.3'), true);
});

test('query parser/stringifier preserves ordinary fields without invoking attacker-controlled isBuffer', () => {
    const qs = require('qs');
    const parsed = qs.parse('x%5Bconstructor%5D%5BisBuffer%5D=y&ordinary=synthetic', { plainObjects: true });
    assert.doesNotThrow(() => qs.stringify(parsed));
    assert.equal(qs.parse(qs.stringify({ ordinary: 'synthetic', repeated: ['a', 'b'] })).ordinary, 'synthetic');
});

/** Inherited HTTP/2 configuration must never replace the caller's ordinary HTTP path. */
test('Axios ignores inherited HTTP version while preserving an explicit loopback request', async t => {
    const axios = require('axios');
    const server = http.createServer((request, response) => response.end('synthetic'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'httpVersion');
    try {
        Object.defineProperty(Object.prototype, 'httpVersion', { value: 2, configurable: true, writable: true });
        const response = await axios.get(`http://127.0.0.1:${server.address().port}/`, { proxy: false, timeout: 5000 });
        assert.equal(response.status, 200);
        assert.equal(response.data, 'synthetic');
    } finally {
        if (previous) Object.defineProperty(Object.prototype, 'httpVersion', previous);
        else delete Object.prototype.httpVersion;
    }
});
