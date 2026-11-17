'use strict';
/** Authenticated full-history projection with explicit per-source completeness. */
const { readComponentLogRecords } = require('./log-reader');
const { sanitizeLogMessage } = require('../../shared/log-policy');

/** Read every configured source independently; a failed source is omitted, never
 * represented by an empty successful stream. No reads bypass source path safety.
 * @param {string} root Configured team log root.
 * @param {object[]} sources Validated source inventory.
 * @returns {object} Legacy logs map plus explicit status and failed source IDs.
 */
function readLogExport(root, sources) {
    const logs = {};
    const failures = [];
    for (const source of sources) {
        try {
            logs[source.dir] = readComponentLogRecords(root, source.dir, source.dir, { allHistory: true, source })
                .map(({ parsed, raw, logFile, componentLine }) => ({ ...(parsed || { raw }), logFile, componentLine }));
        } catch (error) {
            failures.push({ component: source.dir, error: sanitizeLogMessage(error.message) });
        }
    }
    return { logs, status: failures.length ? 'partial' : 'complete', complete: failures.length === 0, failures };
}

module.exports = { readLogExport };

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream/promises');
const { isGatewaySource, assertSafeExtensionPath, openLogFile } = require('./log-source');
const { parseGatewayErrorLine } = require('./gateway-error-log');
const { project } = require('./admin-log-view');
const { sanitizeLogDetails } = require('../../shared/log-policy');
const { logGeneration } = require('./log-clear');
const CHUNK_BYTES = 64 * 1024;

/** Capture file identities and byte boundaries before yielding to a log writer.
 * Missing files remain empty; any rejected/unreadable file fails its source.
 */
function snapshotSource(root, source) {
    const stat = filename => {
        try {
            assertSafeExtensionPath(root, source, filename);
            return fs.statSync(filename);
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const directory = path.join(root, source.dir);
    const historyDir = path.join(directory, 'history');
    const history = stat(historyDir) ? fs.readdirSync(historyDir, { withFileTypes: true })
        .filter(item => {
            assertSafeExtensionPath(root, source, path.join(historyDir, item.name));
            return item.isDirectory();
        }).map(item => item.name).sort().map(name => `history/${name}/app.log`) : [];
    return [...history, 'current.log', ...(isGatewaySource(source) ? ['error.log'] : [])].flatMap(logFile => {
        const filename = path.join(directory, logFile), info = stat(filename);
        if (!info) return [];
        if (!info.isFile()) throw new Error('Configured log is not a regular file');
        return [{ component: source, filename, logFile, size: info.size, dev: info.dev, ino: info.ino }];
    });
}

/** Match the legacy export projection without building unused Admin-view metadata.
 * External records still use the exact fail-closed normalization/raw safety path.
 */
function exportRecord(raw, source, logFile, componentLine) {
    let parsed;
    if (source.external || source.role === 'hapi') {
        parsed = project(raw, { component: source, logFile }, componentLine);
    } else {
        try {
            parsed = logFile === 'error.log'
                ? parseGatewayErrorLine(raw, { id: `${source.dir}-${logFile}-${componentLine}` })
                : JSON.parse(raw);
        } catch (_) { /* Preserve malformed built-in raw lines with AWS scrubbing. */ }
        parsed = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? sanitizeLogDetails(parsed) : { raw: sanitizeLogMessage(raw) };
    }
    return { ...parsed, logFile, componentLine };
}

/** Iterate one snapshotted file using bounded UTF-8 reads; never follow replacements.
 * The only unbounded item is a single record, as required for raw export fidelity.
 */
async function* snapshotLines(root, file, signal, metrics) {
    signal?.throwIfAborted();
    const fd = openLogFile(root, file);
    try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== file.dev || opened.ino !== file.ino || opened.size < file.size) {
            throw new Error('Log changed during export; retry for a fresh snapshot');
        }
        const decoder = new StringDecoder('utf8'), buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let position = 0, pending = '', leading = true;
        while (position < file.size) {
            signal?.throwIfAborted();
            const started = metrics ? performance.now() : 0;
            // Resolve read at call time so deterministic tests can simulate I/O failure.
            const { bytesRead } = await promisify(fs.read)(fd, buffer, 0, Math.min(buffer.length, file.size - position), position);
            if (metrics) { metrics.readMs += performance.now() - started; metrics.inputBytes += bytesRead; }
            if (!bytesRead) throw new Error('Log was truncated during export; retry for a fresh snapshot');
            position += bytesRead;
            pending += decoder.write(buffer.subarray(0, bytesRead));
            if (leading) { pending = pending.trimStart(); leading = !pending; }
            let newline;
            while ((newline = pending.indexOf('\n')) !== -1) {
                const raw = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                if (raw) yield raw;
            }
        }
        pending += decoder.end();
        if (leading) pending = pending.trimStart();
        if (pending) yield pending;
        if (fs.fstatSync(fd).size < file.size) throw new Error('Log was truncated during export; retry for a fresh snapshot');
    } finally { fs.closeSync(fd); }
}

/** Buffered positional writer supports source rollback without holding a history in RAM. */
function stagedWriter(handle, signal, metrics) {
    let offset = 0, chunks = [], buffered = 0;
    return {
        get position() { return offset + buffered; },
        async flush() {
            signal?.throwIfAborted();
            if (!buffered) return;
            const data = Buffer.from(chunks.join(''));
            chunks = []; buffered = 0;
            let written = 0;
            const started = metrics ? performance.now() : 0;
            while (written < data.length) {
                signal?.throwIfAborted();
                const result = await handle.write(data, written, data.length - written, offset).catch(error => {
                    error.exportStagingFailure = true; throw error;
                });
                if (!result.bytesWritten) throw Object.assign(new Error('Could not stage log export'), { exportStagingFailure: true });
                offset += result.bytesWritten; written += result.bytesWritten;
            }
            if (metrics) metrics.writeMs += performance.now() - started;
        },
        async append(text) {
            chunks.push(text); buffered += Buffer.byteLength(text);
            if (buffered >= CHUNK_BYTES) await this.flush();
        },
        async rollback(position) {
            // Flush preserved prefixes before rollback; the checkpoint may still
            // be inside the current buffer (including earlier healthy sources).
            await this.flush();
            await handle.truncate(position).catch(error => { error.exportStagingFailure = true; throw error; });
            offset = position;
        }
    };
}

