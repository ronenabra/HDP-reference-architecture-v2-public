'use strict';
/** Snapshot byte paging for unified diagnostics. Paths come only from configured inventory. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { filesFor, project } = require('./admin-log-view');
const { logGeneration } = require('./log-clear');
const { orderUnifiedLogs } = require('./log-ordering');
const { createEventMetadata } = require('../../shared/log-event');
const { openLogFile } = require('./log-source');
const { isCriticalDiagnostic } = require('../../shared/log-policy');
const ROW_LIMIT = 200;
const READ_BUDGET = 1024 * 1024;
const MAX_LINE = 256 * 1024;
const CHUNK = 8192;
const MAX_CURSOR_STATE = 128 * 1024;

/** Decode bounded untrusted state; callers validate every coordinate against inventory. */
function decode(value) {
    try {
        if (typeof value !== 'string' || value.length > 32000) throw new Error();
        const bytes = value.startsWith('z1.')
            ? zlib.inflateRawSync(Buffer.from(value.slice(3), 'base64url'), { maxOutputLength: MAX_CURSOR_STATE })
            : Buffer.from(value, 'base64url');
        return JSON.parse(bytes.toString('utf8'));
    } catch (_) { throw new TypeError('Invalid log cursor'); }
}
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
/** Compress repeated file coordinates so maximum configured inventory fits ordinary HTTP request lines. */
function encodeCursor(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_CURSOR_STATE) throw new TypeError('Configured log cursor inventory exceeds its bound');
    const result = `z1.${zlib.deflateRawSync(bytes, { level: 1 }).toString('base64url')}`;
    if (result.length > 32000) throw new TypeError('Configured log cursor exceeds its encoded bound');
    return result;
}
const fingerprint = filters => crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex');

/** Yield bounded reverse lines, preserving byte offsets, including across oversized records. */
function* reverseLines(fd, state, budget) {
    let offset = state.offset;
    let carry = Buffer.alloc(0);
    let end = offset;
    let dropping = Boolean(state.drop);
    while (offset > 0 && budget.bytes < READ_BUDGET) {
        const length = Math.min(CHUNK, offset, READ_BUDGET - budget.bytes);
        const start = offset - length;
        const chunk = Buffer.allocUnsafe(length);
        const readStarted = performance.now();
        const count = fs.readSync(fd, chunk, 0, length, start);
        budget.readMilliseconds += performance.now() - readStarted;
        if (!count) break;
        budget.bytes += count;
        offset = start;
        const data = dropping ? chunk.subarray(0, count) : Buffer.concat([chunk.subarray(0, count), carry]);
        let right = data.length;
        for (let index = data.length - 1; index >= 0; index--) {
            if (data[index] !== 10) continue;
            if (dropping) {
                dropping = false;
                budget.oversized++;
            } else if (right > index + 1) {
                const raw = data.subarray(index + 1, right);
                if (raw.length <= MAX_LINE) yield { raw: raw.toString('utf8'), start: start + index + 1, end };
                else budget.oversized++;
            }
            right = index;
            end = start + index;
            state.offset = end;
            state.drop = false;
        }
        carry = dropping ? Buffer.alloc(0) : data.subarray(0, right);
        if (carry.length > MAX_LINE) { carry = Buffer.alloc(0); dropping = true; }
    }
    if (offset === 0 && carry.length && !dropping) {
        yield { raw: carry.toString('utf8'), start: 0, end };
        state.offset = 0;
    } else if (offset === 0) {
        if (dropping) budget.oversized++;
        state.offset = 0;
        state.drop = false;
    } else {
        // Carry is a partial line. Re-read it next page; dropping advances long lines.
        state.offset = dropping ? offset : end;
        state.drop = dropping;
    }
}

