'use strict';

/** Exercise real assertion/form construction while replacing only the network transport. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime();
const { createSystemWorkflowClient } = require('../src/system-workflow-client');
const { TYPE, ROLE, BASIS, SERVICE } = require('../../shared/data-authorization-details');
const { environmentEndpoints } = require('../../shared/pcm-environment');
const patient = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const certificates = require('../../../test-support/certificates').certificates();
fs.copyFileSync(path.join(certificates, config.certificates.rootCaCert), path.join(config.runtime.certsDir, config.certificates.rootCaCert));
for (const role of ['authenticationOrchestrator', 'discoveryOrchestrator', 'presenceOrchestrator']) {
    fs.copyFileSync(path.join(certificates, config.certificateRoles[role].mtls.cert), path.join(config.runtime.certsDir, config.certificateRoles[role].mtls.cert));
    fs.copyFileSync(path.join(certificates, config.certificateRoles[role].mtls.key), path.join(config.runtime.certsDir, config.certificateRoles[role].mtls.key));
    fs.writeFileSync(path.join(config.runtime.certsDir, config.certificateRoles[role].assertion.key), privateKey.export({ type: 'pkcs8', format: 'pem' }));
}

/** Effective authentication response shaped like the PCM output. */
function tokenResponse() {
    return { token_type: 'Bearer', access_token: 'opaque', expires_in: 30,
        authorization_details: [{ type: TYPE, purposeOfUse: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-authorization-scenario', code: 'patient-authentication' }],
            fhirContext: [
                { type: 'Contract', role: `${ROLE}authorization-basis`, identifier: { system: BASIS.Contract, value: 'PCM-POLICY-PATIENT-AUTHENTICATION-001' } },
                { type: 'Patient', role: `${ROLE}authorization-patient`, identifier: patient }
            ] }] };
}

test('retry creates fresh clean signed assertions, binds private state, and preserves RAR encoding', async () => {
    const assertions = [], bindings = [], backoffs = [];
    const source = require('../src/data-sources').getConfiguredDataSources(config)[0];
    let sourceCalls = 0;
    const client = createSystemWorkflowClient({ config, flows: { bindAssertion: (...args) => bindings.push(args) },
        sleep: async value => backoffs.push(value), transport: async (url, request) => {
            assert.equal(request.tls.rejectUnauthorized, url.endsWith('/token') ? true : config.security.serviceProviderToDataSource.verifyServerCertificate);
            if (url.endsWith('/token')) {
                const form = new URLSearchParams(request.body);
                assert.equal(form.getAll('authorization_details').length, 1);
                const rar = JSON.parse(form.get('authorization_details'));
                assert.deepEqual(rar[0].fhirContext[1].identifier, patient);
                assert.equal(form.get('resource'), source.endpoint);
                const assertion = jwt.verify(form.get('client_assertion'), publicKey, { algorithms: ['ES256'], audience: environmentEndpoints(config.contract.environment).tokenEndpoint });
                assert.deepEqual(Object.keys(assertion).sort(), ['aud', 'cnf', 'exp', 'iat', 'iss', 'jti', 'sub']);
                assert.deepEqual(assertion.cnf, require('../../shared/assertion-keys').certificateConfirmation(request.tls.cert));
                assertions.push(assertion);
                return tokenResponse();
            }
            assert.equal(request.headers.Authorization, 'Bearer opaque');
            sourceCalls++;
            if (sourceCalls === 1) throw Object.assign(new Error('retry'), { status: 401 });
            return { resourceType: 'Bundle', type: 'searchset' };
        } });
    const result = await client(source, { scenario: 'patient-authentication', flowId: 'private-flow', patients: [patient], method: 'GET', url: `${source.endpoint}/Patient?identifier=x` });
    assert.equal(result.resourceType, 'Bundle');
    assert.equal(assertions.length, 2); assert.notEqual(assertions[0].jti, assertions[1].jti);
    assert.deepEqual(bindings.map(value => value[2]), assertions.map(value => value.jti));
    assert.deepEqual(backoffs, [100]);
});

test('rejects source escapes and substituted token context before source access', async () => {
    const source = require('../src/data-sources').getConfiguredDataSources(config)[0];
    let calls = 0;
    const client = createSystemWorkflowClient({ config, flows: { bindAssertion() {} }, transport: async () => {
        calls++;
        const token = tokenResponse();
        token.authorization_details[0].fhirContext[1].identifier = { ...patient, value: '000000026' };
        return token;
    } });
    const operation = { scenario: 'patient-authentication', patients: [patient], flowId: 'private', method: 'GET' };
    await assert.rejects(client(source, { ...operation, url: `${source.endpoint}/../elsewhere` }), /escapes/);
    assert.equal(calls, 0);
    await assert.rejects(client(source, { ...operation, url: `${source.endpoint}/Patient` }), /context mismatch/);
    assert.equal(calls, 1);
});

