'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
// Each Node test worker owns its log rotation directory.
const testLogs = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ds-adapter-test-'));
const previousLogDir = process.env.LOG_DIR;
process.env.LOG_DIR = testLogs;
test.after(() => {
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    fs.rmSync(testLogs, { recursive: true, force: true });
});
const { createApp } = require('../src/index');

const config = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json'),
    'utf8'
));

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

test('private FHIR relay preserves the authorized request binding and complete response', async () => {
    let observed;
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            observed = { method: req.method, url: req.url, headers: req.headers, body };
            if (req.url.endsWith('/redirect')) {
                res.writeHead(302, { location: 'http://[::ffff:a9fe:a9fe]/' });
                res.end();
                return;
            }
            res.setHeader('content-type', 'application/fhir+json');
            res.setHeader('etag', 'W/"relay-test"');
            res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 1 }));
        });
    });
    const upstreamPort = await listen(upstream);
    const runtime = createApp({
        config,
        env: { ...process.env, HO_ID: 'ho-a', DS_ADAPTER_BODY_LIMIT: '64kb' },
        bindings: {
            hoId: 'ho-a',
            rootCaPath: '/does/not/matter-for-http',
            timeout: 2000
        }
    });
    const adapter = http.createServer(runtime.app);
    const adapterPort = await listen(adapter);
    try {
        const response = await fetch(`http://127.0.0.1:${adapterPort}/fhir-proxy/Patient?_summary=count`, {
            headers: {
                'x-original-uri': '/fhir/Patient?_summary=count',
                'x-original-method': 'GET',
                'x-local-token': 'signed-private-token',
                'x-pcm-upstream-base': `http://127.0.0.1:${upstreamPort}/fhir`,
                'x-pcm-upstream-verify': 'off',
                'x-correlation-id': 'relay-correlation'
            }
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('etag'), 'W/"relay-test"');
        assert.deepEqual(await response.json(), { resourceType: 'Bundle', type: 'searchset', total: 1 });
        assert.equal(observed.method, 'GET');
        assert.equal(observed.url, '/fhir/Patient?_summary=count');
        assert.equal(observed.headers.authorization, 'Bearer signed-private-token');
        assert.equal(observed.headers['x-pcm-request-uri'], '/fhir/Patient?_summary=count');
        assert.equal(observed.headers['x-correlation-id'], 'relay-correlation');
        assert.equal(observed.body, '');
        const head = await fetch(`http://127.0.0.1:${adapterPort}/fhir-proxy/Patient`, {
            method: 'HEAD', headers: {
                'x-original-uri': '/fhir/Patient', 'x-original-method': 'HEAD',
                'x-local-token': 'signed-private-token',
                'x-pcm-upstream-base': `http://127.0.0.1:${upstreamPort}/fhir`
            }
        });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        assert.equal(observed.method, 'HEAD');
        const redirected = await fetch(`http://127.0.0.1:${adapterPort}/fhir-proxy/redirect`, {
            redirect: 'manual', headers: {
                'x-original-uri': '/fhir/redirect', 'x-original-method': 'GET',
                'x-local-token': 'signed-private-token',
                'x-pcm-upstream-base': `http://127.0.0.1:${upstreamPort}/fhir`
            }
        });
        assert.equal(redirected.status, 502);
        assert.equal(redirected.headers.get('location'), null);
        assert.equal(observed.url, '/fhir/redirect');

    } finally {
        await close(adapter);
        await close(upstream);
    }
});

