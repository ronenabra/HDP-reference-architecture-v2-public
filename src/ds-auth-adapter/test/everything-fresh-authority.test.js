'use strict';

/** Exercise the private auth route with real validation, caching and JWT signing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
const config = installTestRuntime();
const certificates = require('../../../test-support/certificates').certificates();
const { createApp } = require('../src/index');
const { PcmIntrospectionClient } = require('../src/pcm-introspection-client');
const { NOW, ISSUER, AUDIENCE, dataSourceResponse, presenceResponse, patient } = require('../test-support/introspection-fixture');

/** Start only an in-process auth endpoint; PCM responses are deterministic. */
async function fixture(t, preset = 'connectathon-easy', { managedClient = false } = {}) {
    t.mock.method(Date, 'now', () => NOW * 1000);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = path.join(process.env.CERTS_DIR, 'local.key');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    process.env.LOCAL_JWT_SIGNING_KEY_PATH = keyPath;
    t.after(() => { delete process.env.LOCAL_JWT_SIGNING_KEY_PATH; fs.rmSync(keyPath, { force: true }); });
    let response = dataSourceResponse();
    const calls = [];
    const networkCalls = [];
    const pcmHttp = {
        get: async () => ({ data: { issuer: ISSUER, token_endpoint: `${ISSUER}/token`, introspection_endpoint: `${ISSUER}/introspect`,
            authorization_details_types_supported: ['https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access'],
            token_endpoint_auth_methods_supported: ['private_key_jwt'], introspection_endpoint_auth_methods_supported: ['private_key_jwt'],
            token_endpoint_auth_signing_alg_values_supported: ['ES256'], introspection_endpoint_auth_signing_alg_values_supported: ['ES256'],
            tls_client_certificate_bound_access_tokens: false } }),
        post: async (_url, _form, options) => { networkCalls.push(options); return { data: response }; }
    };
    const assertionPath = path.join(process.env.CERTS_DIR, 'assertion.key');
    fs.writeFileSync(assertionPath, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    t.after(() => fs.rmSync(assertionPath, { force: true }));
    const client = new PcmIntrospectionClient({
        http: pcmHttp, privateKey: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
        clientId: 'pcm-ds-client-0001', tokenEndpoint: `${ISSUER}/token`, introspectionEndpoint: `${ISSUER}/introspect`,
        expectedIssuer: ISSUER, expectedAudience: AUDIENCE, hoId: 'ho-a', authMode: 'direct', timeout: 100,
        controls: { tokenAudience: true, tokenExpiry: true }, secondsClock: () => NOW, millisClock: () => NOW * 1000
    });
    const original = client.introspect.bind(client);
    client.introspect = (token, options) => { calls.push({ token, options }); return original(token, options); };
    const server = http.createServer(createApp({ config: preset === 'connectathon-easy' ? config : buildTeamConfig({}, preset), env: {},
        client: managedClient ? null : client, http: pcmHttp,
        bindings: { hoId: 'ho-a', expectedAudience: AUDIENCE, localIssuer: 'https://adapter.internal/ho-a', localAudience: 'urn:ho-a:fhir',
            discoveryIssuer: ISSUER, expectedIssuer: ISSUER, fhirBase: ISSUER, authBase: ISSUER, authMode: 'direct',
            clientId: 'pcm-ds-client-0001', assertionKeyPath: assertionPath, timeout: 100,
            // The mock HTTP transport inspects agent configuration; no TLS handshake is claimed.
            mtlsCertPath: path.join(certificates, 'sp-client-assertion.crt'),
            mtlsKeyPath: path.join(certificates, 'sp-client-assertion.key'), rootCaPath: path.join(certificates, 'rootCA.crt') } }).app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { calls, networkCalls, client, setResponse: value => { response = value; },
        async send(uri, token = 'same-opaque') {
            const result = await fetch(`http://127.0.0.1:${server.address().port}/auth-check`, {
                headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-original-method': 'GET', 'x-original-uri': uri,
                    'x-pcm-scenario': 'data-source-access', 'x-pcm-patient': 'untrusted-caller-id' }
            });
            const signed = result.headers.get('x-local-token');
            return { status: result.status, payload: signed ? jwt.verify(signed, publicKey, {
                algorithms: ['RS256'], issuer: 'https://adapter.internal/ho-a', audience: 'urn:ho-a:fhir', clockTimestamp: NOW
            }) : null };
        }
    };
}

test('operation and generic bearer continuation recheck the same token after revocation without sleeping', async t => {
    const f = await fixture(t, 'connectathon-balanced');
    const ordinary = '/fhir/Observation?status=final';
    const targets = ['/fhir/Patient/$everything?_count=1&_type=Patient,Observation', '/fhir/Patient/patient-1/$everything?_count=1',
        '/fhir?_getpages=opaque.1.mac&_getpagesoffset=1&_count=1'];
    assert.equal((await f.send(ordinary)).status, 200);
    assert.deepEqual(f.calls.at(-1).options, { fresh: false });
    for (const uri of targets) {
        f.setResponse(dataSourceResponse());
        const positive = await f.send(uri);
        assert.equal(positive.status, 200);
        assert.deepEqual(positive.payload.request_binding, { method: 'GET', uri });
        assert.deepEqual(f.calls.at(-1), { token: 'same-opaque', options: { fresh: true } });
        // Seed precisely the stale cache entry used by ordinary search.
        await f.client.introspect('same-opaque');
        f.setResponse({ active: false });
        assert.equal((await f.send(uri)).status, 401);
        assert.deepEqual(f.calls.at(-1).options, { fresh: true });
    }
    f.setResponse(presenceResponse());
    assert.equal((await f.send(targets[0])).status, 401, 'unsigned clinical marker cannot turn presence authority into a clinical target');
});

test('Easy operation and bearer continuation preserve verified source expiry, exact URI and Patient binding', async t => {
    const f = await fixture(t);
    for (const uri of ['/fhir/Patient/$everything?_type=Patient%2CObservation&_count=1', '/fhir?_getpages=opaque.1.mac&_count=1']) {
        for (const seconds of [1, 120]) {
            f.setResponse({ ...dataSourceResponse(), exp: NOW + seconds });
            const result = await f.send(uri);
            assert.equal(result.status, 200);
            assert.equal(result.payload.kind, 'data-source-access');
            assert.equal(result.payload.exp, NOW + Math.min(seconds, 30));
            assert.equal(result.payload.pcm_expires_at, NOW + seconds);
            assert.deepEqual(result.payload.patient_identifier, patient);
            assert.deepEqual(result.payload.request_binding, { method: 'GET', uri });
            assert.deepEqual(f.calls.at(-1).options, { fresh: true });
        }
        for (const exp of [NOW, NOW - 1, 'invalid', null]) {
            f.setResponse({ ...dataSourceResponse(), exp });
            assert.equal((await f.send(uri)).status, 401);
        }
        f.setResponse({ ...dataSourceResponse(), aud: 'https://other.example.test/fhir' });
        assert.equal((await f.send(uri)).status, 401, 'every preset retains exact source audience validation');
    }
    const before = f.calls.length;
    const anonymous = await f.send('/fhir/Observation?status=final', null);
    assert.equal(anonymous.status, 401);
    assert.equal(f.calls.length, before, 'anonymous denial creates no introspection authority');
});

const cursorVariants = [
    '/fhir?_getpages=opaque.1.mac&_count=1',
    '/fhir?_count=1&_getpages=opaque.1.mac',
    '/fhir?%5Fgetpages=opaque.1.mac&_count=1',
    '/fhir/?_getpages=opaque.1.mac&_count=1',
    '/fhir/?_count=1&_getpages=opaque.1.mac',
    '/fhir/?%5Fgetpages=opaque.1.mac&_count=1'
];

test('every admitted cursor spelling bypasses a real same-token cached positive after revocation', async t => {
    const f = await fixture(t, 'connectathon-balanced');
    for (const uri of cursorVariants) {
        f.setResponse(dataSourceResponse());
        assert.equal((await f.send('/fhir/Observation?status=final')).status, 200);
        const warmed = f.networkCalls.length;
        assert.equal((await f.send('/fhir/Observation?status=final')).status, 200);
        assert.equal(f.networkCalls.length, warmed, 'ordinary positive caching remains intact');
        f.setResponse({ active: false });
        assert.equal((await f.send(uri)).status, 401, uri);
        assert.equal(f.networkCalls.length, warmed + 1, `${uri} independently contacts PCM`);
        assert.deepEqual(f.calls.at(-1).options, { fresh: true });
        f.setResponse(dataSourceResponse());
        const positive = await f.send(uri);
        assert.equal(positive.status, 200, uri);
        assert.deepEqual(positive.payload.request_binding, { method: 'GET', uri });
    }
});

test('Easy constructs mandatory audience, expiry and outbound TLS controls for every cursor spelling', async t => {
    const f = await fixture(t, 'connectathon-easy', { managedClient: true });
    for (const uri of cursorVariants) {
        f.setResponse({ ...dataSourceResponse(), exp: NOW + 1 });
        const positive = await f.send(uri);
        assert.equal(positive.status, 200, uri);
        assert.equal(positive.payload.exp, NOW + 1);
        assert.equal(positive.payload.pcm_expires_at, NOW + 1);
        assert.deepEqual(positive.payload.patient_identifier, patient);
        assert.deepEqual(positive.payload.request_binding, { method: 'GET', uri });
        const options = f.networkCalls.at(-1);
        assert.equal(options.httpsAgent.options.rejectUnauthorized, true);
        for (const field of ['cert', 'key', 'ca']) assert.ok(options.httpsAgent.options[field].length > 0);
        for (const invalid of [{ exp: NOW }, { exp: 'invalid' }, { aud: 'https://other.example.test/fhir' }]) {
            f.setResponse({ ...dataSourceResponse(), ...invalid });
            const before = f.networkCalls.length;
            assert.equal((await f.send(uri)).status, 401, `${uri} ${JSON.stringify(invalid)}`);
            assert.equal(f.networkCalls.length, before + 1);
        }
    }
    const before = f.networkCalls.length;
    const anonymous = await f.send('/fhir/Observation?status=final', null);
    assert.equal(anonymous.status, 401);
    assert.equal(f.networkCalls.length, before);
});

test('noncanonical operation paths and duplicate decoded cursor controls reject before introspection', async t => {
    const f = await fixture(t);
    const rejected = [
        '/fhir/Patient/%24everything', '/fhir/%50atient/%24everything',
        '/fhir/%50atient/$everything', '/fhir/Patient/%70/$everything',
        '/fhir/Patient/p/%24everything', '/fhir/Patient/$everything/',
        '/fhir/Patient/p/$everything/',
        '/fhir/?_getpages=opaque.1.mac&%5Fgetpages=other.1.mac',
        '/fhir?_getpages=opaque.1.mac&_getpages=other.1.mac'
    ];
    for (const uri of rejected) {
        const before = f.networkCalls.length;
        assert.equal((await f.send(uri)).status, 401, uri);
        assert.equal(f.networkCalls.length, before, uri);
    }
    for (const uri of ['/fhir/Patient/$everything?_count=1', '/fhir/Patient/patient-1/$everything?_count=1']) {
        const result = await f.send(uri);
        assert.equal(result.status, 200);
        assert.deepEqual(result.payload.request_binding, { method: 'GET', uri });
        assert.deepEqual(f.calls.at(-1).options, { fresh: true });
    }
});


test('master endpoints keep exact scoped authority and fresh audience-bound introspection with mandatory result filtering', async t => {
    const f = await fixture(t);
    for (const type of ['Organization', 'Practitioner', 'PractitionerRole', 'Location']) {
        f.setResponse({ ...dataSourceResponse(), scope: `patient/${type}.r?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V` });
        for (const uri of [`/fhir/${type}/known-id`, `/fhir/${type}?identifier=known`]) {
            const result = await f.send(uri);
            assert.equal(result.status, 200);
            assert.equal(result.payload.kind, 'data-source-access');
            assert.equal(result.payload.scope, `patient/${type}.r?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V`);
            assert.deepEqual(f.calls.at(-1).options, { fresh: true });
            assert.equal((await f.send(uri, null)).status, 401);
        }
        f.setResponse({ active: false });
        assert.equal((await f.send(`/fhir/${type}/known-id`)).status, 401);
        f.setResponse({ ...dataSourceResponse(), aud: 'https://wrong.example/fhir' });
        assert.equal((await f.send(`/fhir/${type}/known-id`)).status, 401);
    }
});

/** A request captures its budget before asynchronous introspection; following requests see changes. */
test('clinical query limits retain in-flight private-token budget and adopt the following edit', async t => {
    const events = [], logger = require('../src/logger');
    t.mock.method(logger, 'info', (message, details) => events.push({message,details}));
    t.mock.method(logger, 'warn', (message, details) => events.push({message,details}));
    const original = structuredClone(config);
    t.after(() => { for (const key of Object.keys(config)) delete config[key]; Object.assign(config, original); });
    const f = await fixture(t);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const introspect = f.client.introspect.bind(f.client);
    f.client.introspect = async (...args) => { enter(); await gate; return introspect(...args); };
    const inFlight = f.send('/fhir/Observation?_count=1');
    await entered;
    config.clinicalQuery = { sources: { 'ho-a': { maxPrivateAuthorizationBytes: 1 } } };
    config.runtime.queryLimitsRevisionOffset = (config.runtime.queryLimitsRevisionOffset || 0) + 1;
    config.runtime.revision = (config.runtime.revision || 0) + 1;
    release();
    assert.equal((await inFlight).status,200);
    assert.equal((await f.send('/fhir/Observation?_count=1')).status,401);
    const denied = events.find(value => value.details?.type === 'DS_AUTHORIZATION_DENIED');
    assert.equal(denied.details.reasonCode, 'QUERY_BUDGET_EXCEEDED');
    assert.equal(denied.details.budgetFailure.threshold, 1);
    assert.ok(denied.details.budgetFailure.observed > 1);
    assert.equal(denied.details.budgetFailure.unit, 'bytes');
    assert.equal(denied.message, `Data Source authorization denied · QUERY_BUDGET_EXCEEDED: maxPrivateAuthorizationBytes limit=1 bytes observed=${denied.details.budgetFailure.observed} bytes`);
    const terminal = events.find(value => value.details?.type === 'DS_AUTHORIZATION_DECISION' && value.details.budgetFailure);
    assert.equal(terminal.details.reasonCode, 'MAPPING_REJECTED');
    assert.equal(terminal.details.budgetReasonCode, 'QUERY_BUDGET_EXCEEDED');
    t.mock.method(logger, 'warn', () => { throw new Error('owned unavailable warning'); });
    assert.equal((await f.send('/fhir/Observation?_count=1')).status,401);
    delete config.clinicalQuery;
    assert.equal((await f.send('/fhir/Observation?_count=1')).status,200);
});
