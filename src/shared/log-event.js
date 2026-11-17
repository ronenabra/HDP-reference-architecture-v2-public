'use strict';
/** Additive, versioned event metadata. This is a local JSONL contract, not OTLP. */
const { sanitizeLogDetails, sanitizeLogMessage } = require('./log-policy');
const SCHEMA_VERSION = '1.0';
const ROLES = Object.freeze(['pcm', 'doctor', 'gateway', 'adapter', 'fhir', 'hapi', 'hapi-import', 'application', 'middleware', 'security', 'addon']);
const EXTENSION_ROLES = Object.freeze(['application', 'middleware', 'security', 'addon']);
const FORMATS = Object.freeze(['hdp-jsonl', 'otel-log-record']);
const text = (value, limit = 256) => typeof value === 'string' ? sanitizeLogMessage(value).slice(0, limit) : '';
const traceId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value) ? value : undefined;
const spanId = value => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value) ? value : undefined;

/** Use configured source identity, never an imported record's claimed service or role. */
function createEventMetadata(entry = {}, source = {}, provenance = undefined) {
    const details = entry.details || {};
    const previous = entry.event || {};
    const correlation = previous.correlation || {};
    const role = source.role || details.role || previous.source?.role;
    return {
        schemaVersion: SCHEMA_VERSION,
        eventName: text(details.type || previous.eventName || 'UNSTRUCTURED_LOG', 128),
        source: {
            componentId: text(source.componentId || source.dir || previous.source?.componentId || entry.component || 'unknown', 128),
            role: ROLES.includes(role) ? role : 'application',
            ...(source.healthOrganizationId ? { healthOrganizationId: text(source.healthOrganizationId, 80) } : {})
        },
        correlation: {
            ...(details.flowId || correlation.flowId ? { flowId: text(details.flowId || correlation.flowId) } : {}),
            ...(details.correlationId || correlation.correlationId ? { correlationId: text(details.correlationId || correlation.correlationId) } : {}),
            ...(traceId(details.traceId || correlation.traceId) ? { traceId: traceId(details.traceId || correlation.traceId) } : {}),
            ...(spanId(details.spanId || correlation.spanId) ? { spanId: spanId(details.spanId || correlation.spanId) } : {}),
            ...(spanId(details.parentSpanId || correlation.parentSpanId) ? { parentSpanId: spanId(details.parentSpanId || correlation.parentSpanId) } : {}),
            ...(/^[0-9a-f]{2}$/.test(details.traceFlags || correlation.traceFlags || '') ? { traceFlags: details.traceFlags || correlation.traceFlags } : {})
        },
        provenance: {
            kind: ['emitted', 'derived', 'imported', 'unparsed'].includes(provenance?.kind) ? provenance.kind : 'emitted',
            ...(provenance?.derivedFrom ? { derivedFrom: text(provenance.derivedFrom) } : {}),
            ...(provenance?.derivation ? { derivation: text(provenance.derivation, 80) } : {}),
            ...(provenance?.note ? { note: text(provenance.note, 512) } : {}),
            ...(provenance?.format ? { format: text(provenance.format, 80) } : {})
        }
    };
}

/** Validate opt-in file sources. No paths, modules, endpoints or built-in identities are accepted. */
function configuredExtensionSources(config = {}) {
    const values = config.observability?.sources || [];
    if (!Array.isArray(values) || values.length > 16) throw new TypeError('At most 16 observability sources are supported');
    const seen = new Set();
    return values.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => !['id', 'label', 'role', 'format'].includes(key))
            || typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id)
            || seen.has(value.id) || !EXTENSION_ROLES.includes(value.role)
            || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
            || !FORMATS.includes(value.format || 'hdp-jsonl')) throw new TypeError('Invalid or duplicate observability source');
        seen.add(value.id);
        return { dir: `extensions/${value.id}`, label: value.label, role: value.role,
            format: value.format || 'hdp-jsonl', coverage: 'extension', external: true, readOnly: true };
    });
}

/** Decode one OpenTelemetry JSON LogRecord without accepting OTLP envelopes or untrusted schemas. */
function fromOtelLogRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.resourceLogs) throw new TypeError('Expected one OpenTelemetry LogRecord');
    record = sanitizeExternalRecord(record, { format: 'otel-log-record' });
    const millis = /^\d{1,20}$/.test(String(record.timeUnixNano || '')) ? Number(BigInt(record.timeUnixNano) / 1000000n) : NaN;
    const attributes = {};
    if (Array.isArray(record.attributes)) for (const item of record.attributes.slice(0, 64)) {
        if (item && typeof item.key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(item.key)) {
            const value = item.value;
            if (value && typeof value === 'object') attributes[item.key] = value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue;
        }
    }
    return {
        timestamp: Number.isFinite(millis) && millis >= 0 && millis <= 8640000000000000 ? new Date(millis).toISOString() : undefined,
        level: text(record.severityText || 'INFO', 32),
        message: typeof record.body?.stringValue === 'string' ? record.body.stringValue : JSON.stringify(record.body ?? ''),
        details: { type: text(record.eventName || 'EXTERNAL_LOG', 128), attributes,
            traceId: traceId(record.traceId), spanId: spanId(record.spanId),
            ...(Number.isInteger(record.flags) ? { traceFlags: (record.flags & 255).toString(16).padStart(2, '0') } : {}) }
    };
}

