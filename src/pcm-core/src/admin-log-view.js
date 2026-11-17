'use strict';
/** Bounded reverse reader for the authenticated Admin import diagnostic view. */
const fs = require('fs');
const path = require('path');
const { logGeneration } = require('./log-clear');
const { parseGatewayErrorLine } = require('./gateway-error-log');
const { isGatewaySource, assertSafeExtensionPath, openLogFile } = require('./log-source');
const { normalizeExtensionRecord, createEventMetadata, sanitizeExternalRecord } = require('../../shared/log-event');
const { sanitizeLogDetails, sanitizeLogMessage, AWS_CREDENTIAL_KEYS, knownLogClassification } = require('../../shared/log-policy');

const PAGE_SIZE = 50;
const READ_BUDGET = 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MAX_LINE = 256 * 1024;

/** Resolve only configured component files; cursor data never becomes a path. */
function filesFor(root, components, onError = error => { throw error; }) {
    return components.flatMap(component => {
        const dir = path.join(root, component.dir);
        const historyDir = path.join(dir, 'history');
        let history = [];
        try {
            assertSafeExtensionPath(root, component, historyDir);
            // statSync preserves permission failures; existsSync would silently
            // present an unreadable history directory as an empty source.
            fs.statSync(historyDir);
            history = fs.readdirSync(historyDir, { withFileTypes: true }).filter(item => {
                assertSafeExtensionPath(root, component, path.join(historyDir, item.name));
                return item.isDirectory();
            }).map(item => item.name).sort().slice(-5).reverse().map(name => `history/${name}/app.log`);
        } catch (error) { if (error.code !== 'ENOENT') onError(error, component); }
        return [...(isGatewaySource(component) ? ['error.log'] : []), 'current.log', ...history]
            .map(logFile => ({ component, logFile, filename: path.join(dir, logFile) }))
            .filter(item => {
                try {
                    assertSafeExtensionPath(root, component, item.filename);
                    if (!fs.statSync(item.filename).isFile()) throw new Error('Configured log is not a regular file');
                    return true;
                } catch (error) { if (error.code !== 'ENOENT') onError(error, component); return false; }
            });
    });
}

/** Parse a bounded cursor containing file index and exclusive byte offset. */
function parseCursor(value, files, generation) {
    if (!value) return { file: 0, offset: null };
    try {
        if (typeof value !== 'string' || value.length > 1024) throw new Error('invalid cursor');
        const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(cursor.file) || cursor.file < 0 || cursor.file >= files.length ||
            !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('invalid cursor');
        if (cursor.drop !== undefined && typeof cursor.drop !== 'boolean') throw new Error('invalid cursor');
        const file = files[cursor.file];
        if (cursor.generation !== generation || cursor.name !== `${file.component.dir}/${file.logFile}`
            || cursor.ino !== fs.statSync(file.filename).ino || cursor.size > fs.statSync(file.filename).size) throw new Error('stale cursor');
        return cursor;
    } catch (_) { throw new TypeError('Invalid log page cursor'); }
}

/** Recognize AWS credential keys even when an interrupted JSON record cannot be parsed.
 * Decode escaped JSON property names without attempting to repair the source record.
 * Withhold the whole malformed record when contextual credential fields are present,
 * since a partial schema cannot safely identify the value's closing boundary.
 */
function malformedAwsFields(raw) {
    const names = [];
    for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)) {
        try { names.push(JSON.parse(match[0].slice(0, match[0].lastIndexOf(':')).trim())); }
        catch (_) { /* An invalid property spelling establishes no trusted schema. */ }
    }
    return names.some(name => AWS_CREDENTIAL_KEYS.test(name))
        || names.some(name => /^AccessKeyId$/i.test(name)) && names.some(name => /^SecretAccessKey$/i.test(name)) && names.some(name => /^(?:Token|SessionToken)$/i.test(name))
        || names.some(name => /^authorizationToken$/i.test(name)) && names.some(name => /^(?:proxyEndpoint|authorizationData)$/i.test(name));
}