/** Construct the effective discovery response without adding patient authority. */
function discoveryToken() {
    const token = tokenResponse();
    const details = token.authorization_details[0];
    details.purposeOfUse[0].code = 'dependent-discovery';
    details.fhirContext[1].type = 'RelatedPerson';
    details.fhirContext[1].role = `${ROLE}discovery-representative`;
    details.fhirContext[0].identifier.value = 'PCM-POLICY-DEPENDENT-DISCOVERY-001';
    return token;
}

for (const scenario of ['success', 'token-expiry', 'source-expiry', 'renewal', 'backoff', 'flow-expiry']) {
    test(`REM-02 client ${scenario} uses only the remaining private source/flow budget`, async () => {
        const source = require('../src/data-sources').getConfiguredDataSources(config)[0];
        let now = 0, sourceCalls = 0;
        const budgets = [], sleeps = [];
        const flows = { bindAssertion() {}, invocation: () => ({ expiresAt: scenario === 'flow-expiry' ? 1 : 100 }) };
        const client = createSystemWorkflowClient({ config, flows, clock: () => now, sleep: async delay => { sleeps.push(delay); now += delay; },
            transport: async (url, request) => {
                budgets.push(request.timeoutMilliseconds);
                if (url.endsWith('/token')) {
                    now += scenario === 'token-expiry' ? 3000 : 500;
                    return discoveryToken();
                }
                sourceCalls++;
                if (scenario === 'source-expiry' || scenario === 'flow-expiry') now += request.timeoutMilliseconds;
                else if (scenario === 'renewal' && sourceCalls === 1) { now += 500; throw Object.assign(new Error('renew'), { status: 401 }); }
                else if (scenario === 'backoff') { now += 2400; throw Object.assign(new Error('busy'), { status: 503 }); }
                else now += 500;
                return { resourceType: 'Bundle' };
            } });
        const operation = { scenario: 'dependent-discovery', flowId: 'private', method: 'GET', url: `${source.endpoint}/Patient`, deadlineMilliseconds: 3000 };
        if (['success', 'renewal'].includes(scenario)) assert.equal((await client(source, operation)).resourceType, 'Bundle');
        else await assert.rejects(client(source, operation));
        const expected = scenario === 'token-expiry' ? [3000] : scenario === 'renewal' ? [3000, 2500, 1900, 1400]
            : scenario === 'flow-expiry' ? [1000, 500] : [3000, 2500];
        assert.deepEqual(budgets, expected);
        assert.deepEqual(sleeps, scenario === 'renewal' ? [100] : []);
        const before = budgets.length;
        now = 3000;
        await assert.rejects(client(source, operation), /deadline/);
        assert.equal(budgets.length, before, 'expired budget issues no further requests');
    });
}

const https = require('node:https');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { requestJson } = require('../src/system-workflow-client');

/** Real local HTTPS peer; only this fabricated test certificate bypasses trust verification. */
async function httpsHarness(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-workflow-https-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore' });
    const closed = new Map(), intervals = new Set(), sockets = new Set();
    const server = https.createServer({ key: fs.readFileSync(path.join(directory, 'key.pem')), cert: fs.readFileSync(path.join(directory, 'cert.pem')) }, (req, res) => {
        req.socket.on('close', () => closed.set(req.url, Date.now()));
        if (req.url.includes('stall')) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/slow') {
            res.write('{"value":"');
            const interval = setInterval(() => res.write('x'), 10);
            intervals.add(interval);
            res.on('close', () => { clearInterval(interval); intervals.delete(interval); });
        } else if (req.url === '/abort') { res.write('{'); res.destroy(); }
        else if (req.url === '/invalid') res.end('not JSON');
        else if (req.url === '/large') res.end(JSON.stringify({ value: 'x'.repeat(100) }));
        else res.end('{}');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const interval of intervals) clearInterval(interval);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { root: `https://127.0.0.1:${server.address().port}`, closed };
}