/** Yield forward lines within the original snapshot, retaining bounded partial-line state.
 * New appends beyond state.size never enter a newer-direction continuation.
 * @param {number} fd Validated open source descriptor.
 * @param {object} state Snapshot size, mutable byte offset and oversized-line flag.
 * @param {object} budget Shared read-byte, timing and skipped-line counters.
 * @yields {object} Bounded raw UTF-8 line with start and exclusive-end byte coordinates.
 */
function* forwardLines(fd, state, budget) {
    let position = state.offset;
    let start = position;
    let carry = Buffer.alloc(0);
    let dropping = state.drop;
    while (position < state.size && budget.bytes < READ_BUDGET) {
        const length = Math.min(CHUNK, state.size - position, READ_BUDGET - budget.bytes);
        const chunk = Buffer.allocUnsafe(length);
        const readStarted = performance.now();
        const count = fs.readSync(fd, chunk, 0, length, position);
        budget.readMilliseconds += performance.now() - readStarted;
        if (!count) break;
        budget.bytes += count;
        let left = 0;
        for (let index = 0; index < count; index++) {
            if (chunk[index] !== 10) continue;
            const end = position + index;
            if (dropping) { budget.oversized++; dropping = false; }
            else {
                const raw = Buffer.concat([carry, chunk.subarray(left, index)]);
                if (raw.length > MAX_LINE) budget.oversized++;
                else if (raw.length) yield { raw: raw.toString('utf8'), start, end };
            }
            carry = Buffer.alloc(0);
            left = index + 1;
            start = end + 1;
            state.offset = start; state.drop = false;
        }
        if (!dropping) {
            carry = Buffer.concat([carry, chunk.subarray(left, count)]);
            if (carry.length > MAX_LINE) { carry = Buffer.alloc(0); dropping = true; }
        }
        position += count;
    }
    if (position === state.size) {
        if (dropping) budget.oversized++;
        else if (carry.length) yield { raw: carry.toString('utf8'), start, end: position };
        state.offset = position; state.drop = false;
    } else {
        state.offset = dropping ? position : start;
        state.drop = dropping;
    }
}

/** Match the same exact role, HO, visibility and operation filters as the full export. */
function matches(entry, filters) {
    if (filters.visibility !== 'all' && entry.details?.visibility === 'hidden') return false;
    if (filters.diagnostics !== 'true' && entry.details?.visibility === 'diagnostic') return false;
    for (const field of ['role', 'healthOrganizationId', 'level', 'method', 'correlationId', 'flowId', 'traceId']) {
        if (filters[field] && String(field === 'level' ? entry.level : (entry.details?.[field] ?? entry.event?.correlation?.[field])) !== String(filters[field])) return false;
    }
    // Administrative identity exists only when explicitly recorded, never from String(undefined).
    for (const field of ['operationId', 'sourceId']) {
        const recorded = entry.details?.[field] || (field === 'operationId' ? entry.operationId : undefined);
        if (filters[field] && (typeof recorded !== 'string' || recorded !== filters[field])) return false;
    }
    if (filters.path && String(entry.details?.url || entry.details?.path || '').split('?')[0] !== String(filters.path)) return false;
    if (filters.status && String(entry.details?.statusCode ?? entry.details?.status ?? '') !== String(filters.status)) return false;
    return true;
}

