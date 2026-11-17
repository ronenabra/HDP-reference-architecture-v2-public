/**
 * Tests for unified log ordering modes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    COMPONENTS,
    compareLegacyLogs,
    orderUnifiedLogs
} = require('../src/log-ordering');
const { parseGatewayErrorLine } = require('../src/gateway-error-log');
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

function entry(id, component, timestamp, options = {}) {
    return {
        id,
        component,
        componentLine: options.componentLine || 1,
        timestamp,
        tick: options.tick,
        level: 'INFO',
        message: options.message || id,
        details: options.details || {}
    };
}

test('legacy unified logs preserve exact current comparator order', () => {
    const logs = [
        entry('pcm-request', 'PCM Core', '2026-05-05T21:44:25.109Z'),
        entry('doctor-response', 'Doctor App', '2026-05-05T21:44:25.116Z', { tick: '20491342276854' }),
        entry('doctor-request', 'Doctor App', '2026-05-05T21:44:25.088Z', { tick: '20491313950005' }),
        entry('pcm-response', 'PCM Core', '2026-05-05T21:44:25.116Z'),
        entry('auth-request', 'DS Auth Adapter', '2026-05-05T21:44:25.483Z', { tick: '20491708885654' })
    ];

    const expectedIds = [...logs].sort(compareLegacyLogs).map(log => log.id);
    assert.deepEqual(orderUnifiedLogs(logs).map(log => log.id), expectedIds);
    assert.deepEqual(orderUnifiedLogs(logs, 'unknown-mode').map(log => log.id), expectedIds);
});

test('unified log components include DS Gateway between SP and downstream services', () => {
    assert.deepEqual(COMPONENTS.map(component => component.label), [
        'PCM Core',
        'Doctor App',
        'DS Gateway',
        'DS Auth Adapter',
        'DS FHIR'
    ]);
});

test('Group related events keeps same-component request before response by file order', () => {
    const logs = [
        entry('response', 'PCM Core', '2026-05-05T21:44:25.100Z', {
            componentLine: 2,
            details: { type: 'RESPONSE', requestId: 'req-1' }
        }),
        entry('request', 'PCM Core', '2026-05-05T21:44:25.100Z', {
            componentLine: 1,
            details: { type: 'REQUEST', requestId: 'req-1' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), ['request', 'response']);
    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'top').map(log => log.id), ['response', 'request']);
});

test('Group related events preserves logical component operation chunks', () => {
    const logs = [
        entry('a-1', 'Doctor App', '2026-05-05T21:44:25.000Z', {
            componentLine: 1,
            details: { type: 'OUTGOING_REQUEST', method: 'get', url: 'https://pcm/r4' }
        }),
        entry('a-2', 'Doctor App', '2026-05-05T21:44:25.004Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_RESPONSE', url: 'https://pcm/r4' }
        }),
        entry('b-1', 'PCM Core', '2026-05-05T21:44:25.001Z', {
            componentLine: 1,
            details: { type: 'REQUEST', requestId: 'req-1' }
        }),
        entry('b-2', 'PCM Core', '2026-05-05T21:44:25.002Z', {
            componentLine: 2,
            details: { type: 'RESPONSE', requestId: 'req-1' }
        }),
        entry('a-3', 'Doctor App', '2026-05-05T21:44:25.005Z', {
            componentLine: 3,
            details: { type: 'OUTGOING_REQUEST', method: 'get', url: 'https://ds/fhir' }
        }),
        entry('a-4', 'Doctor App', '2026-05-05T21:44:25.006Z', {
            componentLine: 4,
            details: { type: 'OUTGOING_RESPONSE', url: 'https://ds/fhir' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'flow').map(log => log.id), [
        'a-4',
        'a-3',
        'a-2',
        'b-2',
        'b-1',
        'a-1'
    ]);
    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), [
        'a-1',
        'b-1',
        'b-2',
        'a-2',
        'a-3',
        'a-4'
    ]);
});

test('Group related events exposes descriptive operation headers', () => {
    const logs = [
        entry('doctor-token-request', 'Doctor App', '2026-05-05T21:44:25.000Z', {
            componentLine: 1,
            details: {
                type: 'OUTGOING_REQUEST',
                method: 'post',
                url: 'https://pcm-core:3000/token'
            }
        }),
        entry('pcm-token-request', 'PCM Core', '2026-05-05T21:44:25.001Z', {
            componentLine: 1,
            details: { type: 'REQUEST', requestId: 'token-1' }
        }),
        entry('pcm-token-response', 'PCM Core', '2026-05-05T21:44:25.002Z', {
            componentLine: 2,
            details: { type: 'RESPONSE', requestId: 'token-1', statusCode: 200 }
        }),
        entry('doctor-token-response', 'Doctor App', '2026-05-05T21:44:25.003Z', {
            componentLine: 2,
            details: {
                type: 'OUTGOING_RESPONSE',
                url: 'https://pcm-core:3000/token',
                status: 200
            }
        })
    ];

    const [first] = orderUnifiedLogs(logs, 'flow');
    assert.equal(first.flowGroup.title, 'Doctor App -> PCM Core: POST /token');
    assert.equal(first.flowGroup.subtitle, '4 entries');
});

test('Group related events uses user operation as the primary group label', () => {
    const logs = [
        entry('harness-start', 'Doctor App', '2026-05-05T21:44:24.900Z', {
            componentLine: 1,
            details: {
                type: 'HARNESS_ACTION_STARTED',
                operation: 'fetch-data',
                flowId: 'fetch-flow',
                category: 'harness',
                visibility: 'diagnostic'
            }
        }),
        entry('doctor-token-request', 'Doctor App', '2026-05-05T21:44:25.000Z', {
            componentLine: 2,
            details: {
                type: 'OUTGOING_REQUEST',
                operation: 'fetch-data',
                flowId: 'fetch-flow',
                method: 'post',
                url: 'https://pcm-core:3000/token'
            }
        }),
        entry('pcm-token-response', 'PCM Core', '2026-05-05T21:44:25.002Z', {
            componentLine: 1,
            details: { type: 'RESPONSE', flowId: 'fetch-flow', requestId: 'token-1', statusCode: 200 }
        }),
        entry('doctor-token-response', 'Doctor App', '2026-05-05T21:44:25.003Z', {
            componentLine: 3,
            details: {
                type: 'OUTGOING_RESPONSE',
                operation: 'fetch-data',
                flowId: 'fetch-flow',
                url: 'https://pcm-core:3000/token',
                status: 200
            }
        })
    ];

    const [first] = orderUnifiedLogs(logs, 'flow');
    assert.equal(first.flowGroup.title, 'Doctor App: fetch data');
    assert.match(first.flowGroup.subtitle, /POST \/token/);
});

test('Group related events merges 401 token refresh and immediate retry', () => {
    const logs = [
        entry('failed-request', 'Doctor App', '2026-05-05T21:44:25.000Z', {
            componentLine: 1,
            details: {
                type: 'OUTGOING_REQUEST',
                method: 'get',
                url: 'https://pcm-core:3000/r4/Consent?_id=abc123'
            }
        }),
        entry('failed-response', 'Doctor App', '2026-05-05T21:44:25.020Z', {
            componentLine: 2,
            details: {
                type: 'OUTGOING_ERROR',
                status: 401,
                url: 'https://pcm-core:3000/r4/Consent?_id=abc123'
            }
        }),
        entry('token-request', 'Doctor App', '2026-05-05T21:44:25.030Z', {
            componentLine: 3,
            details: {
                type: 'OUTGOING_REQUEST',
                method: 'post',
                url: 'https://pcm-core:3000/token'
            }
        }),
        entry('token-response', 'Doctor App', '2026-05-05T21:44:25.050Z', {
            componentLine: 4,
            details: {
                type: 'OUTGOING_RESPONSE',
                status: 200,
                url: 'https://pcm-core:3000/token'
            }
        }),
        entry('retry-request', 'Doctor App', '2026-05-05T21:44:25.060Z', {
            componentLine: 5,
            details: {
                type: 'OUTGOING_REQUEST',
                method: 'get',
                url: 'https://pcm-core:3000/r4/Consent?_id=abc123'
            }
        }),
        entry('retry-response', 'Doctor App', '2026-05-05T21:44:25.080Z', {
            componentLine: 6,
            details: {
                type: 'OUTGOING_RESPONSE',
                status: 200,
                url: 'https://pcm-core:3000/r4/Consent?_id=abc123'
            }
        })
    ];

    const flow = orderUnifiedLogs(logs, 'flow', 'bottom');
    assert.deepEqual(flow.map(log => log.id), [
        'failed-request',
        'failed-response',
        'token-request',
        'token-response',
        'retry-request',
        'retry-response'
    ]);
    assert.equal(new Set(flow.map(log => log.flowGroup.id)).size, 1);
    assert.match(flow[0].flowGroup.title, /Doctor App -> PCM Core: GET \/r4\/Consent/);
    assert.match(flow[0].flowGroup.subtitle, /401 -> token refresh -> retry/);
});

test('Group related events keeps nested outgoing calls inside the parent operation', () => {
    const logs = [
        entry('doctor-ds-request', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            componentLine: 1,
            details: { type: 'OUTGOING_REQUEST', method: 'get', url: 'https://ds/fhir/Observation' }
        }),
        entry('adapter-request', 'DS Auth Adapter', '2026-05-05T21:44:25.110Z', {
            componentLine: 1,
            details: { type: 'REQUEST', requestId: 'auth-1' }
        }),
        entry('adapter-introspect-request', 'DS Auth Adapter', '2026-05-05T21:44:25.120Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_REQUEST', method: 'post', url: 'https://pcm/introspect' }
        }),
        entry('pcm-request', 'PCM Core', '2026-05-05T21:44:25.130Z', {
            componentLine: 1,
            details: { type: 'REQUEST', requestId: 'pcm-1' }
        }),
        entry('pcm-response', 'PCM Core', '2026-05-05T21:44:25.140Z', {
            componentLine: 2,
            details: { type: 'RESPONSE', requestId: 'pcm-1' }
        }),
        entry('adapter-introspect-response', 'DS Auth Adapter', '2026-05-05T21:44:25.150Z', {
            componentLine: 3,
            details: { type: 'OUTGOING_RESPONSE', url: 'https://pcm/introspect' }
        }),
        entry('adapter-response', 'DS Auth Adapter', '2026-05-05T21:44:25.160Z', {
            componentLine: 4,
            details: { type: 'RESPONSE', requestId: 'auth-1' }
        }),
        entry('doctor-ds-response', 'Doctor App', '2026-05-05T21:44:25.170Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_RESPONSE', url: 'https://ds/fhir/Observation' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), [
        'doctor-ds-request',
        'adapter-request',
        'adapter-introspect-request',
        'pcm-request',
        'pcm-response',
        'adapter-introspect-response',
        'adapter-response',
        'doctor-ds-response'
    ]);
});

test('Group related events orders equal-time server response before client outgoing response', () => {
    const logs = [
        entry('doctor-request', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            componentLine: 1,
            details: { type: 'OUTGOING_REQUEST', method: 'get', url: 'https://ds/fhir/Observation' }
        }),
        entry('server-response', 'DS FHIR', '2026-05-05T21:44:25.200Z', {
            componentLine: 1,
            details: { type: 'RESPONSE', requestId: 'server-1' }
        }),
        entry('doctor-response', 'Doctor App', '2026-05-05T21:44:25.200Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_RESPONSE', url: 'https://ds/fhir/Observation' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), [
        'doctor-request',
        'server-response',
        'doctor-response'
    ]);
});

test('Group related events keeps downstream response before client received response despite small clock skew', () => {
    const logs = [
        entry('doctor-request', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            componentLine: 1,
            details: { type: 'OUTGOING_REQUEST', method: 'get', url: 'https://ds-gateway:8080/fhir/Observation' }
        }),
        entry('server-response', 'DS FHIR', '2026-05-05T21:44:25.205Z', {
            componentLine: 2,
            details: { type: 'RESPONSE', requestId: 'server-1', statusCode: 200 }
        }),
        entry('doctor-response', 'Doctor App', '2026-05-05T21:44:25.201Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_RESPONSE', status: 200, url: 'https://ds-gateway:8080/fhir/Observation' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), [
        'doctor-request',
        'server-response',
        'doctor-response'
    ]);
});

test('Group related events includes DS Gateway structured response in the parent operation', () => {
    const logs = [
        entry('doctor-request', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            componentLine: 1,
            details: { type: 'OUTGOING_REQUEST', correlationId: 'trace-a', method: 'get', url: 'https://ds-gateway:8080/fhir/Observation' }
        }),
        entry('gateway-response', 'DS Gateway', '2026-05-05T21:44:25.180Z', {
            componentLine: 1,
            details: { type: 'GATEWAY_RESPONSE', correlationId: 'trace-a', method: 'GET', url: '/fhir/Observation', statusCode: '504', upstreamStatus: '504' }
        }),
        entry('doctor-error', 'Doctor App', '2026-05-05T21:44:25.200Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_ERROR', correlationId: 'trace-a', status: 504, url: 'https://ds-gateway:8080/fhir/Observation' }
        })
    ];

    const ordered = orderUnifiedLogs(logs, 'flow', 'bottom');
    assert.deepEqual(ordered.map(log => log.id), ['doctor-request', 'gateway-response', 'doctor-error']);
    assert.equal(new Set(ordered.map(log => log.flowGroup.id)).size, 1);
});

test('Group related events correlates NGINX gateway errors with the matching structured gateway failure', () => {
    const gatewayError = parseGatewayErrorLine(
        '2026/05/13 14:49:44 [error] 21#21: *37 connect() failed (113: No route to host) while connecting to upstream, client: 172.18.0.5, server: , request: "GET /fhir/Observation HTTP/1.1", upstream: "http://172.18.0.3:3000/Observation", host: "ds-gateway:8080"',
        { id: 'gateway-error' }
    );
    gatewayError.component = 'DS Gateway';
    gatewayError.componentLine = 1;

    const logs = [
        entry('harness-start', 'Doctor App', '2026-05-13T14:49:41.400Z', {
            details: { type: 'HARNESS_ACTION_STARTED', operation: 'fetch-data', flowId: 'fetch-flow', correlationId: 'ui-corr', category: 'harness' }
        }),
        entry('doctor-request', 'Doctor App', '2026-05-13T14:49:41.484Z', {
            details: { type: 'OUTGOING_REQUEST', operation: 'fetch-data', flowId: 'fetch-flow', correlationId: 'ds-corr', method: 'get', url: 'https://ds-gateway:8080/fhir/Observation' }
        }),
        entry('gateway-response', 'DS Gateway', '2026-05-13T14:49:44.627Z', {
            details: {
                type: 'GATEWAY_RESPONSE',
                requestId: 'gateway-request',
                flowId: 'fetch-flow',
                correlationId: 'ds-corr',
                method: 'GET',
                url: '/fhir/Observation',
                originalUrl: '/fhir/Observation',
                statusCode: '502',
                upstreamStatus: '502',
                upstreamAddr: '172.18.0.3:3000'
            }
        }),
        gatewayError,
        entry('doctor-error', 'Doctor App', '2026-05-13T14:49:44.635Z', {
            details: { type: 'OUTGOING_ERROR', operation: 'fetch-data', flowId: 'fetch-flow', correlationId: 'ds-corr', status: 502, url: 'https://ds-gateway:8080/fhir/Observation' }
        })
    ];

    const ordered = orderUnifiedLogs(logs, 'flow', 'bottom');
    assert.deepEqual(ordered.map(log => log.id), [
        'harness-start',
        'doctor-request',
        'gateway-error',
        'gateway-response',
        'doctor-error'
    ]);
    assert.equal(new Set(ordered.map(log => log.flowGroup.id)).size, 1);
    assert.equal(ordered.find(log => log.id === 'gateway-error').details.correlationId, 'ds-corr');
    assert.equal(ordered.find(log => log.id === 'gateway-error').flowGroup.title, 'Doctor App: fetch data');
});

test('gateway request tie breaker keeps parent request before auth subrequest', () => {
    const logs = [
        entry('gateway-auth-request', 'DS Gateway', '2026-05-13T12:55:23.532Z', {
            componentLine: 1,
            details: {
                type: 'GATEWAY_REQUEST',
                flowId: 'fetch-flow',
                correlationId: 'ds-corr',
                method: 'GET',
                url: '/auth',
                originalUrl: '/fhir/Observation'
            }
        }),
        entry('gateway-parent-request', 'DS Gateway', '2026-05-13T12:55:23.532Z', {
            componentLine: 2,
            details: {
                type: 'GATEWAY_REQUEST',
                flowId: 'fetch-flow',
                correlationId: 'ds-corr',
                method: 'GET',
                url: '/fhir/Observation',
                originalUrl: '/fhir/Observation'
            }
        }),
        entry('gateway-auth-response', 'DS Gateway', '2026-05-13T12:55:23.604Z', {
            componentLine: 1,
            details: { type: 'GATEWAY_RESPONSE', flowId: 'fetch-flow', correlationId: 'ds-corr', method: 'GET', url: '/auth', originalUrl: '/fhir/Observation', statusCode: '200' }
        }),
        entry('gateway-parent-response', 'DS Gateway', '2026-05-13T12:55:23.611Z', {
            componentLine: 2,
            details: { type: 'GATEWAY_RESPONSE', flowId: 'fetch-flow', correlationId: 'ds-corr', method: 'GET', url: '/fhir/Observation', originalUrl: '/fhir/Observation', statusCode: '200' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'timeline', 'bottom').map(log => log.id), [
        'gateway-parent-request',
        'gateway-auth-request',
        'gateway-auth-response',
        'gateway-parent-response'
    ]);
    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), [
        'gateway-parent-request',
        'gateway-auth-request',
        'gateway-auth-response',
        'gateway-parent-response'
    ]);
});

test('Group related events does not merge unrelated gateway rows with a different correlation id', () => {
    const logs = [
        entry('doctor-request', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            componentLine: 1,
            details: { type: 'OUTGOING_REQUEST', correlationId: 'token-trace', method: 'post', url: 'https://pcm-core:3000/token' }
        }),
        entry('gateway-health', 'DS Gateway', '2026-05-05T21:44:25.101Z', {
            componentLine: 1,
            details: { type: 'GATEWAY_RESPONSE', correlationId: 'health-trace', method: 'GET', url: '/healthz', statusCode: '200' }
        }),
        entry('pcm-request', 'PCM Core', '2026-05-05T21:44:25.102Z', {
            componentLine: 1,
            details: { type: 'REQUEST', correlationId: 'token-trace', requestId: 'token-trace', method: 'POST', url: '/token' }
        }),
        entry('doctor-response', 'Doctor App', '2026-05-05T21:44:25.103Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_RESPONSE', correlationId: 'token-trace', status: 200, url: 'https://pcm-core:3000/token' }
        })
    ];

    const ordered = orderUnifiedLogs(logs, 'flow', 'bottom');
    const tokenGroupId = ordered.find(log => log.id === 'doctor-request').flowGroup.id;
    assert.equal(ordered.find(log => log.id === 'pcm-request').flowGroup.id, tokenGroupId);
    assert.equal(ordered.find(log => log.id === 'doctor-response').flowGroup.id, tokenGroupId);
    assert.notEqual(ordered.find(log => log.id === 'gateway-health').flowGroup.id, tokenGroupId);
});

test('Group related events uses flow id across distinct HTTP correlation ids', () => {
    const logs = [
        entry('harness-start', 'Doctor App', '2026-05-05T21:44:25.000Z', {
            details: { type: 'HARNESS_ACTION_STARTED', flowId: 'fetch-flow', correlationId: 'ui-corr', category: 'harness', visibility: 'diagnostic' }
        }),
        entry('token-out', 'Doctor App', '2026-05-05T21:44:25.010Z', {
            details: { type: 'OUTGOING_REQUEST', flowId: 'fetch-flow', correlationId: 'token-corr', method: 'post', url: 'https://pcm-core:3000/token' }
        }),
        entry('token-in', 'PCM Core', '2026-05-05T21:44:25.020Z', {
            details: { type: 'REQUEST', flowId: 'fetch-flow', correlationId: 'token-corr', requestId: 'token-corr', method: 'POST', url: '/token' }
        }),
        entry('token-back', 'Doctor App', '2026-05-05T21:44:25.040Z', {
            details: { type: 'OUTGOING_RESPONSE', flowId: 'fetch-flow', correlationId: 'token-corr', status: 200, url: 'https://pcm-core:3000/token' }
        }),
        entry('ds-out', 'Doctor App', '2026-05-05T21:44:25.080Z', {
            details: { type: 'OUTGOING_REQUEST', flowId: 'fetch-flow', correlationId: 'ds-corr', method: 'get', url: 'https://ds-gateway:8080/fhir/Observation' }
        }),
        entry('gateway', 'DS Gateway', '2026-05-05T21:44:25.100Z', {
            details: { type: 'GATEWAY_RESPONSE', flowId: 'fetch-flow', correlationId: 'ds-corr', method: 'GET', url: '/fhir/Observation', statusCode: '200' }
        }),
        entry('ds-back', 'Doctor App', '2026-05-05T21:44:25.120Z', {
            details: { type: 'OUTGOING_RESPONSE', flowId: 'fetch-flow', correlationId: 'ds-corr', status: 200, url: 'https://ds-gateway:8080/fhir/Observation' }
        })
    ];

    const ordered = orderUnifiedLogs(logs, 'flow', 'bottom');
    assert.equal(new Set(ordered.map(log => log.flowGroup.id)).size, 1);
    assert.deepEqual(new Set(ordered.map(log => log.details.correlationId)), new Set(['ui-corr', 'token-corr', 'ds-corr']));
});

test('DS Gateway error log parser produces structured raw gateway errors', () => {
    const parsed = parseGatewayErrorLine('2026/05/12 08:01:02 [error] 29#29: *7 upstream timed out while reading response header from upstream', {
        id: 'gateway-error-1'
    });

    assert.equal(parsed.id, 'gateway-error-1');
    assert.equal(parsed.level, 'ERROR');
    assert.equal(parsed.details.type, 'GATEWAY_ERROR');
    assert.equal(parsed.details.category, 'system');
    assert.match(parsed.message, /upstream timed out/);

    const connectFailure = parseGatewayErrorLine('2026/05/13 14:49:44 [error] 21#21: *37 connect() failed (113: No route to host) while connecting to upstream, client: 172.18.0.5, server: , request: "GET /fhir/Observation HTTP/1.1", upstream: "http://172.18.0.3:3000/Observation", host: "ds-gateway:8080"');
    assert.equal(connectFailure.details.method, 'GET');
    assert.equal(connectFailure.details.url, '/fhir/Observation');
    assert.equal(connectFailure.details.upstreamAddr, '172.18.0.3:3000');
    assert.equal(connectFailure.details.host, 'ds-gateway:8080');
});

test('DS Gateway structured access samples preserve upstream timeout and auth failure fields', () => {
    const timeoutLine = '{"timestamp":"2026-05-12T08:01:02+00:00","level":"INFO","message":"Gateway Response: 504 GET /fhir/Observation","details":{"type":"GATEWAY_RESPONSE","requestId":"gw-1","correlationId":"corr-1","category":"system","visibility":"default","method":"GET","url":"/fhir/Observation","originalUrl":"/fhir/Observation","timestampEpoch":"1778572862.987","statusCode":"504","status":"504","upstreamStatus":"504","upstreamAddr":"10.0.0.1:3004","upstreamResponseTime":"30.001","requestTime":"30.005","authStatus":"200","bytesSent":"0"}}';
    const authFailureLine = '{"timestamp":"2026-05-12T08:01:03+00:00","level":"INFO","message":"Gateway Response: 401 GET /fhir/Observation","details":{"type":"GATEWAY_RESPONSE","requestId":"gw-2","correlationId":"corr-2","category":"system","visibility":"default","method":"GET","url":"/fhir/Observation","originalUrl":"/fhir/Observation","timestampEpoch":"1778572863.123","statusCode":"401","status":"401","upstreamStatus":"","upstreamAddr":"","upstreamResponseTime":"","requestTime":"0.025","authStatus":"401","bytesSent":"0"}}';

    const timeout = JSON.parse(timeoutLine);
    const authFailure = JSON.parse(authFailureLine);

    assert.equal(timeout.details.upstreamStatus, '504');
    assert.equal(timeout.details.authStatus, '200');
    assert.equal(authFailure.details.statusCode, '401');
    assert.equal(authFailure.details.authStatus, '401');
    assert.equal(authFailure.details.correlationId, 'corr-2');
    assert.equal(authFailure.details.originalUrl, '/fhir/Observation');
});

test('unified logs synthesize gateway request rows from completion access logs', () => {
    const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
    const source = normalizeLogEntry({ id: 'completion', timestamp: '2026-11-04T10:00:01Z', level: 'ERROR',
        details: { type: 'GATEWAY_RESPONSE', role: 'gateway', method: 'GET', url: '/fhir/Observation', requestTime: '1', status: 401 } });
    const [request, response] = expandLogEntry(source);
    assert.equal(request.details.type, 'GATEWAY_REQUEST');
    assert.equal(request.message, 'Gateway Request: GET /fhir/Observation');
    assert.equal(request.timestamp, '2026-11-04T10:00:00.000Z');
    assert.equal(request.level, 'INFO'); assert.equal(request.details.status, undefined);
    assert.equal(response, source); assert.equal(response.level, 'ERROR');
});

test('Group related events attaches short lead-in messages to the next outgoing operation', () => {
    const logs = [
        entry('lead-in', 'Doctor App', '2026-05-05T21:44:25.099Z', {
            componentLine: 1,
            details: { targetUrl: 'https://ds/fhir' }
        }),
        entry('request', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            componentLine: 2,
            details: { type: 'OUTGOING_REQUEST', method: 'get', url: 'https://ds/fhir/Observation' }
        }),
        entry('response', 'Doctor App', '2026-05-05T21:44:25.200Z', {
            componentLine: 3,
            details: { type: 'OUTGOING_RESPONSE', url: 'https://ds/fhir/Observation' }
        })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'flow', 'bottom').map(log => log.id), [
        'lead-in',
        'request',
        'response'
    ]);
});

test('raw timeline orders globally newest first with deterministic tie breakers', () => {
    const logs = [
        entry('pcm-same-time', 'PCM Core', '2026-05-05T21:44:25.100Z', { componentLine: 2 }),
        entry('doctor-later-tick', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            tick: '200',
            componentLine: 1
        }),
        entry('doctor-earlier-tick', 'Doctor App', '2026-05-05T21:44:25.100Z', {
            tick: '100',
            componentLine: 2
        }),
        entry('oldest', 'PCM Core', '2026-05-05T21:44:25.099Z', { componentLine: 1 })
    ];

    assert.deepEqual(orderUnifiedLogs(logs, 'timeline').map(log => log.id), [
        'doctor-earlier-tick',
        'doctor-later-tick',
        'pcm-same-time',
        'oldest'
    ]);
    assert.deepEqual(orderUnifiedLogs(logs, 'timeline', 'bottom').map(log => log.id), [
        'oldest',
        'pcm-same-time',
        'doctor-later-tick',
        'doctor-earlier-tick'
    ]);
});

test('PCM logger writes tick and sequence fields for tie breaking', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-logger-order-'));
    const previousLogDir = process.env.LOG_DIR;
    try {
        process.env.LOG_DIR = tmp;
        delete require.cache[require.resolve('../src/logger')];
        const logger = require('../src/logger');

        logger.info('first');
        logger.info('second');

        const lines = fs.readFileSync(path.join(tmp, 'current.log'), 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));

        assert.match(lines[0].tick, /^\d+$/);
        assert.equal(lines[0].sequence, 1);
        assert.equal(lines[1].sequence, 2);
    } finally {
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
        delete require.cache[require.resolve('../src/logger')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('unified logs API defaults to visibility filtering instead of path filtering', () => {
    const { normalizeLogEntry } = require('../src/log-normalization');
    const { matches } = require('../src/unified-log-page');
    const diagnostic = normalizeLogEntry({ details: { type: 'HARNESS_ERROR', url: '/public' } });
    assert.equal(matches(diagnostic, {}), false);
    assert.equal(matches(diagnostic, { diagnostics: 'true' }), true);
    const visible = normalizeLogEntry({ details: { type: 'REQUEST', url: '/admin/example', category: 'recorded' } });
    assert.equal(matches(visible, {}), true); assert.equal(visible.details.category, 'recorded');
    const hidden = normalizeLogEntry({ details: { type: 'REQUEST', visibility: 'hidden' } });
    assert.equal(matches(hidden, { diagnostics: 'true' }), false);
    assert.equal(matches(hidden, { visibility: 'all' }), true);
});

test('component reader retains current, rotated and gateway diagnostics with stable line coordinates', () => {
    const { readComponentLogRecords } = require('../src/log-reader');
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-log-reader-'));
    const component = path.join(tmp, 'ds-gateway');
    fs.mkdirSync(path.join(component, 'history', '2026-01-01'), { recursive: true });
    const previous = { id: 'previous', message: 'retained token', details: { authorization: 'Bearer synthetic' } };
    fs.writeFileSync(path.join(component, 'history/2026-01-01/app.log'), `${JSON.stringify(previous)}\n`);
    fs.writeFileSync(path.join(component, 'current.log'), '{"id":"current"}\ninterrupted JSON write\n');
    fs.writeFileSync(path.join(component, 'error.log'), '2026/05/13 14:49:44 [error] 21#21: *37 connect() failed (113: No route to host) while connecting to upstream, client: 172.18.0.5, server: , request: "GET /fhir/Observation HTTP/1.1", upstream: "http://172.18.0.3:3000/Observation", host: "ds-gateway:8080"\n');
    try {
        const records = readComponentLogRecords(tmp, 'ds-gateway', 'DS Gateway');
        assert.deepEqual(records.map(record => [record.logFile, record.componentLine]), [
            ['history/2026-01-01/app.log', 1], ['current.log', 1], ['current.log', 2], ['error.log', 1]
        ]);
        assert.deepEqual(records[0].parsed, previous);
        assert.equal(records[2].parsed, null);
        assert.equal(records[2].raw, 'interrupted JSON write');
        assert.equal(records[3].parsed.id, 'DS Gateway-error.log-1');
        assert.match(records[3].parsed.message, /connect\(\) failed/);
        assert.deepEqual(readComponentLogRecords(tmp, 'not-started'), []);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
