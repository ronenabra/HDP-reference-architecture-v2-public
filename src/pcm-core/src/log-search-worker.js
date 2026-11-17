'use strict';
/** One disposable bounded search worker. Raw files remain authoritative. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { project } = require('./admin-log-view');
const { openLogFile } = require('./log-source');
const { summarize } = require('./unified-log-page');
const { createEventMetadata } = require('../../shared/log-event');
const { normalizeLogEntry, expandLogEntry } = require('./log-normalization');
const { LIMITS, candidate, matchesSearch } = require('./log-search-contract');
const { verifyFile } = require('./log-search-snapshot');
const { isCriticalDiagnostic } = require('../../shared/log-policy');

/** Scan captured byte bounds with bounded carry and deterministic source/path/offset order.
 * @returns {void} Progress, capped canonical summaries and terminal state go to parent.
 */
function run() {
    const { root, files, filters, generation, deadline } = workerData;
    const started = performance.now(), cpu = process.cpuUsage();
    const progress = { bytesRead: 0, scannedFiles: 0, matched: 0, skippedLongLines: 0, candidateLines: 0, parsedLines: 0 };
    let batch = [], lastUpdate = started, capped = false;
    const failures = [];
    let criticalDiagnostic = null;
    /** Flush at most 200 summaries, keeping parent transport and memory bounded. */
    function publish(force = false, state) {
        if (!force && batch.length < LIMITS.page && performance.now() - lastUpdate < 75) return;
        parentPort.postMessage({ state, entries: batch, criticalDiagnostic, progress: { ...progress }, failures: [...failures],
            timings: { totalMilliseconds: performance.now() - started, cpuMicroseconds: process.cpuUsage(cpu) } });
        batch = []; lastUpdate = performance.now();
    }
    /** Parse only safe candidates and verify all fields after canonical projection. */
    function line(data, file, offset, end) {
        if (!data.length) return;
        progress.candidateLines++;
        const raw = data.toString('utf8');
        if (file.logFile !== 'error.log' && !candidate(raw, filters, file.component)) return;
        progress.parsedLines++;
        const parsed = project(raw, file, offset);
        const base = { ...parsed, id: `${file.component.dir}-${file.ino}-${offset}`,
            component: file.component.label, componentLine: offset,
            details: { ...parsed.details, role: file.component.role, healthOrganizationId: file.component.healthOrganizationId } };
        const variants = expandLogEntry(normalizeLogEntry(base));
        for (const entry of variants) {
            entry.event = createEventMetadata(entry, file.component, entry.event?.provenance);
            if (isCriticalDiagnostic(entry) && (!criticalDiagnostic || Date.parse(entry.timestamp) > Date.parse(criticalDiagnostic.timestamp))) criticalDiagnostic = summarize(entry,
                Buffer.from(JSON.stringify({ generation, name: file.name, ino: file.ino, start: offset, end,
                    variant: 'source', digest: crypto.createHash('sha256').update(raw).digest('hex') })).toString('base64url'));
            if (!matchesSearch(entry, filters)) continue;
            // A matching 1001st projection proves truncation; exactly 1000 is still complete.
            if (progress.matched === LIMITS.results) { capped = true; return; }
            const reference = Buffer.from(JSON.stringify({ generation, name: file.name, ino: file.ino,
                start: offset, end, variant: entry.event?.provenance?.kind === 'derived' && entry.details?.type === 'GATEWAY_REQUEST' ? 'GATEWAY_REQUEST' : 'source',
                digest: crypto.createHash('sha256').update(raw).digest('hex') })).toString('base64url');
            batch.push(summarize(entry, reference)); progress.matched++;
            // First match should reach the browser before an entire sparse scan finishes.
            publish(progress.matched === 1);
        }
    }
    try {
        for (const file of files) {
            if (capped) break;
            let fd;
            try {
                fd = openLogFile(root, file);
                verifyFile(fd, file);
                let position = 0, start = 0, carry = Buffer.alloc(0), dropping = false;
                const chunk = Buffer.allocUnsafe(LIMITS.chunk);
                while (position < file.size && !capped) {
                    if (Date.now() > deadline) { publish(true, 'deadline'); return; }
                    if (fs.fstatSync(fd).size < file.size) throw new Error('Captured log was truncated');
                    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, file.size - position), position);
                    if (!count) throw new Error('Captured log ended before its snapshot bound');
                    progress.bytesRead += count;
                    let left = 0, newline;
                    while ((newline = chunk.indexOf(10, left)) !== -1 && newline < count && !capped) {
                        const end = position + newline;
                        if (dropping || carry.length + newline - left > LIMITS.line) progress.skippedLongLines++;
                        else line(carry.length ? Buffer.concat([carry, chunk.subarray(left, newline)]) : chunk.subarray(left, newline), file, start, end);
                        carry = Buffer.alloc(0); dropping = false; left = newline + 1; start = end + 1;
                    }
                    if (!dropping) {
                        if (carry.length + count - left > LIMITS.line) { carry = Buffer.alloc(0); dropping = true; }
                        else carry = Buffer.concat([carry, chunk.subarray(left, count)]);
                    }
                    position += count; publish();
                }
                if (!capped) {
                    if (dropping) progress.skippedLongLines++;
                    else if (carry.length) line(carry, file, start, position);
                }
                verifyFile(fd, file);
                // Reopening checks path identity, including extension ancestor safety after rotation.
                const check = openLogFile(root, file);
                try { verifyFile(check, file); } finally { fs.closeSync(check); }
                progress.scannedFiles++;
            } catch (error) { failures.push({ component: file.component.dir, error: error.message }); }
            finally { if (fd !== undefined) fs.closeSync(fd); }
            publish();
        }
        publish(true, capped ? 'result-limit' : failures.length || progress.skippedLongLines ? 'partial' : 'complete');
    } catch (error) { parentPort.postMessage({ state: 'failed', error: error.message }); }
}
run();