test('FHIR POST bytes survive relay and invalid input is rejected before upstream', async t => {
    const bodies = [];
    const upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { bodies.push(Buffer.concat(chunks).toString()); res.end('{}'); });
    });
    const port = await listen(upstream);
    const { app } = createApp({ config, env: { DS_ADAPTER_BODY_LIMIT: '128b' },
        bindings: { hoId: 'ho-a', timeout: 2000 } });
    const adapter = http.createServer(app);
    const adapterPort = await listen(adapter);
    t.after(async () => { await close(adapter); await close(upstream); });
    const send = (body, type = 'application/fhir+json; charset=utf-8') => fetch(`http://127.0.0.1:${adapterPort}/fhir-proxy/`, {
        method: 'POST', body, headers: {
            'content-type': type, 'x-original-uri': '/fhir/', 'x-original-method': 'POST',
            'x-local-token': 'signed-token', 'x-pcm-upstream-base': `http://127.0.0.1:${port}/fhir`
        }
    });
    const body = ' { "resourceType": "Bundle", "type": "batch", "entry": [], "id": "שלום" }\n';
    for (const type of ['application/json', 'application/fhir+json; charset=utf-8']) {
        assert.equal((await send(body, type)).status, 200);
        assert.equal(bodies.at(-1), body);
        const entries = fs.readFileSync(path.join(testLogs, 'current.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const requestLog = entries.filter(entry => entry.details.type === 'REQUEST' && entry.details.method === 'POST').at(-1);
        const responseLog = entries.filter(entry => entry.details.type === 'RESPONSE' && entry.details.method === 'POST').at(-1);
        assert.equal(requestLog.details.body, body, 'request logs retain the exact FHIR POST bytes');
        assert.equal(responseLog.details.headers['content-length'], '2');
        assert.deepEqual(responseLog.details.body, {});
    }
    for (const [payload, type, status] of [
        ['{', 'application/fhir+json', 400], ['', 'application/fhir+json', 400],
        ['{}', 'text/plain', 415], ['{}', 'application/fhir+json; charset=utf-16le', 415], [JSON.stringify({ id: 'x'.repeat(128) }), 'application/fhir+json', 413]
    ]) assert.equal((await send(payload, type)).status, status);
    assert.equal(bodies.length, 2);
});

test('repeated FHIR searches and batches require fresh HAPI results despite caller cache hints', async t => {
    let requests = 0;
    const upstream = http.createServer((req, res) => {
        assert.equal(req.headers['cache-control'], 'no-cache');
        req.resume();
        req.on('end', () => res.end(JSON.stringify({ resourceType: 'Bundle', total: ++requests })));
    });
    const upstreamPort = await listen(upstream);
    const { app } = createApp({ config, env: {}, bindings: { hoId: 'ho-a', timeout: 2000 } });
    const adapter = http.createServer(app);
    const port = await listen(adapter);
    t.after(async () => { await close(adapter); await close(upstream); });
    for (const [index, method] of ['GET', 'GET', 'POST'].entries()) {
        const uri = method === 'GET' ? '/fhir/Patient?identifier=example%7C1' : '/fhir';
        const response = await fetch(`http://127.0.0.1:${port}/fhir-proxy`, {
            method,
            ...(method === 'POST' ? { body: '{"resourceType":"Bundle","type":"batch","entry":[]}' } : {}),
            headers: {
                'content-type': 'application/fhir+json', 'cache-control': 'max-age=3600',
                'x-original-uri': uri, 'x-original-method': method,
                'x-local-token': 'signed-token', 'x-pcm-upstream-base': `http://127.0.0.1:${upstreamPort}/fhir`
            }
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).total, index + 1);
    }
    assert.equal(requests, 3);
});

test('a replay override still performs introspection and denies an inactive token', async t => {
    let calls = 0;
    const value = structuredClone(config);
    value.conformance.preset = 'connectathon-balanced';
    value.security.dsFhirServer.enforceMappedPatients = true;
    value.securitySimulation.global = { ...require('../../shared/conformance-policy').presetSimulationDefaults('connectathon-balanced'), clientAssertionReplay: false };
    const { app } = createApp({ config: value, env: {}, bindings: { hoId: 'ho-a' },
        client: { introspect: async token => { assert.equal(token, 'inactive-token'); calls++; return { active: false }; } } });
    const adapter = http.createServer(app);
    const port = await listen(adapter);
    t.after(() => close(adapter));
    const response = await fetch(`http://127.0.0.1:${port}/auth-check`, { headers: {
        authorization: 'Bearer inactive-token', 'x-original-uri': '/fhir/Observation', 'x-original-method': 'GET'
    } });
    assert.equal(response.status, 401);
    assert.equal(calls, 1);
});

