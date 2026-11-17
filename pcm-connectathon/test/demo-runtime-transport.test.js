'use strict';

/** Qualification probes use one real mTLS connection and never replay a failed request. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), https = require('node:https'), crypto = require('node:crypto');
const { createRequire } = require('node:module');

/** Load the actual probe with only its deployment paths/client replaced by owned test fixtures. */
function probe(directory, options = {}) {
    const filename = path.resolve(__dirname, '../../clinical-data/test/demo-runtime-client.js'), actualRequire = createRequire(filename);
    const module = { exports: {} }, config = { certificateRoles: { serviceProvider: { mtls: { cert: 'sp-client.crt', key: 'sp-client.key' } } }, ...options.config };
    const fixtureFs = { ...fs, readFileSync(file, ...options) {
        if (file === '/runtime/team-config.json') return JSON.stringify(config);
        return fs.readFileSync(String(file).startsWith('/runtime/certs/') ? path.join(directory, path.basename(file)) : file, ...options);
    } };
    vm.runInNewContext(fs.readFileSync(process.env.PCM_DEMO_RUNTIME_SOURCE || filename, 'utf8'), { module, exports: module.exports, Buffer, URL, URLSearchParams, AbortSignal,
        process: { env: { TEAM_ADMIN_PASSWORD: 'synthetic-fixture' } }, fetch: options.fetch,
        require: name => name === '/app/src/client' ? options.client || {} : name === '/shared/data-authorization-details'
            ? actualRequire('../../src/shared/data-authorization-details') : name === 'fs' ? fixtureFs : actualRequire(name) }, { filename });
    return options.exports ? module.exports : module.exports.request;
}

/** Start a real registered-cert peer that refuses reused sockets, modelling a reload boundary. */
async function fixture(t) {
    const owned = require('../../test-support/certificates').generateCertificates(); t.after(owned.cleanup);
    const certificate = name => fs.readFileSync(path.join(owned.directory, name));
    const requests = [], peers = [], seen = new WeakSet();
    const server = https.createServer({ key: certificate('pcm-core.key'), cert: certificate('pcm-core.crt'), ca: certificate('rootCA.crt'), requestCert: true, rejectUnauthorized: true }, (request, response) => {
        requests.push({ path: request.url, reused: seen.has(request.socket) });
        peers.push({ authorized: request.socket.authorized, fingerprint: request.socket.getPeerCertificate().fingerprint256 });
        if (request.url === '/refuse' || seen.has(request.socket)) return request.socket.destroy();
        seen.add(request.socket); response.setHeader('Connection', 'keep-alive'); response.end('{"observed":true}');
    });
    server.keepAliveTimeout = 60000;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const previous = https.globalAgent, pooled = new https.Agent({ keepAlive: true }); https.globalAgent = pooled;
    t.after(() => { pooled.destroy(); https.globalAgent = previous; });
    return { url: `https://127.0.0.1:${server.address().port}`, request: probe(owned.directory), requests, peers,
        fingerprint: new crypto.X509Certificate(certificate('sp-client.crt')).fingerprint256 };
}

test('separate probes retain exact mTLS identity across a peer reload boundary', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    assert.equal((await f.request(f.url + '/first')).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.request(f.url + '/second')).status, 200);
    assert.deepEqual(f.requests, [{ path: '/first', reused: false }, { path: '/second', reused: false }]);
    assert.ok(f.peers.every(peer => peer.authorized && peer.fingerprint === f.fingerprint));
});