/** Prepare an authenticated export with bounded RAM, cancellable asynchronous I/O,
 * private staging and exact legacy JSON/200/207 semantics. Reading every source
 * before headers is necessary to honestly choose 207 and omit a late failed source.
 * The caller must invoke cleanup after transfer, failure or cancellation.
 * @param {string} root Configured log root.
 * @param {object[]} sources Validated source inventory.
 * @param {object} options Optional abort signal, private temporary parent and metrics.
 * @returns {Promise<object>} Staged filename, byte length, verdict and cleanup function.
 */
async function prepareLogExport(root, sources, { signal, tempRoot = os.tmpdir(), metrics } = {}) {
    signal?.throwIfAborted();
    if (metrics) Object.assign(metrics, { readMs: 0, projectSerializeMs: 0, writeMs: 0, inputBytes: 0, records: 0 });
    const generation = logGeneration(root);
    const snapshots = sources.map(source => {
        try { return { source, files: snapshotSource(root, source) }; }
        catch (error) { return { source, error }; }
    });
    const directory = await fs.promises.mkdtemp(path.join(tempRoot, 'pcm-log-export-'));
    const filename = path.join(directory, 'export.json');
    const cleanup = () => fs.promises.rm(directory, { recursive: true, force: true });
    let handle;
    try {
        handle = await fs.promises.open(filename, 'wx', 0o600);
        const writer = stagedWriter(handle, signal, metrics), failures = [];
        await writer.append('{"logs":{');
        let successfulSources = 0;
        for (const snapshot of snapshots) {
            signal?.throwIfAborted();
            const sourceStart = writer.position;
            try {
                if (snapshot.error) throw snapshot.error;
                if (logGeneration(root) !== generation) throw new Error('Logs were cleared during export; retry for a fresh snapshot');
                await writer.append(`${successfulSources ? ',' : ''}${JSON.stringify(snapshot.source.dir)}:[`);
                let count = 0;
                const appendRecord = async (raw, file, componentLine) => {
                    const started = metrics ? performance.now() : 0;
                    const text = JSON.stringify(exportRecord(raw, snapshot.source, file.logFile, componentLine));
                    if (metrics) metrics.projectSerializeMs += performance.now() - started;
                    await writer.append(`${count++ ? ',' : ''}${text}`);
                };
                for (const file of snapshot.files) {
                    let componentLine = 0, lastContent;
                    for await (const raw of snapshotLines(root, file, signal, metrics)) {
                        signal?.throwIfAborted();
                        componentLine++;
                        if (raw.trim()) lastContent = { position: writer.position, count, raw, componentLine };
                        await appendRecord(raw, file, componentLine);
                        if (metrics) metrics.records++;
                    }
                    // Legacy reader trims the whole file. Roll back only its final
                    // nonblank record and trailing whitespace records, then trimEnd.
                    // Interior whitespace and nonempty-line coordinates stay exact.
                    if (lastContent) {
                        await writer.flush();
                        await writer.rollback(lastContent.position);
                        count = lastContent.count;
                        await appendRecord(lastContent.raw.trimEnd(), file, lastContent.componentLine);
                    }
                }
                if (logGeneration(root) !== generation) throw new Error('Logs were cleared during export; retry for a fresh snapshot');
                await writer.append(']');
                successfulSources++;
            } catch (error) {
                signal?.throwIfAborted();
                if (error.exportStagingFailure) throw error;
                await writer.rollback(sourceStart);
                failures.push({ component: snapshot.source.dir, error: sanitizeLogMessage(error.message) });
            }
        }
        const result = { status: failures.length ? 'partial' : 'complete', complete: failures.length === 0, failures };
        await writer.append(`},${JSON.stringify(result).slice(1)}`);
        await writer.flush();
        await handle.close(); handle = null;
        // A clear invalidates the whole preparation, including sources staged
        // before that clear and the final asynchronous flush/close window.
        if (logGeneration(root) !== generation) {
            throw Object.assign(new Error('Logs were cleared during export; retry for a fresh snapshot'), { code: 'LOG_EXPORT_CHANGED' });
        }
        return { filename, size: writer.position, ...result, cleanup };
    } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await cleanup();
        throw error;
    }
}

/** Transfer with socket backpressure; cancellation stops preparation and removes staging. */
async function sendLogExport(req, res, root, sources, options = {}) {
    const controller = new AbortController();
    const abort = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    let prepared;
    try {
        prepared = await prepareLogExport(root, sources, { ...options, signal: controller.signal });
        controller.signal.throwIfAborted();
        res.status(prepared.complete ? 200 : 207).type('json');
        res.set('Content-Length', String(prepared.size));
        await pipeline(fs.createReadStream(prepared.filename), res, { signal: controller.signal });
    } catch (error) {
        if (!controller.signal.aborted && !res.headersSent && !res.destroyed) {
            res.status(error.code === 'LOG_EXPORT_CHANGED' ? 409 : 500).json({ error: sanitizeLogMessage(error.message) });
        }
    } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abort);
        if (prepared) await prepared.cleanup();
    }
}

module.exports.prepareLogExport = prepareLogExport;
module.exports.sendLogExport = sendLogExport;