/** Normalize display metadata; retain source text subject to the mandatory AWS boundary. */
function project(raw, file, lineOffset) {
    let entry;
    let parseError = null;
    let rawRedacted = false;
    try {
        entry = file.logFile === 'error.log'
            ? parseGatewayErrorLine(raw, { id: `${file.component.dir}-${lineOffset}` })
            : JSON.parse(raw);
    } catch (error) { parseError = sanitizeLogMessage(error.message); entry = { message: raw, level: 'UNKNOWN', details: {} }; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        parseError = 'Expected an object log record';
        entry = { message: raw, level: 'UNKNOWN' };
    }
    if (file.component.role === 'hapi') {
        try {
            if (parseError) throw new TypeError('Malformed native JSON');
            require('../../shared/log-event').validateNativeRuntimeRecord(entry);
        } catch (error) {
            parseError = error.message;
            raw = '[Native raw record withheld: invalid shape/depth; AWS safety unavailable]'; rawRedacted = true;
            entry = { level: 'WARN', message: 'Native record could not be normalized: ' + parseError,
                details: { type: 'HAPI_PARSE_ERROR', category: 'system', visibility: 'default' } };
        }
    }
    if (file.component.external) {
        try {
            if (parseError) throw new TypeError('Malformed external JSON');
            const safeRaw = JSON.stringify(sanitizeExternalRecord(entry, file.component));
            rawRedacted = safeRaw !== JSON.stringify(entry);
            if (rawRedacted) raw = safeRaw;
            entry = normalizeExtensionRecord(entry, file.component);
        } catch (error) {
            parseError = error.message;
            raw = '[External raw record withheld: invalid schema or AWS-safety check unavailable]';
            rawRedacted = true;
            entry = { level: 'WARN', message: `External record could not be normalized: ${parseError}`,
                details: { category: 'extension', visibility: 'diagnostic', type: 'EXTERNAL_PARSE_ERROR' } };
        }
    } else {
        if (parseError && malformedAwsFields(raw)) {
            raw = '[Malformed raw record withheld: AWS credential fields cannot be safely projected]';
            entry.message = raw; rawRedacted = true;
            parseError = 'Malformed log record with AWS credential fields';
        }
        const safe = sanitizeLogDetails(entry);
        const structuredChanged = JSON.stringify(safe) !== JSON.stringify(entry);
        const safeRaw = structuredChanged && !parseError ? JSON.stringify(safe) : sanitizeLogMessage(raw);
        rawRedacted = rawRedacted || safeRaw !== raw;
        raw = safeRaw;
        entry = safe;
    }
    if (!entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) entry.details = {};
    entry.event = createEventMetadata(entry, file.component, parseError ? { kind: 'unparsed' } : entry.event?.provenance);
    if (file.component.role === 'hapi') entry.details = { ...entry.details, role: 'hapi', healthOrganizationId: file.component.healthOrganizationId };
    if (['hapi', 'hapi-import'].includes(file.component.role)) Object.assign(entry.details, knownLogClassification(entry, file.component));
    const details = entry.details;
    const target = details.serverId || details.target || details.healthOrganizationId ||
        file.component.healthOrganizationId || (file.component.role === 'pcm' ? 'PCM' : 'unavailable');
    return { ...entry, raw, rawRedacted, ...(parseError ? { parseError } : {}), component: file.component.dir, target,
        operationId: details.operationId || entry.operationId || null,
        correlation: details.operationId || entry.operationId ? 'operation' : 'unavailable',
        stage: details.stage || entry.stage || details.type || 'unavailable',
        logFile: file.logFile, byteOffset: lineOffset };
}

/** Apply exact filter values to structured fields, including independent HO target. */
function matches(entry, filters) {
    if (filters.operationId && entry.operationId !== filters.operationId) return false;
    if (filters.target && entry.target !== filters.target) return false;
    if (filters.component && entry.component !== filters.component) return false;
    if (filters.stage && entry.stage !== filters.stage) return false;
    if (filters.severity && String(entry.level).toUpperCase() !== filters.severity.toUpperCase()) return false;
    const time = Date.parse(entry.timestamp || '');
    if (filters.since && (!Number.isFinite(time) || time < Date.parse(filters.since))) return false;
    if (filters.until && (!Number.isFinite(time) || time > Date.parse(filters.until))) return false;
    return true;
}

