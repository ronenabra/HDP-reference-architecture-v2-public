'use strict';

/** Small W3C traceparent boundary; tracing metadata never authorizes a request. */
const { randomBytes } = require('node:crypto');

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const FLAGS = /^[0-9a-f]{2}$/;
const MAX_TRACEPARENT_LENGTH = 512;

/** Return a validated context, or null for malformed, duplicate or zero IDs. */
function parseTraceparent(value) {
    if (typeof value !== 'string' || value.length < 55 || value.length > MAX_TRACEPARENT_LENGTH
        || /[^\x21-\x7e]|,/.test(value)) return null;
    const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/.exec(value);
    if (!match || match[1] === 'ff' || /^0+$/.test(match[2]) || /^0+$/.test(match[3])) return null;
    // Higher versions may append fields. Only the known prefix is interpreted;
    // propagation always writes v00 and clears unknown/reserved flag bits.
    if (match[1] === '00' ? match[5] !== '' : (match[5] !== '' && !match[5].startsWith('-'))) return null;
    return Object.freeze({ traceId: match[2], spanId: match[3], traceFlags: sampledFlag(match[4]) });
}

/** Preserve the sampled bit without giving it control over sandbox log policy. */
function sampledFlag(value) {
    return (parseInt(value, 16) & 1) === 1 ? '01' : '00';
}

/** Serialize known v00 fields; invalid in-process contexts are not propagated. */
function formatTraceparent(context) {
    if (!context || typeof context.traceId !== 'string' || !TRACE_ID.test(context.traceId) || /^0+$/.test(context.traceId)
        || typeof context.spanId !== 'string' || !SPAN_ID.test(context.spanId) || /^0+$/.test(context.spanId)
        || typeof context.traceFlags !== 'string' || !FLAGS.test(context.traceFlags)) return undefined;
    return `00-${context.traceId}-${context.spanId}-${sampledFlag(context.traceFlags)}`;
}

/** Generate an unpredictable, nonzero ID of the requested byte length. */
function randomId(bytes) {
    let value;
    do { value = randomBytes(bytes).toString('hex'); } while (/^0+$/.test(value));
    return value;
}

/** Start one actual local span, retaining only a validated remote/local parent. */
function createTraceContext(parent) {
    const accepted = typeof parent === 'string'
        ? parseTraceparent(parent)
        : parseTraceparent(formatTraceparent(parent));
    return Object.freeze({
        traceId: accepted?.traceId || randomId(16),
        spanId: randomId(8),
        ...(accepted ? { parentSpanId: accepted.spanId } : {}),
        traceFlags: accepted?.traceFlags || '00'
    });
}

/** Read plain Node headers or AxiosHeaders without assuming header-name case. */
function readHeader(headers, name) {
    if (!headers) return undefined;
    const values = Object.keys(headers).filter(key => key.toLowerCase() === name.toLowerCase());
    if (values.length > 1) return undefined;
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[values[0]];
    return typeof value === 'string' ? value : undefined;
}

/** Keep legacy joins alongside a valid traceparent; do not fabricate a flow ID. */
function propagationHeaders(context = {}) {
    const traceparent = formatTraceparent(context);
    return {
        ...(context.correlationId ? { 'x-correlation-id': context.correlationId } : {}),
        ...(context.flowId ? { 'x-flow-id': context.flowId } : {}),
        ...(traceparent ? { traceparent } : {})
    };
}

module.exports = { createTraceContext, formatTraceparent, parseTraceparent, propagationHeaders, readHeader };
