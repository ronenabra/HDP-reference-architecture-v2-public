'use strict';

/** Trace parsing, per-request isolation, emitted spans and the AWS-only boundary. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLogger } = require('../../shared/logger');
const { createTraceContext, formatTraceparent, parseTraceparent, propagationHeaders, readHeader } = require('../../shared/trace-context');

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const HEADER = `00-${TRACE_ID}-${PARENT_ID}-01`;

/** Build a service logger with a temporary file and controllable finish hooks. */
function fixture(t, service = 'pcm-core') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-trace-'));
    const previous = process.env.LOG_DIR;
    process.env.LOG_DIR = directory;
    const completions = new Map();
    const logger = createLogger({ service, onFinished: (res, callback) => completions.set(res, callback) });
    if (previous === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previous;
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return {
        logger, completions,
        entries: () => fs.existsSync(logger.getLogPath())
            ? fs.readFileSync(logger.getLogPath(), 'utf8').trim().split('\n').map(JSON.parse)
            : []
    };
}

/** Minimal Express request/response pair; no real network or server is needed. */
function exchange(headers = {}, url = '/introspect') {
    const req = { headers, path: url, originalUrl: url, method: 'POST', body: { token: 'sandbox-opaque' }, get: name => headers[name] };
    const res = new EventEmitter();
    const responseHeaders = {};
    Object.assign(res, {
        statusCode: 200,
        writableEnded: false,
        setHeader: (name, value) => { responseHeaders[name] = value; },
        getHeaders: () => responseHeaders,
        send(body) { this.body = body; this.writableEnded = true; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { return this.send(body); }
    });
    return { req, res, responseHeaders };
}

test('traceparent accepts valid v00 and a bounded future-version prefix', () => {
    assert.deepEqual(parseTraceparent(HEADER), { traceId: TRACE_ID, spanId: PARENT_ID, traceFlags: '01' });
    assert.equal(parseTraceparent(HEADER.slice(0, -2) + '00').traceFlags, '00');
    assert.equal(parseTraceparent(HEADER.slice(0, -2) + 'fe').traceFlags, '00');
    const future = parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-09-future`);
    assert.deepEqual(future, { traceId: TRACE_ID, spanId: PARENT_ID, traceFlags: '01' });
    assert.equal(formatTraceparent(future), HEADER);
});

test('traceparent rejects malformed, zero, duplicated, oversized and injected values', () => {
    const invalid = [
        undefined, null, 1, [HEADER], {}, '', HEADER.toUpperCase(), ` ${HEADER}`, `${HEADER}\r\nignored: value`,
        `${HEADER},${HEADER}`, `${HEADER}-extra`, HEADER.slice(0, -1), HEADER + '0',
        HEADER.replace('00-', 'ff-'), HEADER.replace(TRACE_ID, '0'.repeat(32)), HEADER.replace(PARENT_ID, '0'.repeat(16)),
        HEADER.replace(TRACE_ID, 'g'.repeat(32)), HEADER.slice(0, -2) + 'gg',
        `01-${TRACE_ID}-${PARENT_ID}-01x`, `01-${TRACE_ID}-${PARENT_ID}-01-${'x'.repeat(513)}`
    ];
    for (const value of invalid) assert.equal(parseTraceparent(value), null, JSON.stringify(value));
    assert.equal(formatTraceparent({ traceId: [TRACE_ID], spanId: PARENT_ID, traceFlags: '01' }), undefined);
});

test('span generation retains valid parents and starts an independent trace for invalid input', () => {
    const child = createTraceContext(HEADER);
    assert.equal(child.traceId, TRACE_ID);
    assert.equal(child.parentSpanId, PARENT_ID);
    assert.notEqual(child.spanId, PARENT_ID);
    assert.equal(child.traceFlags, '01');
    const sibling = createTraceContext(HEADER);
    assert.notEqual(child.spanId, sibling.spanId);
    for (const input of [undefined, 'invalid', `00-${'0'.repeat(32)}-${PARENT_ID}-01`]) {
        const root = createTraceContext(input);
        assert.ok(parseTraceparent(formatTraceparent(root)));
        assert.notEqual(root.traceId, TRACE_ID);
        assert.equal(root.parentSpanId, undefined);
        assert.equal(root.traceFlags, '00');
    }
    assert.deepEqual(propagationHeaders({ correlationId: 'legacy', flowId: 'flow', ...child }), {
        'x-correlation-id': 'legacy', 'x-flow-id': 'flow', traceparent: formatTraceparent(child)
    });
    assert.deepEqual(propagationHeaders({ correlationId: 'legacy' }), { 'x-correlation-id': 'legacy' });
    assert.equal(readHeader({ 'X-Correlation-Id': 'legacy' }, 'x-correlation-id'), 'legacy');
    assert.equal(readHeader({ Traceparent: HEADER, traceparent: 'duplicate' }, 'traceparent'), undefined);
});

test('concurrent async requests retain their own context and restore the parent after nesting', async t => {
    const { logger, entries } = fixture(t);
    const values = ['first', 'second', 'third'].map(id => ({ correlationId: id, flowId: `flow-${id}`, ...createTraceContext() }));
    await Promise.all(values.map((value, index) => logger.withContext(value, async () => {
        await new Promise(resolve => setTimeout(resolve, (3 - index) * 2));
        assert.equal(logger.getCorrelationId(), value.correlationId);
        await logger.withContext({ operation: 'nested' }, async () => {
            await Promise.resolve();
            assert.deepEqual(logger.getTraceContext(), { traceId: value.traceId, spanId: value.spanId, traceFlags: value.traceFlags });
        });
        logger.info('isolated', { type: 'ISOLATION' });
        assert.equal(logger.getPropagationHeaders()['x-flow-id'], value.flowId);
    })));
    for (const value of values) {
        const entry = entries().find(item => item.details.correlationId === value.correlationId);
        assert.equal(entry.details.flowId, value.flowId);
        assert.equal(entry.details.traceId, value.traceId);
        assert.equal(entry.details.spanId, value.spanId);
    }
    assert.equal(logger.getCorrelationId(), undefined);
    assert.deepEqual(logger.getPropagationHeaders(), {});
});

test('request and completion emit the same server span, including callbacks outside ALS', t => {
    const { logger, entries, completions } = fixture(t);
    const pairs = ['one', 'two'].map(id => exchange({ 'x-correlation-id': id, 'x-flow-id': `flow-${id}`, traceparent: HEADER }));
    for (const { req, res, responseHeaders } of pairs) {
        logger.requestLogger(req, res, () => {
            const span = logger.getTraceContext();
            assert.equal(span.traceId, TRACE_ID);
            assert.equal(span.parentSpanId, PARENT_ID);
            assert.equal(responseHeaders.traceparent, formatTraceparent(span));
            assert.equal(res.send('{"active":false}'), res);
        });
    }
    assert.equal(logger.getCorrelationId(), undefined);
    // Reverse completion order and deliver both finish and close for each socket.
    for (const { res } of pairs.reverse()) { completions.get(res)(); res.emit('close'); }
    const records = entries();
    assert.equal(records.length, 4);
    for (const id of ['one', 'two']) {
        const matching = records.filter(entry => entry.details.correlationId === id);
        assert.deepEqual(matching.map(entry => entry.details.type), ['REQUEST', 'RESPONSE']);
        assert.equal(matching[0].details.spanId, matching[1].details.spanId);
        for (const record of matching) {
            assert.equal(record.details.parentSpanId, PARENT_ID);
            assert.equal(record.event.provenance.kind, 'emitted');
            assert.equal(record.event.correlation.traceId, TRACE_ID);
            assert.equal(record.event.correlation.flowId, `flow-${id}`);
        }
    }
    assert.notEqual(records[0].details.spanId, records[1].details.spanId);
});

test('invalid incoming traces become fresh roots without changing correlation or error handling', t => {
    const { logger, entries } = fixture(t, 'ds-auth-adapter');
    const { req, res, responseHeaders } = exchange({ 'x-correlation-id': 'legacy', 'x-flow-id': 'legacy-flow', traceparent: 'bad' });
    logger.requestLogger(req, res, () => {
        assert.equal(logger.getFlowId(), 'legacy-flow');
        assert.equal(logger.getTraceContext().parentSpanId, undefined);
        logger.errorLogger(new Error('original error'), req, res, () => assert.fail('unexpected next'));
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body, 'Internal Server Error');
    assert.equal(responseHeaders['x-correlation-id'], 'legacy');
    assert.ok(parseTraceparent(responseHeaders.traceparent));
    const records = entries();
    assert.equal(records[0].details.traceId, records[1].details.traceId);
    assert.equal(records[0].details.spanId, records[1].details.spanId);
});

test('noise and harness middleware remain suppressed while request context is available', t => {
    const { logger, entries } = fixture(t, 'sp-client');
    for (const url of ['/healthz', '/api/unified-logs', '/fetch-data']) {
        const { req, res } = exchange({}, url);
        logger.requestLogger(req, res, () => {
            assert.ok(logger.getCorrelationId());
            assert.ok(parseTraceparent(logger.getPropagationHeaders().traceparent));
            if (url === '/fetch-data') assert.ok(logger.getFlowId());
            else assert.equal(logger.getFlowId(), undefined);
        });
    }
    assert.deepEqual(entries(), []);
});

test('AWS credentials are scrubbed from context, message, details and the event envelope', t => {
    const { logger, entries } = fixture(t);
    const awsKey = 'AKIA' + 'Z'.repeat(16);
    logger.withContext({ correlationId: awsKey, flowId: awsKey, ...createTraceContext() }, () => logger.info(`AWS ${awsKey}`, {
        type: 'AWS_CANARY', aws_secret_access_key: 'synthetic-secret',
        headers: { Authorization: 'Bearer sandbox-token', 'x-amz-security-token': 'synthetic-session' },
        body: { resourceType: 'Patient', id: '123', token: 'ordinary-token' },
        error: new Error(`blocked ${awsKey}`)
    }));
    const record = entries()[0];
    assert.doesNotMatch(JSON.stringify(record), new RegExp(`${awsKey}|synthetic-secret|synthetic-session`));
    assert.equal(record.details.correlationId, '[AWS_CREDENTIAL_BLOCKED]');
    assert.equal(record.event.correlation.correlationId, '[AWS_CREDENTIAL_BLOCKED]');
    assert.equal(record.details.headers.Authorization, 'Bearer sandbox-token');
    assert.equal(record.details.body.id, '123');
    assert.equal(record.details.body.token, 'ordinary-token');
});