/** Scrub OTel KeyValue/AnyValue structures using semantic keys, including nested kvlists. */
function sanitizeExternalRecord(record, source) {
    if (source.format !== 'otel-log-record') return sanitizeLogDetails(record);
    function visit(value, depth = 0) {
        if (depth > 64) throw new TypeError('External record nesting exceeds 64 levels');
        if (!value || typeof value !== 'object') return sanitizeLogDetails(value);
        if (Array.isArray(value)) {
            const keyed = value.filter(item => item && typeof item === 'object' && typeof item.key === 'string' && Object.hasOwn(item, 'value'));
            const safeValues = sanitizeLogDetails(Object.fromEntries(keyed.map(item => [item.key, item.value])));
            return value.map(item => {
                if (keyed.includes(item)) {
                    const safe = safeValues[item.key];
                    return { ...visit(item, depth + 1), value: typeof safe === 'string'
                        ? { stringValue: safe } : visit(safe, depth + 1) };
                }
                return visit(item, depth + 1);
            });
        }
        return Object.fromEntries(Object.entries(sanitizeLogDetails(value)).map(([key, item]) => [key, visit(item, depth + 1)]));
    }
    return visit(record);
}

/** Normalize a read-only extension record; external events are always opt-in diagnostics. */
function normalizeExtensionRecord(record, source) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Expected an object log record');
    if (source.format !== 'otel-log-record' && record.event?.schemaVersion && record.event.schemaVersion !== SCHEMA_VERSION) {
        throw new TypeError('Unsupported external event schema version');
    }
    if (source.format !== 'otel-log-record') {
        for (const key of ['timestamp', 'level', 'message', 'id']) if (record[key] !== undefined && typeof record[key] !== 'string') throw new TypeError(`External ${key} must be a string`);
        if (record.details !== undefined && (!record.details || typeof record.details !== 'object' || Array.isArray(record.details))) throw new TypeError('External details must be an object');
        for (const key of ['type', 'category', 'visibility', 'method', 'url', 'originalUrl', 'flowId', 'correlationId', 'requestId', 'traceId', 'spanId', 'parentSpanId', 'traceFlags']) {
            if (record.details?.[key] !== undefined && typeof record.details[key] !== 'string') throw new TypeError(`External details.${key} must be a string`);
        }
        for (const key of ['tick', 'sequence']) if (record[key] !== undefined && !['number', 'string'].includes(typeof record[key])) throw new TypeError(`External ${key} must be scalar`);
        for (const key of ['timestampEpoch', 'requestTime', 'status', 'statusCode']) if (record.details?.[key] !== undefined && !['number', 'string'].includes(typeof record.details[key])) throw new TypeError(`External details.${key} must be scalar`);
    }
    const safe = sanitizeLogDetails(source.format === 'otel-log-record' ? fromOtelLogRecord(record) : record);
    const details = safe.details && typeof safe.details === 'object' && !Array.isArray(safe.details) ? safe.details : {};
    const normalized = { ...safe, details: { ...details, role: source.role, category: 'extension', visibility: 'diagnostic' } };
    normalized.event = createEventMetadata(normalized, source, { kind: 'imported', format: source.format || 'hdp-jsonl' });
    return normalized;
}

module.exports = { SCHEMA_VERSION, ROLES, EXTENSION_ROLES, FORMATS, createEventMetadata, configuredExtensionSources, normalizeExtensionRecord, fromOtelLogRecord, sanitizeExternalRecord };

/** Validate the dedicated native source before recursive AWS projection; legacy envelopes remain readable. */
function validateNativeRuntimeRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Expected a native object record');
    for (const key of ['timestamp', 'level', 'message', 'id', 'processId']) {
        if (record[key] !== undefined && typeof record[key] !== 'string') throw new TypeError(`Invalid native ${key}`);
    }
    if (record.event?.schemaVersion !== undefined && record.event.schemaVersion !== SCHEMA_VERSION) throw new TypeError('Unsupported native event schema version');
    if (!record.details || typeof record.details !== 'object' || Array.isArray(record.details)) throw new TypeError('Invalid native details');
    if (record.details.type !== undefined && typeof record.details.type !== 'string') throw new TypeError('Invalid native event name');
    const stack = [{ value: record, depth: 0 }];
    while (stack.length) {
        const { value, depth } = stack.pop();
        if (depth > 32) throw new TypeError('Native record nesting exceeds 32 levels');
        if (value && typeof value === 'object') for (const item of Object.values(value)) stack.push({ value: item, depth: depth + 1 });
    }
    return record;
}
module.exports.validateNativeRuntimeRecord = validateNativeRuntimeRecord;