/** Actual TLS token peer; only its PCM authorization decision is controlled for this probe regression. */
async function tokenFixture(t, { status = 403, active = false } = {}) {
    const owned = require('../../test-support/certificates').generateCertificates(); t.after(owned.cleanup);
    const certificate = name => fs.readFileSync(path.join(owned.directory, name)), events = [], requests = [];
    const consent = { id: crypto.randomUUID(), status: active ? 'active' : 'proposed',
        identifier: [{ system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'PCM-CONSENT-UNIT' }],
        patient: { identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' } } };
    const server = https.createServer({ key: certificate('pcm-core.key'), cert: certificate('pcm-core.crt'), ca: certificate('rootCA.crt'), requestCert: true, rejectUnauthorized: true }, (request, response) => {
        let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
            events.push('wire'); requests.push({ method: request.method, path: request.url, form: Object.fromEntries(new URLSearchParams(body)),
                authorized: request.socket.authorized, fingerprint: request.socket.getPeerCertificate().fingerprint256 });
            response.statusCode = status; response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(status === 200 ? { access_token: 'synthetic-token', scope: 'patient/Patient.rs' } : { error: 'access_denied' }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const url = `https://127.0.0.1:${server.address().port}`;
    const api = probe(owned.directory, { exports: true, config: { internalBaseUrls: { pcmAuth: url, pcmUi: url },
        healthOrganizations: [{ endpoint: 'https://owned-source.invalid/fhir' }], contract: { operational: { fhirBase: 'https://logical.invalid/fhir' } } },
        client: { _test: { generateClientAssertion(identity, _, audience) {
            assert.equal(identity, 'hospital-a'); assert.equal(audience, 'https://logical.invalid/fhir/token'); return 'synthetic-signed-assertion';
        } } }, fetch: async () => {
            events.push('oracle'); assert.ok(active, 'a proposed Consent has no saved approval oracle');
            return { status: 200, json: async () => ({ diagnostics: { schema: 'pcm-consumer-review/1', visibility: 'diagnostic', approvals: {
                [consent.id]: { publicBinding: { identifier: consent.identifier, patient: consent.patient }, snapshot: { usable: true, scope: 'patient/Patient.rs' } }
            } } }) };
        } });
    return { api, consent, events, requests, fingerprint: new crypto.X509Certificate(certificate('sp-client.crt')).fingerprint256 };
}

test('an unapproved Consent rejection reaches actual mTLS OAuth without a nonexistent approval oracle', { timeout: 15000 }, async t => {
    const f = await tokenFixture(t);
    const result = await f.api.issue(f.consent, 'patient/Patient.rs');
    assert.equal(result.status, 403); assert.deepEqual(f.events, ['wire']); assert.equal(f.requests.length, 1);
    const request = f.requests[0]; assert.equal(request.method, 'POST'); assert.equal(request.path, '/token');
    assert.equal(request.form.scope, 'patient/Patient.rs'); assert.equal(request.form.client_assertion, 'synthetic-signed-assertion');
    assert.equal(request.authorized, true); assert.equal(request.fingerprint, f.fingerprint);
    assert.equal(JSON.parse(request.form.authorization_details)[0].fhirContext[0].identifier.value, 'PCM-CONSENT-UNIT');
});

test('a wrong successful token for a proposed Consent fails qualification and never becomes an approved grant', { timeout: 15000 }, async t => {
    const f = await tokenFixture(t, { status: 200 });
    await assert.rejects(f.api.issue(f.consent, 'patient/Patient.rs'), /proposed|unapproved|pending/i);
    assert.deepEqual(f.events, ['wire']); assert.equal(f.requests.length, 1);
});

test('approved probes retain their exact prior oracle, request and frozen scope checks', { timeout: 15000 }, async t => {
    const f = await tokenFixture(t, { status: 200, active: true });
    const result = await f.api.issue(f.consent, 'patient/Patient.rs'); assert.equal(result.status, 200);
    assert.deepEqual(f.events, ['oracle', 'wire']); assert.equal(f.requests.length, 1);
    assert.equal(result.json.scope, 'patient/Patient.rs'); assert.equal(f.requests[0].authorized, true);
});

test('a genuine transport refusal remains a single failed attempt without POST replay', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    await assert.rejects(f.request(f.url + '/refuse', { method: 'POST', body: { marker: 'one attempt' } }), error => error.code === 'ECONNRESET');
    assert.deepEqual(f.requests, [{ path: '/refuse', reused: false }]);
    assert.equal(f.peers[0].fingerprint, f.fingerprint);
});
