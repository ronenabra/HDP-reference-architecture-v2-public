'use strict';

/** Full Express-router Contract visibility, method, header and GET/POST search boundaries without sockets. */
const { installTestRuntime } = require('../../../test-support/team-config');
const runtimeConfig = installTestRuntime();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { reloadTeamConfig } = require('../src/team-config');
const store = require('../src/fhir/store');
const { tokens } = require('../src/store');
const router = require('../src/routes/fhir');
const { buildSeedResources } = require('../src/bootstrap');
const { syncDataSourcesToStore } = require('../src/data-sources');
const { provisionSystemPolicies } = require('../src/fhir/system-policy');
const { environmentEndpoints } = require('../../shared/pcm-environment');
const NOW = Math.floor(Date.now() / 1000);

/** Invoke the real middleware and route stack with an in-memory response. */
function request(method, url, { token, body } = {}) {
    const req = { method, url, originalUrl: url, headers: { host: 'transport.example', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        query: Object.fromEntries(new URL(url, 'https://transport.example').searchParams), body,
        protocol: 'https', get: () => 'transport.example' };
    return new Promise((resolve, reject) => {
        const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
            type(value) { this.headers['content-type'] = value; return this; },
            set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
            json(value) { this.body = value; resolve(this); return this; }, end() { resolve(this); return this; } };
        router.handle(req, res, error => error ? reject(error) : reject(new Error('No response')));
    });
}

/** Reset only disposable test state and prepare a client-bound management token. */
function setup(environment = 'production') {
    const config = structuredClone(runtimeConfig);
    config.contract.environment = environment;
    config.security.pcmApi.accessTokenExpiresInSeconds = 30;
    const endpoints = environmentEndpoints(environment);
    config.contract.operational = { oauthBase: endpoints.oauthBase, fhirBase: endpoints.fhirBase };
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    reloadTeamConfig();
    store.reset(); tokens.clear();
    for (const resource of buildSeedResources(config)) store.add(resource);
    syncDataSourcesToStore(store, config, 'A'.repeat(43));
    provisionSystemPolicies(store, config, NOW);
    tokens.set('entitled', { kind: 'management', aud: endpoints.oauthBase, iat: NOW, exp: NOW + 300,
        client_id: config.oauthClients.presenceOrchestrator.clientId });
    tokens.set('invisible', { kind: 'management', aud: endpoints.oauthBase, iat: NOW, exp: NOW + 300, client_id: 'invisible' });
    tokens.set('data', { kind: 'data_source_access', aud: endpoints.oauthBase, iat: NOW, exp: NOW + 300 });
    return { config, endpoints };
}

