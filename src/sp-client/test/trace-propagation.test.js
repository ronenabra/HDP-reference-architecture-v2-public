'use strict';
/** Actual Doctor wire attempts retain one client span through success/error and concurrency. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
require('../../../test-support/team-config').installTestRuntime();
require('../src/client');
const axios = require('axios');
const logger = require('../src/logger');
const { createTraceContext, formatTraceparent, parseTraceparent } = require('../../shared/trace-context');

/** Read only actual attempted HTTP records, excluding test fixture lifecycle noise. */
function records(correlation) {
    return fs.readFileSync(logger.getLogPath(), 'utf8').trim().split('\n').map(JSON.parse)
        .filter(row => row.details.correlationId === correlation && row.details.type.startsWith('OUTGOING_'));
}

test('Doctor real concurrent success/error attempts propagate separate children and preserve their terminal context', async t => {
    const received = [];
    const server = http.createServer((req, res) => {
        received.push({ url: req.url, trace: parseTraceparent(req.headers.traceparent), correlation: req.headers['x-correlation-id'] });
        setTimeout(() => { res.writeHead(req.url === '/error' ? 500 : 200, { 'content-type': 'application/json' }); res.end('{"patient":"synthetic","token":"ordinary-value"}'); }, req.url === '/slow' ? 20 : 0);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const contexts = ['slow', 'fast', 'error'].map(name => ({ name, parent: createTraceContext(), correlationId: 'doctor-trace-' + name, flowId: 'doctor-flow-' + name }));
    await Promise.all(contexts.map(({ name, parent, correlationId, flowId }) => logger.withContext({ ...parent, flowId }, async () => {
        const result = axios.get(base + '/' + name, { headers: { 'x-correlation-id': correlationId } });
        if (name === 'error') await assert.rejects(result, error => error.response.status === 500);
        else await result;
    })));
    for (const context of contexts) {
        const wire = received.find(row => row.correlation === context.correlationId), events = records(context.correlationId);
        assert.equal(wire.trace.traceId, context.parent.traceId);
        assert.notEqual(wire.trace.spanId, context.parent.spanId);
        assert.equal(events.length, 2);
        assert.deepEqual(events.map(row => row.details.type), ['OUTGOING_REQUEST', context.name === 'error' ? 'OUTGOING_ERROR' : 'OUTGOING_RESPONSE']);
        for (const row of events) {
            assert.equal(row.details.traceId, wire.trace.traceId);
            assert.equal(row.details.spanId, wire.trace.spanId);
            assert.equal(row.details.parentSpanId, context.parent.spanId);
            assert.equal(row.details.flowId, context.flowId);
        }
        assert.equal(events[1].details.data.token, 'ordinary-value');
    }
    assert.equal(new Set(received.map(row => row.trace.spanId)).size, 3);
    assert.deepEqual(logger.getTraceContext(), {});
});

test('Doctor explicit valid caller parent and malformed input create truthful separate wire contexts', async t => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(parseTraceparent(req.headers.traceparent)); res.end('ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const parent = createTraceContext();
    for (const [name, value] of [['valid', formatTraceparent(parent)], ['invalid', 'malformed']]) {
        await axios.get(`http://127.0.0.1:${server.address().port}/`, { headers: { traceparent: value, 'x-correlation-id': 'doctor-input-' + name } });
        const events = records('doctor-input-' + name);
        assert.equal(events.length, 2);
        assert.equal(events[0].details.traceId, seen.at(-1).traceId);
        assert.equal(events[0].details.spanId, events[1].details.spanId);
        if (name === 'valid') assert.equal(events[0].details.parentSpanId, parent.spanId);
        else { assert.equal(events[0].details.parentSpanId, undefined); assert.notEqual(events[0].details.traceId, parent.traceId); }
    }
});

test('Doctor actual connection refusal preserves the attempted client span in its error terminal', async () => {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const parent = createTraceContext(), correlationId = 'doctor-actual-refusal';
    await logger.withContext(parent, () => assert.rejects(axios.get(`http://127.0.0.1:${port}/`, { headers: { 'x-correlation-id': correlationId } }), error => error.code === 'ECONNREFUSED'));
    const events = records(correlationId);
    assert.deepEqual(events.map(row => row.details.type), ['OUTGOING_REQUEST', 'OUTGOING_ERROR']);
    assert.equal(events[0].details.parentSpanId, parent.spanId);
    assert.equal(events[0].details.spanId, events[1].details.spanId);
    assert.equal(events[0].details.traceId, events[1].details.traceId);
    assert.equal(events[1].details.status, undefined);
});
