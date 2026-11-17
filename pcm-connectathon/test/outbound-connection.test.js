'use strict';
/** Real local-client regressions for the always-on AWS connection boundary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseOutboundUrl, guardedFetch } = require('../../src/shared/outbound-destination');

test('canonical AWS literals are rejected', () => {
    for (const host of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '2852039166', '0xa9fea9fe', '[fd00:ec2::254]']) {
        assert.throws(() => parseOutboundUrl(`http://${host}/`), /AWS/);
    }
});

test('the connection uses the validated DNS answer and rejects mixed answers and redirects', async t => {
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls++;
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: 'http://[::ffff:a9fe:a9fe]/' });
        }
        res.end(req.headers.host);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://participant.test:${server.address().port}`;
    let lookups = 0;
    const lookup = async () => { lookups++; return [{ address: lookups === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }]; };
    const response = await guardedFetch(url, {}, { lookup });
    assert.equal(await response.text(), new URL(url).host);
    assert.equal(lookups, 1);
    await assert.rejects(guardedFetch(url, {}, { lookup: async () => [
        { address: '127.0.0.1', family: 4 }, { address: '::ffff:a9fe:a9fe', family: 6 }
    ] }), /AWS/);
    await assert.rejects(guardedFetch(`${url}/redirect`, {}, {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }]
    }), /redirect|AWS/);
    assert.equal(calls, 2);
});

test('HTTPS preserves participant Host and TLS identity and ignores environment proxies', async t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const https = require('node:https');
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=participant.test', '-addext', 'subjectAltName=DNS:participant.test',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    let requests = 0;
    const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, (req, res) => {
        requests++;
        res.end(JSON.stringify({ host: req.headers.host, sni: req.socket.servername }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    t.after(async () => {
        if (proxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = proxy;
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const port = server.address().port;
    const options = { tls: { ca: cert }, lookup: async () => [{ address: '127.0.0.1', family: 4 }] };
    const response = await guardedFetch(`https://participant.test:${port}/`, {}, options);
    assert.deepEqual(await response.json(), { host: `participant.test:${port}`, sni: 'participant.test' });
    await assert.rejects(guardedFetch(`https://wrong.test:${port}/`, {}, options), /altname|certificate/i);
    assert.equal(requests, 1);
});

test('permitted read redirects remain bounded and mutations never redirect', async t => {
    let calls = 0;
    const server = http.createServer((req, res) => {
        calls++;
        if (req.url !== '/done') res.writeHead(302, { Location: req.url === '/loop' ? '/loop' : '/done' });
        res.end('participant');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await (await guardedFetch(`${url}/start`, {}, { maxRedirects: 1 })).text(), 'participant');
    await assert.rejects(guardedFetch(`${url}/loop`, {}, { maxRedirects: 1 }), /redirect/);
    await assert.rejects(guardedFetch(`${url}/start`, { method: 'POST', body: 'synthetic' }, { maxRedirects: 1 }), /redirect/);
    assert.equal(calls, 5);
});

test('malformed upstream headers reject the request and leave subsequent requests usable', async t => {
    const net = require('node:net');
    const { guardedAxiosConfig } = require('../../src/shared/outbound-destination');
    let calls = 0;
    const server = net.createServer(socket => socket.once('data', () => {
        calls++;
        socket.end(`HTTP/1.1 200 OK\r\n${calls === 1 ? ': invalid\r\n' : ''}Content-Length: 2\r\nConnection: close\r\n\r\nOK`);
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const options = { protocol: 'http:', hostname: '127.0.0.1', port: server.address().port };
    const transport = guardedAxiosConfig().transport;
    const fetch = () => new Promise((resolve, reject) => {
        transport.request(options, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(body));
        }).on('error', reject).end();
    });
    await assert.rejects(fetch(), /header/i);
    assert.equal(await fetch(), 'OK');
    assert.equal(calls, 2);
});

test('an upstream response callback exception becomes a bounded request rejection', async t => {
    const { guardedAxiosConfig } = require('../../src/shared/outbound-destination');
    const server = http.createServer((req, res) => res.end('OK'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const options = { protocol: 'http:', hostname: '127.0.0.1', port: server.address().port };
    await assert.rejects(new Promise((resolve, reject) => {
        guardedAxiosConfig().transport.request(options, () => {
            throw new Error('response normalization failed');
        }).on('error', reject).end();
    }), /response normalization failed/);
});
