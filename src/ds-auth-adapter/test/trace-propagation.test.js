'use strict';

/** Real Axios interceptors exercise propagation without contacting any service. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const nodeHttp = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const axios = require('axios');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-trace-'));
const previousLogDir = process.env.LOG_DIR;
process.env.LOG_DIR = directory;
const logger = require('../src/logger');
const { createApp, installOutboundLogging } = require('../src/index');
const { PcmIntrospectionClient } = require('../src/pcm-introspection-client');
const { createTraceContext, formatTraceparent, parseTraceparent } = require('../../shared/trace-context');
const { AUDIENCE, ISSUER, NOW, dataSourceResponse } = require('../test-support/introspection-fixture');
if (previousLogDir === undefined) delete process.env.LOG_DIR;
else process.env.LOG_DIR = previousLogDir;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** Build an ordinary introspection client with deterministic token/cache clocks. */
function makeClient(http, authMode = 'direct') {
    return new PcmIntrospectionClient({
        http, authMode, privateKey, clientId: 'pcm-ds-client-0001',
        tokenEndpoint: `${ISSUER}/token`, introspectionEndpoint: `${ISSUER}/introspect`,
        expectedIssuer: ISSUER, expectedAudience: AUDIENCE, hoId: 'ho-a', timeout: 100,
        secondsClock: () => NOW, millisClock: () => NOW * 1000
    });
}

/** Select only records belonging to one test's unique legacy flow. */
function records(flowId) {
    if (!fs.existsSync(logger.getLogPath())) return [];
    return fs.readFileSync(logger.getLogPath(), 'utf8').trim().split('\n').map(JSON.parse)
        .filter(record => record.details.flowId === flowId)
        // These assertions count actual protocol spans; decision summaries are separate events.
        .filter(record => ['REQUEST', 'RESPONSE', 'OUTGOING_REQUEST', 'OUTGOING_RESPONSE', 'OUTGOING_ERROR'].includes(record.details.type));
}

/** Return an Axios-shaped response so normal request/response interceptors run. */
function response(config, data = dataSourceResponse()) {
    return { status: 200, statusText: 'OK', headers: {}, config, data };
}

