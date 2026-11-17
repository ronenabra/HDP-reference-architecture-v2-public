'use strict';
/** Process-local bounded search jobs, separate from stateless browse/live paging. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { filesFor } = require('./admin-log-view');
const { openLogFile } = require('./log-source');
const { logGeneration } = require('./log-clear');
const { orderUnifiedLogs } = require('./log-ordering');
const { validateSource } = require('./unified-log-page');
const { LIMITS, validateFilters } = require('./log-search-contract');
const { probe, verifyFile } = require('./log-search-snapshot');
const terminal = state => !['running'].includes(state);
const inventoryKey = components => crypto.createHash('sha256').update(JSON.stringify(components)).digest('hex');

/** Return an HTTP-friendly error without allowing request data to become filesystem input. */
function searchError(message, status) { return Object.assign(new Error(message), { status }); }

/** Own at most two workers and eight short-lived bounded result sets.
 * @param {object} options Optional smaller bounds for deterministic qualification.
 * @returns {object} Start/read/cancel/clear/close lifecycle interface for trusted configured roots.
 */
function createLogSearch(options = {}) {
    const jobs = new Map();
    const limits = { ...LIMITS, ...options };
    let active = 0, closed = false;
    /** Release a running worker; terminating native thread execution also bounds cancellation. */
    function stop(job, state, error) {
        job.state = state; if (error) job.error = error;
        clearTimeout(job.timer);
        if (job.worker) { const worker = job.worker; job.worker = null; worker.terminate(); }
    }
    /** Expired jobs release workers and summaries on reads as well as a periodic reaper. */
    function reap() {
        for (const [id, job] of jobs) if (Date.now() - job.created >= limits.lifetime) { stop(job, 'expired'); jobs.delete(id); }
    }
    const reaper = setInterval(reap, Math.min(limits.lifetime, 30000)); reaper.unref();

    /** Capture registered files and immutable byte limits before starting a query worker. */
    function start(root, components, input) {
        if (closed) throw searchError('Search service is closed', 503);
        const filters = validateFilters(input); validateSource(components, filters.source); reap();
        if (active >= limits.workers) throw searchError('Two searches are already running; cancel one or retry shortly', 429);
        if (jobs.size >= limits.jobs) {
            const oldest = [...jobs.values()].find(job => terminal(job.state));
            if (oldest) jobs.delete(oldest.id);
            else throw searchError('Search capacity is busy; retry shortly', 429);
        }
        const selected = components.filter(component => (!filters.role || component.role === filters.role)
            && (!filters.healthOrganizationId || component.healthOrganizationId === filters.healthOrganizationId)
            && (!filters.source || component.dir === filters.source));
        const failures = [];
        const files = filesFor(root, selected, (error, component) => failures.push({ component: component.dir, error: error.message }))
            .sort((a, b) => `${a.component.dir}/${a.logFile}`.localeCompare(`${b.component.dir}/${b.logFile}`, 'en'))
            .flatMap(file => {
                let fd;
                try {
                    fd = openLogFile(root, file); const stat = fs.fstatSync(fd);
                    return [{ ...file, name: `${file.component.dir}/${file.logFile}`, ino: stat.ino, dev: stat.dev,
                        size: stat.size, probe: probe(fd, stat.size) }];
                } catch (error) { failures.push({ component: file.component.dir, error: error.message }); return []; }
                finally { if (fd !== undefined) fs.closeSync(fd); }
            });
        const healthBudget = { bytes: 0 };
        const runtimeHealth = Object.fromEntries(selected.filter(component => component.role === 'hapi').map(component =>
            [component.dir, require('./log-source').readRuntimeHealth(root, component, healthBudget)]));
        const job = { runtimeHealth, healthMetadataBytes: healthBudget.bytes, id: crypto.randomUUID(), root, key: inventoryKey(components), filters, files, failures,
            generation: logGeneration(root), created: Date.now(), state: 'running', entries: [], reserved: true,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
            progress: { bytesRead: 0, scannedFiles: 0, matched: 0, skippedLongLines: 0 } };
        jobs.set(job.id, job); active++;
        try {
            const worker = new Worker(path.join(__dirname, 'log-search-worker.js'), {
                workerData: { root, files, filters, generation: job.generation, deadline: Date.now() + limits.deadline },
                resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }
            });
            job.worker = worker;
            worker.on('message', result => {
                if (job.state !== 'running') return;
                if (result.entries) job.entries.push(...result.entries.slice(0, LIMITS.results - job.entries.length));
                if (result.progress) job.progress = result.progress;
                if (result.criticalDiagnostic) job.criticalDiagnostic = result.criticalDiagnostic;
                job.workerFailures = result.failures || job.workerFailures || []; job.timings = result.timings;
                if (result.state) {
                    const state = result.state === 'complete' && failures.length ? 'partial' : result.state;
                    stop(job, state, result.error);
                }
            });
            worker.on('error', error => { if (job.state === 'running') stop(job, 'failed', error.message); });
            worker.on('exit', code => {
                if (job.reserved) { job.reserved = false; active--; }
                if (job.state === 'running') stop(job, 'failed', `Search worker exited (${code})`);
            });
            job.timer = setTimeout(() => stop(job, 'deadline', 'Search deadline reached; narrow the source or time range'), limits.deadline + 100);
            job.timer.unref();
        } catch (error) { if (job.reserved) { job.reserved = false; active--; } stop(job, 'failed', error.message); }
        return { id: job.id, state: job.state, limits: LIMITS };
    }

    /** Revalidate inventory, generation, file identity and boundary probes on every response.
     * Appends stay outside fixed byte limits; source replacement invalidates cached summaries.
     */
    function checked(id, root, components) {
        reap(); const job = jobs.get(id);
        if (!job || job.root !== root) throw searchError('Search expired or unavailable; run it again', 404);
        if (job.key !== inventoryKey(components) || job.generation !== logGeneration(root)) {
            stop(job, 'failed', 'Logs or configured sources changed; start a new search'); job.entries = [];
        }
        if (job.state !== 'failed') {
            try {
                for (const file of job.files) {
                    const fd = openLogFile(root, file);
                    try { verifyFile(fd, file); } finally { fs.closeSync(fd); }
                }
            } catch (_) { stop(job, 'failed', 'Captured logs changed, cleared or rotated; start a new search'); job.entries = []; }
        }
        return job;
    }

    /** Page immutable match ordinals; order modes affect presentation only within each page. */
    function read(id, root, components, { offset = '0', order = 'timeline', tail = 'top' } = {}) {
        if (!/^(0|[1-9]\d{0,3})$/.test(String(offset)) || Number(offset) > LIMITS.results || Number(offset) % LIMITS.page) throw searchError('Invalid search result offset', 400);
        if (!['timeline', 'flow', 'legacy'].includes(order) || !['top', 'bottom'].includes(tail)) throw searchError('Invalid search display order', 400);
        const job = checked(id, root, components), start = Number(offset);
        const failures = [...job.failures, ...(job.workerFailures || [])];
        const reasons = [...(job.state === 'result-limit' ? ['result-limit'] : []), ...(job.state === 'deadline' ? ['deadline'] : []),
            ...(Object.values(job.runtimeHealth || {}).some(value => value.state !== 'available' || value.dropped > 0) ? ['native-diagnostics-gaps'] : []),
            ...(job.progress.skippedLongLines ? ['oversized-records'] : []), ...(failures.length ? ['unreadable-streams'] : [])];
        return { id, state: job.state, complete: job.state === 'complete', error: job.error,
            criticalDiagnostic: job.criticalDiagnostic || null,
            entries: orderUnifiedLogs(job.entries.slice(start, start + LIMITS.page), order, tail),
            offset: start, nextOffset: job.entries.length > start + LIMITS.page ? start + LIMITS.page : null,
            progress: { ...job.progress, totalBytes: job.totalBytes, totalFiles: job.files.length },
            snapshot: { capturedAt: new Date(job.created).toISOString(), scope: 'configured-current-and-five-rotations',
                ordering: 'configured source ID, relative file path, ascending byte offset, derived request before source completion',
                appendPolicy: 'Appends after captured byte bounds are excluded. Run again for new events.' },
            sources: components.filter(component => (!job.filters.role || component.role === job.filters.role)
                && (!job.filters.healthOrganizationId || component.healthOrganizationId === job.filters.healthOrganizationId)
                && (!job.filters.source || component.dir === job.filters.source)).map(component => ({
                componentId: component.dir, label: component.label, role: component.role, healthOrganizationId: component.healthOrganizationId,
                ...(job.runtimeHealth?.[component.dir] ? { runtimeHealth: job.runtimeHealth[component.dir] } : {}),
                state: failures.some(failure => failure.component === component.dir) ? 'error' : job.files.some(file => file.component.dir === component.dir) ? 'available' : 'missing',
                coverage: component.coverage || (component.role === 'hapi-import' ? 'import-only' : 'protocol') })),
            coverage: { scope: 'search-snapshot', state: job.state === 'complete' ? 'bounded' : 'partial', reasons,
                rowLimit: LIMITS.results, note: 'Retained matching evidence only; never proof of a complete distributed journey.' },
            rowLimit: LIMITS.page, bytesRead: job.progress.bytesRead, skippedLongLines: job.progress.skippedLongLines,
            failures, timings: job.timings, expiresAt: new Date(job.created + limits.lifetime).toISOString() };
    }

    /** Cancel without discarding already accepted bounded matches. */
    function cancel(id, root, components) {
        const job = checked(id, root, components);
        if (job.state === 'running') stop(job, 'cancelled');
        return { id, state: job.state };
    }
    /** A shared clear listener invalidates all jobs for this configured root immediately. */
    function invalidate(root) {
        for (const job of jobs.values()) if (job.root === root) { stop(job, 'failed', 'Logs cleared; start a new search'); job.entries = []; }
    }
    /** Dispose owned workers and timers when an API fixture or application shuts down. */
    async function close() {
        closed = true; clearInterval(reaper);
        const workers = [...jobs.values()].map(job => job.worker).filter(Boolean);
        for (const job of jobs.values()) stop(job, 'cancelled');
        await Promise.all(workers.map(worker => worker.terminate())); jobs.clear();
    }
    return { start, read, cancel, invalidate, close };
}
module.exports = { createLogSearch };
