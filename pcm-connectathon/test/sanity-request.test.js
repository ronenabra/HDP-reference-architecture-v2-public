'use strict';

/** Exercise actual local sockets and redirect boundaries used by Admin sanity. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request } = require('../scripts/sanity-request');

test('sanity isolates probe sockets and follows only explicitly allowed UI mutations', async () => {
    let connections = 0;
    let arrivals = 0;
    const server = http.createServer((req, res) => {
        arrivals++;
        if (req.url === '/redirect') { res.writeHead(303, { Location: '/done' }); res.end(); }
        else if (req.url === '/external') { res.writeHead(302, { Location: 'http://[::ffff:169.254.169.254]/' }); res.end(); }
        else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ method: req.method })); }
    });
    server.on('connection', () => { connections++; });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await request('GET', base)).statusCode, 200);
        assert.equal((await request('GET', base)).statusCode, 200);
        assert.equal(connections, 2);
        assert.match((await request('POST', `${base}/redirect`, { form: { token: 'synthetic' } })).error, /redirect prohibited/);
        const ui = await request('POST', `${base}/redirect`, { form: { action: 'synthetic' }, followUiRedirects: true });
        assert.deepEqual(ui.json, { method: 'GET' });
        assert.match((await request('GET', `${base}/external`)).error, /redirect prohibited/);
        assert.equal(arrivals, 6);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('sanity blocks mapped credential addresses before opening a socket', async () => {
    const result = await request('GET', 'http://[::ffff:169.254.169.254]/');
    assert.match(result.error, /AWS|credential|metadata|blocked/i);
    assert.equal(result.statusCode, undefined);
});

test('sanity selects an active managed HO when the legacy source is disabled', () => {
    const { referenceDataSourceUrl } = require('../scripts/sanity-request');
    const config = { legacyDataSource: { enabled: true }, healthOrganizations: [{ id: 'ho-a' }],
        publicBaseUrls: { referenceDataSource: 'https://legacy.test/fhir', healthOrganizations: { 'ho-a': 'https://ho-a.test/fhir' } } };
    assert.equal(referenceDataSourceUrl(config), 'https://legacy.test/fhir');
    config.legacyDataSource.enabled = false;
    assert.equal(referenceDataSourceUrl(config), 'https://ho-a.test/fhir');
    assert.equal(referenceDataSourceUrl(config, 'https://explicit.test/fhir'), 'https://explicit.test/fhir');
});

test('private fixture transport enforces bytes, absolute deadline and no credential redirects', async t => {
    let redirected = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/target' }); res.end(); }
        else if (req.url === '/target') { redirected++; res.end('{}'); }
        else if (req.url === '/large') res.end('x'.repeat(4096));
        else { res.writeHead(200); const timer = setInterval(() => res.write('x'), 10); res.on('close', () => clearInterval(timer)); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.match((await request('GET', `${base}/large`, { maxResponseBytes: 1024 })).error, /byte limit/);
    const slow = await request('GET', `${base}/slow`, { timeout: 80, maxResponseBytes: 1024 });
    assert.equal(slow.error, 'timeout'); assert.ok(slow.durationMs < 1500);
    assert.match((await request('GET', `${base}/redirect`, { prohibitRedirects: true, headers: { 'X-PCM-Import-Credential': 'test-only' } })).error, /redirect prohibited/);
    assert.equal(redirected, 0);
});