test('introspection forwards ALS correlation, flow and trace even without Axios interceptors', async () => {
    const calls = [];
    const client = makeClient({ post: async (url, body, config) => {
        calls.push({ url, body, config });
        return { data: dataSourceResponse() };
    } });
    const context = { correlationId: 'plain-client-correlation', flowId: 'plain-client-flow', ...createTraceContext() };
    await logger.withContext(context, () => client.introspect('plain-opaque'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.headers['x-correlation-id'], context.correlationId);
    assert.equal(calls[0].config.headers['x-flow-id'], context.flowId);
    assert.equal(calls[0].config.headers.traceparent, formatTraceparent(context));
    assert.equal(calls[0].config.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(calls[0].body).get('token'), 'plain-opaque');
    assert.equal(calls[0].config.maxRedirects, 0);
});

test('direct mode emits one actual introspection span and a warm cache emits no fake hop', async () => {
    const calls = [];
    const http = axios.create({ adapter: async config => { calls.push(config); return response(config); } });
    installOutboundLogging(http);
    installOutboundLogging(http); // Installing twice must not duplicate instrumentation.
    const client = makeClient(http);
    const context = { correlationId: 'direct-correlation', flowId: 'direct-flow', ...createTraceContext() };
    await logger.withContext(context, async () => {
        assert.equal((await client.introspect('direct-opaque')).active, true);
        assert.equal((await client.introspect('direct-opaque')).active, true);
        assert.equal(logger.getTraceContext().spanId, context.spanId);
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/introspect$/);
    assert.equal(calls[0].headers.get('x-correlation-id'), context.correlationId);
    assert.equal(calls[0].headers.get('x-flow-id'), context.flowId);
    const propagated = parseTraceparent(calls[0].headers.get('traceparent'));
    assert.equal(propagated.traceId, context.traceId);
    assert.notEqual(propagated.spanId, context.spanId);
    const logs = records(context.flowId);
    assert.deepEqual(logs.map(entry => entry.details.type), ['OUTGOING_REQUEST', 'OUTGOING_RESPONSE']);
    for (const entry of logs) {
        assert.equal(entry.details.spanId, propagated.spanId);
        assert.equal(entry.details.parentSpanId, context.spanId);
        assert.equal(entry.event.provenance.kind, 'emitted');
        assert.equal(entry.event.correlation.traceId, context.traceId);
    }
});

test('bearer refresh preserves one flow and emits a distinct span for every real attempt', async () => {
    const calls = [];
    let rejected = false;
    const http = axios.create({ adapter: async config => {
        calls.push(config);
        if (config.url.endsWith('/token')) return response(config, {
            access_token: `credential-${calls.length}`, token_type: 'Bearer', expires_in: 30, scope: 'system/*.crus'
        });
        if (!rejected) {
            rejected = true;
            throw new axios.AxiosError('credential rejected', 'ERR_BAD_REQUEST', config, null, {
                ...response(config, { error: 'invalid_token' }), status: 401
            });
        }
        return response(config);
    } });
    installOutboundLogging(http);
    const client = makeClient(http, 'bearer');
    const context = { correlationId: 'bearer-correlation', flowId: 'bearer-flow', ...createTraceContext() };
    await logger.withContext(context, () => client.introspect('bearer-opaque'));
    assert.deepEqual(calls.map(call => new URL(call.url).pathname.split('/').at(-1)), ['token', 'introspect', 'token', 'introspect']);
    const spans = calls.map(call => parseTraceparent(call.headers.get('traceparent')));
    assert.equal(new Set(spans.map(span => span.spanId)).size, 4);
    for (const [index, call] of calls.entries()) {
        assert.equal(call.headers.get('x-correlation-id'), context.correlationId);
        assert.equal(call.headers.get('x-flow-id'), context.flowId);
        assert.equal(spans[index].traceId, context.traceId);
        assert.equal(call.metadata.parentSpanId, context.spanId);
        if (call.url.endsWith('/introspect')) assert.match(call.headers.get('Authorization'), /^Bearer credential-/);
    }
    const logs = records(context.flowId);
    assert.equal(logs.length, 8);
    const error = logs.find(entry => entry.details.type === 'OUTGOING_ERROR');
    assert.equal(error.details.spanId, spans[1].spanId);
    assert.equal(error.details.parentSpanId, context.spanId);
    assert.equal(error.details.status, 401);
});

test('concurrent requests on a shared client never borrow another request context', async () => {
    const calls = [];
    const http = axios.create({ adapter: async config => {
        await new Promise(resolve => setImmediate(resolve));
        calls.push(config);
        return response(config);
    } });
    installOutboundLogging(http);
    const client = makeClient(http);
    const contexts = ['parallel-one', 'parallel-two'].map(id => ({ correlationId: id, flowId: `flow-${id}`, ...createTraceContext() }));
    await Promise.all(contexts.map(context => logger.withContext(context, () => client.introspect(context.correlationId))));
    assert.equal(calls.length, 2);
    for (const context of contexts) {
        const call = calls.find(item => new URLSearchParams(item.data).get('token') === context.correlationId);
        assert.equal(call.headers.get('x-correlation-id'), context.correlationId);
        assert.equal(call.headers.get('x-flow-id'), context.flowId);
        assert.equal(parseTraceparent(call.headers.get('traceparent')).traceId, context.traceId);
        assert.equal(call.metadata.parentSpanId, context.spanId);
        assert.equal(records(context.flowId).length, 2);
    }
    assert.equal(logger.getCorrelationId(), undefined);
});

test('explicit mixed-case headers remain coherent and standalone calls do not invent flows', async () => {
    const calls = [];
    const http = axios.create({ adapter: async config => { calls.push(config); return response(config, {}); } });
    installOutboundLogging(http);
    const parent = createTraceContext();
    await http.get('https://pcm.example.test/discovery', { headers: {
        'X-Correlation-Id': 'explicit-correlation', 'X-Flow-Id': 'explicit-flow', Traceparent: formatTraceparent(parent)
    } });
    assert.equal(calls[0].metadata.correlationId, 'explicit-correlation');
    assert.equal(calls[0].metadata.flowId, 'explicit-flow');
    assert.equal(calls[0].metadata.parentSpanId, parent.spanId);
    assert.equal(Object.keys(calls[0].headers).filter(key => key.toLowerCase() === 'x-correlation-id').length, 1);
    await http.get('https://pcm.example.test/standalone');
    assert.ok(calls[1].headers.get('x-correlation-id'));
    assert.ok(parseTraceparent(calls[1].headers.get('traceparent')));
    assert.equal(calls[1].headers.get('x-flow-id'), undefined);
    assert.equal(calls[1].metadata.parentSpanId, undefined);
});

test('outbound event serialization keeps full sandbox values and blocks AWS canaries', async () => {
    const awsKey = 'AKIA' + 'Q'.repeat(16);
    const http = axios.create({ adapter: async config => response(config, {
        AccessKeyId: awsKey, SecretAccessKey: 'synthetic-response-secret', Token: 'synthetic-response-token',
        patient: { id: '123' }, token: 'sandbox-token'
    }) });
    installOutboundLogging(http);
    await logger.withContext({ correlationId: 'aws-correlation', flowId: 'aws-flow', ...createTraceContext() }, () =>
        http.post('https://pcm.example.test/introspect', { token: 'sandbox-subject', aws_secret_access_key: 'synthetic-request-secret' }, {
            headers: { Authorization: 'Bearer sandbox-credential', 'x-amz-security-token': 'synthetic-header-token' }
        }));
    const logs = records('aws-flow');
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, new RegExp(`${awsKey}|synthetic-response-secret|synthetic-response-token|synthetic-request-secret|synthetic-header-token`));
    assert.match(serialized, /sandbox-subject/);
    assert.match(serialized, /Bearer sandbox-credential/);
    assert.equal(logs[1].details.body.patient.id, '123');
});

test('an actual adapter request preserves its flow to PCM without changing an inactive denial', async t => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json'), 'utf8'));
    config.conformance.preset = 'connectathon-balanced';
    config.security.dsFhirServer.enforceMappedPatients = true;
    config.securitySimulation.global = require('../../shared/conformance-policy').presetSimulationDefaults('connectathon-balanced');
    const calls = [];
    const http = axios.create({ adapter: async request => { calls.push(request); return response(request, { active: false }); } });
    const { app } = createApp({ config, env: {}, http, bindings: { hoId: 'ho-a' }, client: makeClient(http) });
    const server = nodeHttp.createServer(app);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const parent = createTraceContext();
    const result = await fetch(`http://127.0.0.1:${server.address().port}/auth-check`, { headers: {
        authorization: 'Bearer inactive-subject', 'x-original-uri': '/fhir/Observation', 'x-original-method': 'GET',
        'x-correlation-id': 'http-correlation', 'x-flow-id': 'http-flow', traceparent: formatTraceparent(parent)
    } });
    assert.equal(result.status, 401);
    assert.equal(await result.text(), 'Unauthorized');
    assert.equal(calls.length, 1);
    const serverSpan = parseTraceparent(result.headers.get('traceparent'));
    const clientSpan = parseTraceparent(calls[0].headers.get('traceparent'));
    assert.equal(serverSpan.traceId, parent.traceId);
    assert.equal(clientSpan.traceId, parent.traceId);
    assert.equal(calls[0].metadata.parentSpanId, serverSpan.spanId);
    assert.equal(calls[0].headers.get('x-correlation-id'), 'http-correlation');
    assert.equal(calls[0].headers.get('x-flow-id'), 'http-flow');
    const logs = records('http-flow');
    assert.deepEqual(logs.map(entry => entry.details.type), ['REQUEST', 'OUTGOING_REQUEST', 'OUTGOING_RESPONSE', 'RESPONSE']);
    assert.equal(logs[0].details.parentSpanId, parent.spanId);
    assert.equal(logs.at(-1).details.spanId, serverSpan.spanId);
});
