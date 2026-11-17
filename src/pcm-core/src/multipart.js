'use strict';

/** Bounded Admin multipart uploads, preserving bundle bytes and HTTP errors. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatByteLimit } = require('../../shared/clinical-import-limits');

/** Capture an upload in memory or on disk; drain rejected bodies so 413 reaches the client. */
function captureMultipartBody(req, res, next, limit) {
    if (!/^multipart\/form-data/i.test(req.get('content-type') || '')) return next();
    const streamed = req.method === 'POST' && /^\/api\/fhir-servers\/[^/]+\/imports$/.test(req.path || '');
    let bytes = 0;
    let stopped = false;
    let tempDir;
    let output;
    const chunks = [];
    const cleanup = () => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); };
    /** Stop collection without destroying the HTTP socket carrying the error response. */
    const stop = error => {
        if (stopped) return;
        stopped = true;
        if (output) { req.unpipe(output); output.destroy(); }
        cleanup();
        req.resume();
        if (error) next(error);
        else res.status(413).json({ error: `multipart upload exceeds ${formatByteLimit(limit)}; choose a smaller bundle or increase this team's clinicalData.limits.maxBytes` });
    };
    req.on('error', stop);
    req.on('aborted', () => stop(new Error('multipart upload was aborted')));
    if (Number(req.get('content-length')) > limit) { stop(); return; }
    if (streamed) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-clinical-upload-'));
        const rawBodyPath = path.join(tempDir, 'multipart.body');
        output = fs.createWriteStream(rawBodyPath, { flags: 'wx', mode: 0o600 });
        output.on('error', stop);
        output.on('close', () => { if (stopped) cleanup(); });
        output.on('finish', () => {
            if (stopped) return;
            req.rawBodyPath = rawBodyPath;
            req.rawBodyCleanup = cleanup;
            req.rawMultipartWasStreamed = true;
            next();
        });
    }
    req.on('data', chunk => {
        if (stopped) return;
        bytes += chunk.length;
        if (bytes > limit) { stop(); return; }
        if (!streamed) chunks.push(chunk);
    });
    if (streamed) req.pipe(output);
    else req.on('end', () => {
        if (stopped) return;
        req.rawBody = Buffer.concat(chunks);
        next();
    });
}

/** Parse fields and files from byte boundaries without converting a whole bundle to a string. */
function parseMultipartForm(req) {
    const contentType = req.get('content-type') || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = match?.[1] || match?.[2];
    const body = req.rawBody || (req.rawBodyPath ? fs.readFileSync(req.rawBodyPath) : null);
    const result = { fields: {}, files: {} };
    if (!boundary || !body) return result;
    const marker = Buffer.from(`--${boundary}`);
    const separator = Buffer.from('\r\n\r\n');
    const delimiter = Buffer.from(`\r\n--${boundary}`);
    /** Boundary-like text inside a file is data unless followed by a legal delimiter suffix. */
    const nextBoundary = offset => {
        let found = body.indexOf(delimiter, offset);
        while (found !== -1) {
            const suffix = body.subarray(found + delimiter.length, found + delimiter.length + 2).toString('ascii');
            if (suffix === '--' || suffix === '\r\n') return found;
            found = body.indexOf(delimiter, found + delimiter.length);
        }
        return -1;
    };
    let start = body.indexOf(marker);
    while (start !== -1) {
        start += marker.length;
        if (body.subarray(start, start + 2).equals(Buffer.from('--'))) break;
        const end = nextBoundary(start);
        if (end === -1) break;
        const headersEnd = body.indexOf(separator, start);
        if (headersEnd !== -1 && headersEnd < end) {
            const headers = body.subarray(start, headersEnd).toString('utf8');
            const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
            const name = disposition.match(/(?:^|;)\s*name="([^"]+)"/)?.[1];
            const fileName = disposition.match(/(?:^|;)\s*filename="([^"]*)"/)?.[1];
            const buffer = body.subarray(headersEnd + separator.length, end);
            if (name && fileName) {
                // Bundle consumers use the original buffer. Certificates remain available as text.
                result.files[name] = { fileName, buffer };
                if (name !== 'bundle') result.files[name].content = buffer.toString('utf8');
            } else if (name) result.fields[name] = buffer.toString('utf8');
        }
        start = end + 2;
    }
    return result;
}

module.exports = { captureMultipartBody, parseMultipartForm };