/** Keep list payloads bounded; full details are fetched only when an entry is selected. */
function summarize(entry, reference) {
    const details = {};
    for (const key of ['type', 'category', 'visibility', 'causesSystemFlow', 'role', 'healthOrganizationId',
        'method', 'url', 'originalUrl', 'status', 'statusCode', 'requestId', 'correlationId', 'flowId',
        'reasonCode', 'budgetReasonCode', 'budgetFailureStage', 'outcome', 'stage', 'nativeLogger', 'nativeThread', 'durationMs', 'completionObserved', 'abortObserved', 'operationId', 'sourceId', 'operation', 'active', 'business_id', 'logical_id', 'classification', 'traceId', 'spanId', 'parentSpanId', 'traceFlags', 'correlationMethod']) {
        const value = entry.details?.[key];
        if (['string', 'number', 'boolean'].includes(typeof value)) details[key] = typeof value === 'string' ? value.slice(0, 512) : value;
    }
    // Only the trusted measuring source's finite, numeric emitted cause enters bounded summaries.
    const budget = entry.details?.budgetFailure;
    const units = { maxAllocatedBytes: 'bytes', timeoutMilliseconds: 'milliseconds', maxConcurrentQueries: 'active queries',
        maxPageIdVisits: 'visits', maxPageBodyVisits: 'visits', maxPageRefills: 'refills', maxPageIncludes: 'entries',
        maxPagePayloadBytes: 'bytes', maxCountCandidates: 'candidates', maxCountNativeIdVisits: 'visits', maxQueryUriCharacters: 'characters',
        maxPrivateAuthorizationBytes: 'bytes' };
    if ((details.reasonCode === 'QUERY_BUDGET_EXCEEDED' || details.budgetReasonCode === 'QUERY_BUDGET_EXCEEDED')
        && budget && typeof budget === 'object'
        && (entry.event?.source?.role === 'hapi' && budget.setting !== 'maxPrivateAuthorizationBytes'
            || entry.event?.source?.role === 'adapter' && budget.setting === 'maxPrivateAuthorizationBytes') && Object.keys(budget).length === 4
        && Object.hasOwn(units, budget.setting) && budget.unit === units[budget.setting]
        && Number.isSafeInteger(budget.threshold) && budget.threshold > 0
        && Number.isSafeInteger(budget.observed) && budget.observed >= 0) details.budgetFailure = { ...budget };
    // Native receipts retain exact queries in selected/raw/export only, never ordinary summary URLs.
    if (entry.event?.source?.role === 'hapi') {
        for (const key of ['url', 'originalUrl']) if (typeof details[key] === 'string') details[key] = details[key].split(/[?#]/, 1)[0];
    }
    return { id: entry.id, timestamp: String(entry.timestamp || '').slice(0, 80),
        tick: String(entry.tick || '').slice(0, 32), componentLine: entry.componentLine,
        logFile: entry.logFile, component: entry.component, level: String(entry.level || 'UNKNOWN').slice(0, 32),
        message: String(entry.message || '').slice(0, 512), details, reference, event: entry.event,
        ...(entry.parseError ? { parseError: entry.parseError } : {}) };
}

/** Validate an exact registered source before opening files; producer metadata is not authority.
 * @param {object[]} components Trusted configured stream registry.
 * @param {string} source Optional exact component ID, never a filesystem path.
 * @returns {void} Throws for unknown or malformed source IDs.
 */
function validateSource(components, source) {
    if (source === undefined || source === '') return;
    if (typeof source !== 'string' || source.length > 256 || !components.some(component => component.dir === source)) {
        throw new TypeError('Unknown or invalid configured log source ID');
    }
}

/** Read an adjacent older/newer snapshot page using established within-page ordering.
 * @param {string} root Configured team log directory.
 * @param {object[]} components Validated stream inventory (paths are never taken from cursors).
 * @param {object} filters Exact role, HO, visibility, operation and ordering choices.
 * @param {string} cursor Opaque older/newer continuation or live checkpoint; empty starts a snapshot.
 * @param {Function} normalize Existing classification/gateway expansion projection.
 * @returns {object} Bounded summaries, adjacent/checkpoint/resume cursors, timings and source failures.
 */
function readUnifiedPage(root, components, filters = {}, cursor = '', normalize = entry => [entry]) {
    const started = performance.now();
    const failures = [];
    validateSource(components, filters.source);
    const selectedComponents = components.filter(component => (!filters.source || component.dir === filters.source)
        && (!filters.role || component.role === filters.role)
        && (!filters.healthOrganizationId || component.healthOrganizationId === filters.healthOrganizationId));
    const files = filesFor(root, selectedComponents, (error, component) => failures.push({ component: component.dir, error: error.message }));
    const key = fingerprint({ ...filters, generation: logGeneration(root) });
    const saved = cursor ? decode(cursor) : null;
    if (saved && (saved.key !== key || !Array.isArray(saved.files))) throw new TypeError('Log cursor filters changed');
    if (saved?.direction && !['older', 'newer', 'live'].includes(saved.direction)) throw new TypeError('Invalid log cursor direction');
    const live = saved?.direction === 'live';
    const newer = live || saved?.direction === 'newer';
    if (saved && saved.files.some(state => !files.some(file => `${file.component.dir}/${file.logFile}` === state.name))) throw new Error('Logs rotated or cleared; return to Latest');
    const budget = { bytes: 0, oversized: 0, readMilliseconds: 0, parseMilliseconds: 0 };
    const runtimeHealth = new Map(selectedComponents.filter(component => component.role === 'hapi')
        .map(component => [component.dir, require('./log-source').readRuntimeHealth(root, component, budget)]));
    const streams = [];
    const entries = [];
    let criticalDiagnostic = null;
    try {
        for (const file of files) {
            let fd;
            try {
                fd = openLogFile(root, file);
                const stat = fs.fstatSync(fd);
                const name = `${file.component.dir}/${file.logFile}`;
                const previous = saved?.files.find(item => item.name === name);
                if (saved && !previous && !live) { fs.closeSync(fd); continue; } // Fixed snapshots exclude new writers.
                if (previous && (previous.ino !== stat.ino || previous.size > stat.size)) throw new Error('Logs changed or cleared; return to Latest');
                const state = previous ? { ...previous } : { name, ino: stat.ino, size: stat.size, offset: live ? 0 : stat.size, drop: false };
                if (!Number.isSafeInteger(state.size) || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > state.size || typeof state.drop !== 'boolean') throw new TypeError('Invalid log cursor offset');
                if (live) {
                    // Capture one finite target. Continuations below remain fixed
                    // even if more events arrive while this interval is drained.
                    state.size = stat.size;
                    if (previous && state.offset > 0 && state.offset < state.size && !state.drop) {
                        const boundary = Buffer.alloc(2);
                        const boundaryStarted = performance.now();
                        const read = fs.readSync(fd, boundary, 0, 2, state.offset - 1);
                        budget.readMilliseconds += performance.now() - boundaryStarted; budget.bytes += read;
                        if (read !== 2) throw new Error('Logs changed while checking catch-up continuity');
                        if (boundary[0] !== 10 && boundary[1] !== 10) throw new Error('Cannot prove log continuity: an existing unterminated record was extended. Reload to start a fresh snapshot.');
                    }
                }
                streams.push({ file, fd, initial: { ...state }, state,
                    iterator: (newer ? forwardLines : reverseLines)(fd, state, budget), head: null });
            } catch (error) {
                if (fd !== undefined) fs.closeSync(fd);
                if (saved || error instanceof TypeError) throw error;
                failures.push({ component: file.component.dir, error: error.message });
            }
        }
        /** Advance one stream to its next matching record without unbounded sparse scanning. */
        function advance(stream) {
            stream.head = null;
            let step;
            while (!(step = stream.iterator.next()).done) {
                const line = step.value;
                const parseStarted = performance.now();
                const raw = project(line.raw, stream.file, line.start);
                const projected = { ...raw, id: `${stream.file.component.dir}-${stream.state.ino}-${line.start}`,
                    component: stream.file.component.label, componentLine: line.start,
                    details: { ...raw.details, role: stream.file.component.role, healthOrganizationId: stream.file.component.healthOrganizationId } };
                const normalized = normalize(projected).map(entry => ({ ...entry,
                    event: createEventMetadata(entry, stream.file.component, entry.event?.provenance)
                }));
                // Observe only records already parsed under this page's byte budget.
                // One compact target consolidates repeats and never retains hidden payloads.
                const critical = normalized.find(isCriticalDiagnostic);
                if (critical && (!criticalDiagnostic || Date.parse(critical.timestamp) > Date.parse(criticalDiagnostic.timestamp))) criticalDiagnostic = summarize(critical, encode({
                    generation: logGeneration(root), name: stream.state.name, ino: stream.state.ino,
                    start: line.start, end: line.end, variant: 'source',
                    digest: crypto.createHash('sha256').update(line.raw).digest('hex')
                }));
                const matching = normalized.filter(entry => matches(entry, filters));
                budget.parseMilliseconds += performance.now() - parseStarted;
                if (matching.length) {
                    stream.head = { line, entries: matching };
                    return;
                }
                stream.state.offset = newer ? Math.min(line.end + 1, stream.state.size) : line.start;
            }
        }
        streams.forEach(advance);
        while (entries.length < ROW_LIMIT) {
            const available = streams.filter(stream => stream.head);
            if (!available.length) break;
            available.sort((a, b) => (newer ? -1 : 1) * ((Math.max(...b.head.entries.map(entry => Date.parse(entry.timestamp) || 0)))
                - Math.max(...a.head.entries.map(entry => Date.parse(entry.timestamp) || 0)))
                || a.state.name.localeCompare(b.state.name));
            const stream = available[0];
            if (entries.length + stream.head.entries.length > ROW_LIMIT) break;
            const { line } = stream.head;
            entries.push(...stream.head.entries.map(entry => summarize(entry, encode({
                generation: logGeneration(root), name: stream.state.name, ino: stream.state.ino,
                start: line.start, end: line.end, variant: entry.event?.provenance?.kind === 'derived' && entry.details?.type === 'GATEWAY_REQUEST' ? 'GATEWAY_REQUEST' : 'source',
                digest: crypto.createHash('sha256').update(line.raw).digest('hex')
            }))));
            stream.state.offset = newer ? Math.min(line.end + 1, stream.state.size) : line.start;
            advance(stream);
        }
        // Unconsumed prefetched heads must be revisited on the next page.
        for (const stream of streams) if (stream.head) { stream.state.offset = newer ? stream.head.line.start : stream.head.line.end; stream.state.drop = false; }
        const states = streams.map(stream => stream.state);
        const initial = streams.map(stream => stream.initial);
        const upper = newer ? states : initial;
        const lower = newer ? initial : states;
        const orderStarted = performance.now();
        const ordered = orderUnifiedLogs(entries, filters.order, filters.tail);
        const timings = { readMilliseconds: budget.readMilliseconds, parseMilliseconds: budget.parseMilliseconds,
            orderMilliseconds: performance.now() - orderStarted, totalMilliseconds: performance.now() - started };
        const hasOlder = lower.some(state => state.offset > 0);
        const hasNewer = upper.some(state => state.offset < state.size);
        const reasons = [
            ...(hasOlder ? ['older-records'] : []), ...(hasNewer ? ['newer-records'] : []), ...(saved ? ['older-page'] : []),
            ...(budget.bytes >= READ_BUDGET ? ['read-budget'] : []),
            ...([...runtimeHealth.values()].some(value => value.state !== 'available' || value.dropped > 0) ? ['native-diagnostics-gaps'] : []),
            ...(budget.oversized ? ['oversized-records'] : []), ...(failures.length ? ['unreadable-streams'] : []),
            ...(['source', 'role', 'healthOrganizationId', 'level', 'method', 'correlationId', 'flowId', 'traceId', 'operationId', 'sourceId', 'path', 'status'].some(key => filters[key])
                || filters.diagnostics !== 'true' || filters.visibility !== 'all' ? ['filtered-view'] : [])
        ];
        return { entries: ordered, criticalDiagnostic, timings, bytesRead: budget.bytes,
            coverage: { scope: 'page', state: reasons.length ? 'partial' : 'bounded', reasons,
                rowLimit: ROW_LIMIT, readBudgetBytes: READ_BUDGET,
                note: 'Only observed events in this byte page are grouped. A page never proves an end-to-end journey is complete.' },
            sources: selectedComponents.map(component => ({ componentId: component.dir, label: component.label,
                role: component.role, healthOrganizationId: component.healthOrganizationId,
                coverage: component.coverage || (component.role === 'hapi-import' ? 'import-only' : 'protocol'),
                ...(runtimeHealth.has(component.dir) ? { runtimeHealth: runtimeHealth.get(component.dir) } : {}),
                state: failures.some(item => item.component === component.dir) ? 'error'
                    : files.some(file => file.component.dir === component.dir) ? 'available' : 'missing' })),
            skippedLongLines: budget.oversized, failures, rowLimit: ROW_LIMIT,
            nextCursor: hasOlder ? encodeCursor({ key, direction: 'older', files: lower }) : null,
            previousCursor: hasNewer ? encodeCursor({ key, direction: 'newer', files: upper }) : null,
            liveCursor: encodeCursor({ key, direction: 'live', files: upper }),
            resumeCursor: encodeCursor({ key, direction: 'older', files: upper }) };
    } finally { streams.forEach(stream => fs.closeSync(stream.fd)); }
}

/** Fetch one selected raw record from configured inventory.
 * @param {string} root Configured log root.
 * @param {object[]} components Validated component inventory.
 * @param {string} reference Byte coordinates returned in a bounded summary.
 * @returns {object} Full raw/structured diagnostic record; stale coordinates throw.
 */
function readUnifiedDetail(root, components, reference, normalize = entry => [entry]) {
    const value = decode(reference);
    if (!value || value.generation !== logGeneration(root) || typeof value.name !== 'string'
        || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0
        || value.end <= value.start || value.end - value.start > MAX_LINE) throw new TypeError('Invalid log record reference');
    // Match a registered source before touching the filesystem. An unrelated rejected
    // stream must not prevent investigation of a healthy source; the selected source
    // still goes through the ordinary inventory and safe-open checks.
    const source = components.find(component => value.name.startsWith(`${component.dir}/`));
    const file = source && filesFor(root, [source]).find(item => `${item.component.dir}/${item.logFile}` === value.name);
    if (!file) throw new TypeError('Invalid log record reference');
    const fd = openLogFile(root, file);
    try {
        const stat = fs.fstatSync(fd);
        if (stat.ino !== value.ino || stat.size < value.end) throw new Error('Selected log changed or cleared');
        const data = Buffer.alloc(value.end - value.start);
        fs.readSync(fd, data, 0, data.length, value.start);
        const raw = data.toString('utf8');
        if (value.digest && crypto.createHash('sha256').update(raw).digest('hex') !== value.digest) throw new Error('Selected log changed; return to Latest');
        const projected = project(raw, file, value.start);
        const base = { ...projected, id: `${file.component.dir}-${value.ino}-${value.start}`,
            component: file.component.label, componentLine: value.start,
            details: { ...projected.details, role: file.component.role, healthOrganizationId: file.component.healthOrganizationId } };
        const candidates = normalize(base);
        const selected = value.variant === 'source' || !value.variant
            ? candidates.find(entry => entry.event?.provenance?.kind !== 'derived') || candidates[0]
            : candidates.find(entry => entry.details?.type === value.variant);
        if (!selected) throw new TypeError('Selected log projection is unavailable');
        selected.event = createEventMetadata(selected, file.component, selected.event?.provenance);
        return { ...selected, entry: selected, raw: projected.raw, rawRedacted: projected.rawRedacted,
            source: { componentId: file.component.dir, logFile: file.logFile, byteOffset: value.start },
            provenance: selected.event.provenance };
    } finally { fs.closeSync(fd); }
}

module.exports = { validateSource, readUnifiedPage, readUnifiedDetail, reverseLines, matches, summarize,
    ROW_LIMIT, READ_BUDGET, MAX_LINE, MAX_CURSOR_STATE };