test('GET/POST Contract filters and pagination return exact production/test fullUrls and profiles', async () => {
    for (const environment of ['production', 'test']) {
        const { config, endpoints } = setup(environment);
        const contract = store.get('Contract', 'policy-presence');
        const filters = [{ _id: contract.id }, { identifier: `${contract.identifier[0].system}|${contract.identifier[0].value}` },
            { status: 'executed' }, { issued: contract.issued }, { _lastUpdated: contract.meta.lastUpdated }, { _count: '1' }, { _count: '100' }];
        for (const filter of filters) {
            const get = await request('GET', `/Contract?${new URLSearchParams(filter)}`, { token: 'entitled' });
            const post = await request('POST', '/Contract/_search', { token: 'entitled', body: filter });
            assert.equal(get.statusCode, 200); assert.equal(post.statusCode, 200);
            assert.deepEqual(get.body.entry, post.body.entry); assert.equal(get.body.total, post.body.total);
            for (const entry of get.body.entry) {
                assert.equal(entry.fullUrl, `${endpoints.fhirBase}/Contract/${entry.resource.id}`);
                assert.equal(entry.resource.meta.profile[0], 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-system-authorization-contract');
            }
        }
        tokens.set('all', { kind: 'management', aud: endpoints.oauthBase, iat: NOW, exp: NOW + 300, organization_id: config.organizations.pcm.id });
        const first = await request('GET', '/Contract?_count=1', { token: 'all' });
        assert.equal(first.body.entry.length, 1); assert.equal(first.body.total, 3);
        const next = new URL(first.body.link.find(link => link.relation === 'next').url);
        const get = await request('GET', `/Contract${next.search}`, { token: 'all' });
        const post = await request('POST', '/Contract/_search', { token: 'all', body: Object.fromEntries(next.searchParams) });
        assert.deepEqual(get.body.entry, post.body.entry);
        assert.notEqual(get.body.entry[0].resource.id, first.body.entry[0].resource.id);
        const stolen = await request('GET', `/Contract${next.search}`, { token: 'invisible' });
        assert.equal(stolen.statusCode, 400);
    }
});

test('unknown status, invalid page size and every include fail alike after authentication', async () => {
    setup();
    for (const filter of [{ status: 'unknown' }, { status: 'active' }, { _count: '0' }, { _count: '101' }, { _count: '1.2' },
        { _include: 'Contract:author' }, { '_include:iterate': 'Organization:partof' }]) {
        for (const method of ['GET', 'POST']) {
            const res = await request(method, method === 'GET' ? `/Contract?${new URLSearchParams(filter)}` : '/Contract/_search',
                { token: 'entitled', body: filter });
            assert.equal(res.statusCode, 400); assert.equal(res.body.resourceType, 'OperationOutcome');
            const unauthenticated = await request(method, method === 'GET' ? `/Contract?${new URLSearchParams(filter)}` : '/Contract/_search', { body: filter });
            assert.equal(unauthenticated.statusCode, 401);
            assert.match(unauthenticated.body.issue[0].diagnostics, /Authorization/);
        }
    }
    const repeated = await request('POST', '/Contract/_search', { token: 'entitled', body: { _count: ['1', '2'] } });
    assert.equal(repeated.statusCode, 400);
});

test('read/HEAD share headers and privacy-aware visibility; data tokens and public writes fail', async () => {
    setup();
    const get = await request('GET', '/Contract/policy-presence', { token: 'entitled' });
    const head = await request('HEAD', '/Contract/policy-presence', { token: 'entitled' });
    assert.equal(get.statusCode, 200); assert.equal(head.statusCode, 200);
    assert.deepEqual(head.headers, get.headers);
    for (const header of ['etag', 'last-modified', 'content-location']) assert.ok(get.headers[header]);
    // Express matches GET for HEAD and suppresses the body at its HTTP response
    // boundary; the explicit HEAD handler also retains the same response metadata.
    const explicitHead = router.stack.find(layer => layer.route?.path === '/Contract/:id' && layer.route.methods.head).route.stack[0].handle;
    let ended = false;
    explicitHead({ params: { id: 'policy-presence' }, user: { client_id: runtimeConfig.oauthClients.presenceOrchestrator.clientId } },
        { type() {}, set() {}, status() { return this; }, end() { ended = true; }, json() { assert.fail('HEAD body'); } });
    assert.equal(ended, true);
    for (const path of ['/Contract/policy-presence', '/Contract/missing']) {
        const invisible = await request('GET', path, { token: 'invisible' });
        assert.equal(invisible.statusCode, 404); assert.equal(invisible.body.issue[0].diagnostics, 'Contract not found');
    }
    const invisibleSearch = await request('GET', '/Contract?status=executed', { token: 'invisible' });
    assert.equal(invisibleSearch.body.total, 0); assert.deepEqual(invisibleSearch.body.entry, []);
    assert.equal((await request('GET', '/Contract/policy-presence', { token: 'data' })).statusCode, 401);
    for (const [method, path] of [['POST', '/Contract'], ['PUT', '/Contract/policy-presence'], ['DELETE', '/Contract/policy-presence'], ['PATCH', '/Contract/policy-presence']]) {
        assert.equal((await request(method, path, { token: 'entitled', body: { status: 'executed' } })).statusCode, 405);
        assert.equal((await request(method, path, { body: { status: 'executed' } })).statusCode, 401);
    }
});
