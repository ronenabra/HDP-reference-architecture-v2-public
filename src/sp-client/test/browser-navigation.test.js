'use strict';
/** Navigation resolution retains protocol/port/path without changing security bases. */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { browserNavigation, browserOrigin } = require('../../shared/browser-navigation');

/** Model Express's trusted-proxy decision without accepting raw forwarded headers. */
function request(host, { trusted = false, forwarded, protocol = 'http' } = {}) {
    return { protocol, socket: { remoteAddress: '127.0.0.1' },
        app: { get: () => () => trusted },
        get: name => ({ host, 'x-forwarded-host': forwarded })[name] };
}
const bases = { spClient: 'http://localhost:13100/doctor', pcmUi: 'https://localhost:14100/pcm',
    pcmApi: 'https://localhost:14101/api/fhir-service/r4' };
for (const hostname of ['localhost', '127.0.0.1', '192.0.2.10', 'sandbox.example.test', '[2001:db8::1]']) {
    test(`cross-app links retain destination scheme, port and prefix from ${hostname}`, () => {
        const resolved = browserNavigation(bases, request(`${hostname}:14100`), 'pcmUi');
        assert.equal(resolved.spClient, `http://${hostname}:13100/doctor`);
        assert.equal(resolved.pcmUi, '/pcm');
        assert.equal(resolved.pcmApi, bases.pcmApi);
        assert.equal(bases.spClient, 'http://localhost:13100/doctor');
    });
}
test('Doctor local logs stay on the browser origin and central logs retain filters', () => {
    const resolved = browserNavigation(bases, request('192.0.2.10:13100'), 'spClient');
    assert.equal(resolved.spClient, '/doctor');
    assert.equal(`${resolved.pcmUi}/logs-view?role=adapter&diagnostics=true`, 'https://192.0.2.10:14100/pcm/logs-view?role=adapter&diagnostics=true');
});
test('explicit external application URLs remain authoritative', () => {
    assert.equal(browserNavigation({ ...bases, spClient: 'https://doctor.example.test/app' }, request('remote.test:4100'), 'pcmUi').spClient,
        'https://doctor.example.test/app');
});
test('untrusted forwarded host is ignored and configured proxy trust is respected', () => {
    assert.equal(browserOrigin(request('direct.test:4100', { forwarded: 'spoof.test' })), 'http://direct.test:4100');
    assert.equal(browserOrigin(request('internal:3001', { trusted: true, protocol: 'https', forwarded: 'proxy.test:443, ignored.test' })), 'https://proxy.test');
});
test('actual Express request keeps default proxy boundary closed', async t => {
    const app = express();
    app.get('/', (req, res) => res.json({ origin: browserOrigin(req), links: browserNavigation(bases, req, 'pcmUi') }));
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(resolve)));
    await new Promise(resolve => server.once('listening', resolve));
    const data = await new Promise((resolve, reject) => {
        require('node:http').get({ hostname: '127.0.0.1', port: server.address().port, headers: { Host: 'reachable.test:14100', 'X-Forwarded-Host': 'spoof.test', 'X-Forwarded-Proto': 'https' } }, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
    });
    assert.equal(data.origin, 'http://reachable.test:14100');
    assert.equal(data.links.spClient, 'http://reachable.test:13100/doctor');
});
test('absent request or malformed host does not rewrite configured identities', () => {
    assert.deepEqual(browserNavigation(bases, null, 'pcmUi'), bases);
    assert.deepEqual(browserNavigation(bases, request('bad host'), 'pcmUi'), bases);
});

test('PCM workflow uses its HTTPS listener and preserves trusted browser host and declared prefix', () => {
    const { pcmWorkflowUrl, browserDestination } = require('../../shared/browser-navigation');
    const config = { publicBaseUrls: { ...bases, pcmApi: 'https://localhost:14101/proxy/api/fhir-service/r4' } };
    const before = JSON.stringify(config);
    for (const host of ['localhost', '192.0.2.10', 'sandbox.example.test', '[2001:db8::1]']) {
        assert.equal(pcmWorkflowUrl(config, request(`${host}:14100`)), `https://${host}:14101/proxy/sandbox/authentication`);
        assert.equal(browserDestination(bases.pcmUi, request(`${host}:14101`)), `https://${host}:14100/pcm`);
    }
    assert.equal(pcmWorkflowUrl(config, request('internal:3001', { trusted: true, forwarded: 'proxy.test:443', protocol: 'https' })), 'https://proxy.test:14101/proxy/sandbox/authentication');
    assert.equal(browserDestination('https://external.test/app', request('other.test')), 'https://external.test/app');
    assert.equal(JSON.stringify(config), before, 'browser navigation never rewrites logical configuration');
});

test('malformed Host and trusted forwarded authorities cannot choose a foreign browser destination', () => {
    for (const host of ['safe.test@foreign.test', 'safe.test/path', 'safe.test?x=1', 'safe.test#foreign', 'safe.test\\foreign', 'safe.test,foreign.test', 'safe.te\tst', '']) {
        assert.equal(browserOrigin(request(host)), '', host);
        assert.equal(browserOrigin(request('direct.test', { trusted: true, forwarded: host })), host === 'safe.test,foreign.test' ? 'http://safe.test' : host ? '' : 'http://direct.test', host);
        assert.equal(browserNavigation(bases, request(host), 'pcmUi').spClient, bases.spClient);
    }
    assert.equal(browserOrigin({}), '');
});
test('known local application paths preserve declared mounts, queries and fragments without touching identities', () => {
    const { applicationPath } = require('../../shared/browser-navigation');
    assert.equal(applicationPath('https://doctor.test:9443/doctor/', '/manage?identity=hospital-b#details'), '/doctor/manage?identity=hospital-b#details');
    assert.equal(applicationPath('https://pcm.test/proxy/api/fhir-service/r4', '/api/fhir-service/r4/authorize/decision', { fhirBase: true }), '/proxy/api/fhir-service/r4/authorize/decision');
    assert.equal(applicationPath('https://doctor.test/doctor/api/fhir-service/r4', '/'), '/doctor/api/fhir-service/r4/');
    for (const route of ['//foreign.test', 'https://foreign.test', '/\\foreign.test', 'relative']) assert.throws(() => applicationPath(bases.spClient, route), /local absolute/);
});