/** Read at most 1 MiB and return at most 50 matching rows from newest bytes first.
 * Oversize lines are skipped in this view; the original export retains them.
 */
function readDiagnosticPage(root, components, filters = {}, encodedCursor = '') {
    const failures = [];
    const files = filesFor(root, components, (error, component) => failures.push({ component: component.dir, error: error.message }));
    const cursor = parseCursor(encodedCursor, files, logGeneration(root));
    const entries = [];
    let bytesRead = 0;
    let skippedLongLines = 0;
    for (let index = cursor.file; index < files.length; index++) {
        const file = files[index];
        let fd;
        try { fd = openLogFile(root, file); }
        catch (error) { if (error.code !== 'ENOENT') failures.push({ component: file.component.dir, error: error.message }); continue; }
        try {
            const size = fs.fstatSync(fd).size;
            let offset = index === cursor.file && cursor.offset !== null ? Math.min(cursor.offset, size) : size;
            let carry = Buffer.alloc(0);
            let lineEnd = offset;
            let dropping = index === cursor.file && cursor.drop === true;
            while (offset > 0 && bytesRead < READ_BUDGET) {
                const length = Math.min(CHUNK_SIZE, offset, READ_BUDGET - bytesRead);
                const start = offset - length;
                const chunk = Buffer.allocUnsafe(length);
                const count = fs.readSync(fd, chunk, 0, length, start);
                bytesRead += count;
                offset = start;
                const combined = dropping ? chunk.subarray(0, count) : Buffer.concat([chunk.subarray(0, count), carry]);
                let end = combined.length;
                // A final newline terminates the previous line; it is not an empty record.
                if (!dropping && (lineEnd === size || !carry.length)) {
                    if (end && combined[end - 1] === 10) end--;
                }
                for (let pos = end - 1; pos >= 0; pos--) {
                    if (combined[pos] !== 10) continue;
                    if (dropping) {
                        dropping = false;
                        end = pos;
                        lineEnd = start + pos + 1;
                        continue;
                    }
                    const line = combined.subarray(pos + 1, end);
                    if (line.length > MAX_LINE) skippedLongLines++;
                    else if (line.length) {
                        const entry = project(line.toString('utf8'), file, start + pos + 1);
                        if (matches(entry, filters)) entries.push(entry);
                    }
                    lineEnd = start + pos + 1;
                    end = pos;
                    if (entries.length === PAGE_SIZE) return {
                        entries, bytesRead, skippedLongLines, failures,
                        nextCursor: Buffer.from(JSON.stringify({ file: index, name: `${file.component.dir}/${file.logFile}`, ino: fs.fstatSync(fd).ino, size, generation: logGeneration(root), offset: lineEnd })).toString('base64url')
                    };
                }
                carry = dropping ? Buffer.alloc(0) : combined.subarray(0, end);
                if (carry.length > MAX_LINE) {
                    skippedLongLines++;
                    // Ignore the rest of this one record until its preceding newline.
                    carry = Buffer.alloc(0);
                    dropping = true;
                }
            }
            if (offset === 0 && carry.length) {
                const entry = project(carry.toString('utf8'), file, 0);
                if (matches(entry, filters)) entries.push(entry);
            }
            if (bytesRead >= READ_BUDGET) return { entries, bytesRead, skippedLongLines, failures,
                nextCursor: Buffer.from(JSON.stringify({ file: index, name: `${file.component.dir}/${file.logFile}`, ino: fs.fstatSync(fd).ino, size, generation: logGeneration(root),
                    offset: dropping ? offset : lineEnd, ...(dropping ? { drop: true } : {}) })).toString('base64url') };
        } finally { fs.closeSync(fd); }
    }
    return { entries, bytesRead, skippedLongLines, failures, nextCursor: null };
}

module.exports = { filesFor, project, readDiagnosticPage, PAGE_SIZE, READ_BUDGET, MAX_LINE };