test('REM-02 HTTPS cancels stalled token/source and slow chunks with absolute timers and clean terminal paths', async t => {
    const h = await httpsHarness(t);
    const originalRequest = https.request;
    const requests = [], responses = [];
    https.request = (...args) => {
        const request = originalRequest(...args);
        requests.push(request);
        request.on('response', response => responses.push(response));
        return request;
    };
    t.after(() => { https.request = originalRequest; });
    const activeTimers = new Set();
    const options = { tls: { rejectUnauthorized: false }, timeoutMilliseconds: 500, headers: {},
        schedule: (callback, duration) => { const timer = setTimeout(callback, duration); activeTimers.add(timer); return timer; },
        unschedule: timer => { clearTimeout(timer); activeTimers.delete(timer); } };
    for (const route of ['/token-stall', '/source-stall', '/slow']) {
        const started = Date.now();
        await assert.rejects(requestJson(`${h.root}${route}`, { ...options, method: route === '/token-stall' ? 'POST' : 'GET' }), /timed out/);
        assert.ok(Date.now() - started < 1500, '500ms deadline plus 1000ms scheduling tolerance');
        while (!h.closed.has(route) && Date.now() - started < 1500) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(h.closed.has(route), 'peer observed socket cancellation');
        assert.equal(activeTimers.size, 0);
    }
    for (const route of ['/ok', '/invalid', '/abort', '/large']) {
        const pending = requestJson(`${h.root}${route}`, { ...options, method: 'GET', maxBytes: 50 });
        if (route === '/ok') assert.deepEqual(await pending, {});
        else await assert.rejects(pending);
        assert.equal(activeTimers.size, 0, route);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const request of requests) assert.equal(request.listenerCount('error'), 0, 'request error handler released on close');
    for (const response of responses) {
        assert.equal(response.listenerCount('error'), 0, 'response error handler released on close');
        assert.equal(response.listenerCount('data'), 0, 'response data handler released on settlement');
    }
});

test('DEMO sampler transport propagates explicit cancellation and cleans timers/listeners', async t => {
    const h = await httpsHarness(t), controller = new AbortController();
    const pending = requestJson(`${h.root}/source-stall`, { method: 'GET', headers: {}, tls: { rejectUnauthorized: false }, timeoutMilliseconds: 1000, maxBytes: 128 * 1024, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, /cancelled/);
    const already = new AbortController(); already.abort();
    await assert.rejects(requestJson(`${h.root}/source-stall`, { method: 'GET', headers: {}, tls: { rejectUnauthorized: false }, timeoutMilliseconds: 1000, signal: already.signal }), /cancelled/);
});

test('system-CA source calls use operating-system trust while PCM token calls retain the team CA', async t => {
    const previous = config.organizations.dataSources;
    config.organizations.dataSources = [{ id: 'org-owned-system-ca', institutionType: 'hmo', endpoint: 'https://owned-system-ca.example.test/fhir', serverTrust: { mode: 'system-ca' } }];
    t.after(() => { config.organizations.dataSources = previous; });
    const source = require('../src/data-sources').getConfiguredDataSources(config).find(source => source.id === 'org-owned-system-ca');
    const client = createSystemWorkflowClient({ config, flows: { bindAssertion() {} }, transport: async (url, request) => {
        if (url.endsWith('/token')) { assert.ok(request.tls.ca); return tokenResponse(); }
        assert.equal(Object.hasOwn(request.tls, 'ca'), false);
        assert.ok(request.tls.cert); assert.ok(request.tls.key);
        return { resourceType: 'Bundle', type: 'searchset', entry: [] };
    } });
    assert.equal((await client(source, { scenario: 'patient-authentication', patients: [patient], method: 'GET', url: `${source.endpoint}/Patient` })).resourceType, 'Bundle');
});

test('active workflow retains captured source budgets while fresh clients adopt changes and context remains enforced', async t => {
    const original = structuredClone(config.presence), source = require('../src/data-sources').getConfiguredDataSources(config)[0];
    t.after(()=>{config.presence=original;});
    config.presence.sources = { [config.healthOrganizations[0].id]: {maxPayloadBytes:2048,maxResponseBytes:4096,timeoutMilliseconds:1000} };
    const snapshot=structuredClone(config), budgets=[];
    const operation={scenario:'patient-authentication',patients:[patient],method:'GET',url:`${source.endpoint}/Patient`};
    const client=createSystemWorkflowClient({config:snapshot,getConfig:()=>config,flows:{bindAssertion(){}},clock:()=>0,transport:async(url,request)=>{
        budgets.push([url.endsWith('/token')?'token':'source',request.maxBytes,request.timeoutMilliseconds]);
        if(url.endsWith('/token')) {config.presence.sources[config.healthOrganizations[0].id].maxResponseBytes=8192;return tokenResponse();}
        return {resourceType:'Bundle'};
    }});
    await client(source,operation); assert.equal(budgets[0][1],4096);
    const fresh=createSystemWorkflowClient({config:structuredClone(config),flows:{bindAssertion(){}},transport:async(url,request)=>{
        if(url.endsWith('/token')) {assert.equal(request.maxBytes,8192);const token=tokenResponse();token.authorization_details[0].fhirContext[1].identifier={...patient,value:'000000026'};return token;}
        assert.fail('larger response budget cannot bypass exact patient context');
    }});
    await assert.rejects(fresh(source,operation),/context mismatch/);
});
