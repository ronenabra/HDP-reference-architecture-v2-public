'use strict';
/** Canonical timeline classification and gateway projections shared by browse and search. */
const { createEventMetadata } = require('../../shared/log-event');
const { knownLogClassification } = require('../../shared/log-policy');

/** Infer established visibility/category; narrow approved corrections are applied separately. */
function defaultLogClassification(entry) {
    const details = entry.details || {};
    const type = String(details.type || '');
    const message = String(entry.message || '');

    if (type.startsWith('PROCESS_')) {
        const isFailure = /FAILED|ERROR|UNCAUGHT|UNHANDLED/.test(type);
        return { category: 'lifecycle', visibility: isFailure ? 'default' : 'diagnostic', causesSystemFlow: false };
    }
    if (type.startsWith('HARNESS_') || /^Harness /.test(message)) {
        return { category: 'harness', visibility: 'diagnostic' };
    }
    if (['DATA_FETCH_COMPLETED', 'DATA_FETCH_FAILED'].includes(type) || /^Consent Created:/.test(message)) {
        return { category: 'harness', visibility: 'diagnostic' };
    }
    if (type === 'TOKEN_VALIDATION') {
        return { category: 'security', visibility: 'default' };
    }
    if ([
        'REQUEST', 'RESPONSE', 'OUTGOING_REQUEST', 'OUTGOING_RESPONSE', 'OUTGOING_ERROR',
        'GATEWAY_REQUEST', 'GATEWAY_RESPONSE', 'GATEWAY_ERROR', 'TOKEN_ISSUED', 'TOKEN_MINTED',
        'INTROSPECTION_PROCESSED', 'INTROSPECTION_TOKEN_REFRESH', 'IDENTITY_MAPPED',
        'DATA_FETCH_UNEXPECTED_RESPONSE'
    ].includes(type) || /^Introspection Request:/.test(message)) {
        return { category: 'system', visibility: 'default' };
    }
    return { category: 'uncategorized', visibility: 'default' };
}

/** Project recorded epoch/ISO timestamps to UTC when valid, retaining unknown source values. */
function normalizeTimestamp(timestamp, details = {}) {
    const epochSeconds = Number(details.timestampEpoch);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0 && epochSeconds <= 8640000000000) {
        return new Date(Math.round(epochSeconds * 1000)).toISOString();
    }
    const parsed = Date.parse(timestamp || '');
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : timestamp;
}

/** Return canonical timestamp/classification while preserving source fields and payloads. */
function normalizeLogEntry(entry) {
    const inferred = defaultLogClassification(entry);
    return {
        ...entry,
        timestamp: normalizeTimestamp(entry.timestamp, entry.details),
        details: {
            ...(entry.details || {}),
            category: entry.details?.category || inferred.category,
            visibility: entry.details?.visibility || inferred.visibility,
            causesSystemFlow: entry.details?.causesSystemFlow ?? inferred.causesSystemFlow,
            ...knownLogClassification(entry)
        }
    };
}

/** Estimate arrival from a valid completion duration, otherwise retain the completion time. */
function gatewayRequestTimestamp(entry) {
    const requestTime = Number(entry.details?.requestTime || 0);
    const endMs = Date.parse(entry.timestamp || '');
    if (!Number.isFinite(endMs) || !Number.isFinite(requestTime) || requestTime < 0) return entry.timestamp;
    return new Date(Math.max(0, endMs - Math.round(requestTime * 1000))).toISOString();
}

/** Reconstruct an informational request point while preserving its source completion.
 * @param {object} entry Normalized source event.
 * @returns {object[]} Derived request and source completion, or the source alone.
 */
function expandLogEntry(entry) {
    if (entry.details?.type !== 'GATEWAY_RESPONSE' || (entry.details.role && entry.details.role !== 'gateway')) return [entry];
    // A successful early append is recorded on this same source's completion.
    // The immutable identity marker avoids cross-page/rotation scans or growing
    // pairing state. Absence from this bounded view says nothing about outcome.
    if (entry.details.arrivalProtocol === 'nginx-early/1' && /^[a-f0-9]{32}$/.test(entry.details.arrivalId || '')) return [entry];
    const requestEntry = {
        ...entry,
        id: `${entry.id}-gateway-request`,
        // Arrival is informational regardless of the later response outcome.
        level: 'INFO',
        timestamp: gatewayRequestTimestamp(entry),
        message: `Gateway Request: ${entry.details.method || ''} ${entry.details.url || ''}`.trim(),
        details: {
            ...entry.details,
            type: 'GATEWAY_REQUEST',
            status: undefined,
            statusCode: undefined,
            upstreamStatus: undefined,
            upstreamAddr: undefined,
            upstreamResponseTime: undefined,
            authStatus: undefined,
            bytesSent: undefined
        }
    };
    requestEntry.event = createEventMetadata(requestEntry, entry.event?.source || {}, {
        kind: 'derived', derivedFrom: entry.id, derivation: 'gateway-completion',
        note: 'Request point reconstructed from completion. Start time is estimated only when a valid duration is recorded; raw source is the gateway response record.'
    });
    return [requestEntry, entry];
}

module.exports = { normalizeLogEntry, expandLogEntry };