test('source JSON parser adopts non-default mounted limits on the next request and honors explicit restart-only environment override', async t => {
    const current = structuredClone(config); current.presence.sources = { 'ho-a': { maxPayloadBytes: 2100000 }, 'ho-b': {maxPayloadBytes:4000000} };
    const file = path.join(testLogs,'limits-config.json'); fs.writeFileSync(file,JSON.stringify(current));
    const upstream = http.createServer((req,res)=>{req.resume();req.on('end',()=>res.end('{}'));});
    const upstreamPort = await listen(upstream);
    const env = {...process.env,TEAM_CONFIG_PATH:file,HO_ID:'ho-a'};
    const runtime = createApp({env,bindings:{hoId:'ho-a',timeout:2000}});
    const adapter = http.createServer(runtime.app), port = await listen(adapter);
    t.after(async()=>{await close(adapter);await close(upstream);});
    const send = (size, destination = port) => fetch(`http://127.0.0.1:${destination}/fhir-proxy/`,{method:'POST',body:JSON.stringify({value:'é'.repeat((size-12)/2)}),headers:{'content-type':'application/fhir+json','x-original-uri':'/fhir/','x-original-method':'POST','x-local-token':'owned-test-token','x-pcm-upstream-base':`http://127.0.0.1:${upstreamPort}/fhir`}});
    assert.equal((await send(2100000)).status,200);
    assert.equal((await send(2100002)).status,413,'other source larger budget cannot change the selected parser');
    current.presence.sources['ho-a'].maxPayloadBytes=2200000; current.runtime.revision++;
    fs.writeFileSync(file,JSON.stringify(current));
    assert.equal((await send(2100002)).status,200,'mounted source config reloads without recreating app');
    assert.equal((await send(2200002)).status,413);
    assert.equal(require('../src/index').normalizationConfiguration(current,'ho-a').presenceLimits.maxPayloadBytes,2200000);
    const recreated = http.createServer(createApp({env:{...env,DS_ADAPTER_BODY_LIMIT:'128b'},bindings:{hoId:'ho-a',timeout:2000}}).app);
    const recreatedPort = await listen(recreated); t.after(() => close(recreated));
    assert.equal((await send(1024,recreatedPort)).status,413,'recreated process uses its explicit environment ceiling');
    assert.equal((await send(1024)).status,200,'original process retains its original environment contract');
});

test('form search preserves combined URL and repeated encoded bytes, rejects invalid transports, and logs the external POST', async t => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
        const chunks = []; req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); res.end('{}'); });
    });
    const upstreamPort = await listen(upstream);
    const { app } = createApp({ config, env: { DS_ADAPTER_BODY_LIMIT: '128b' }, bindings: { hoId: 'ho-a', timeout: 2000 } });
    const adapter = http.createServer(app), port = await listen(adapter);
    t.after(async () => { await close(adapter); await close(upstream); });
    const uri = '/fhir/Observation/_search?status=final';
    const send = (body, type = 'application/x-www-form-urlencoded; charset=UTF-8') => fetch(`http://127.0.0.1:${port}/fhir-proxy/Observation/_search?status=final`, {
        method: 'POST', body, headers: { 'content-type': type, 'x-original-uri': uri, 'x-original-method': 'POST',
            'x-pcm-request-method': 'GET', 'x-pcm-request-uri': '/fhir/Patient', 'x-local-token': 'signed-token',
            'x-correlation-id': 'post-form-relay', 'x-pcm-upstream-base': `http://127.0.0.1:${upstreamPort}/fhir` }
    });
    const form = 'code=a%7Cb&code=c%7Cd&_security%3Anot=x%7Cr&subject=Patient%2Fp&name=a+b';
    assert.equal((await send(form)).status, 200);
    assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, uri); assert.equal(seen[0].body, form);
    assert.equal(seen[0].headers['x-pcm-request-method'], 'POST'); assert.equal(seen[0].headers['x-pcm-request-uri'], uri);
    assert.equal((await send('')).status, 200, 'empty form retains the ordinary unqualified search contract');
    for (const [body, type, status] of [[form, 'text/plain', 415], ['{}', 'application/json', 415],
        ['x=%ZZ', undefined, 400], ['x=%C3%28', undefined, 400], ['x=1', 'application/x-www-form-urlencoded; charset=utf-16le', 415],
        ['x=' + 'a'.repeat(127), undefined, 413]]) {
        assert.equal((await send(body, type)).status, status);
    }
    assert.equal(seen.length, 2);
    const logs = fs.readFileSync(path.join(testLogs, 'current.log'), 'utf8').trim().split('\n').map(JSON.parse);
    const request = logs.find(row => row.details.type === 'REQUEST' && row.details.correlationId === 'post-form-relay');
    assert.equal(request.details.method, 'POST'); assert.equal(request.details.body, form);
    assert.ok(logs.some(row => row.details.type === 'RESPONSE' && row.details.correlationId === 'post-form-relay' && row.details.statusCode === 415));
});
