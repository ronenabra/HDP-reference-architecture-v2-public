'use strict';
/** Source-bound complete scan/API/normalization/render/resource qualification. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, expect } = require('@playwright/test');
const { TRACE, RARE } = require('../../../test-support/log-search-corpus');
const targets = require('../../../test-support/fixtures/log-viewer/search-targets.json');

/** Parse kernel cumulative I/O counters without guessing cache residency. */
function io(value) { return Object.fromEntries(value.trim().split('\n').map(line => line.split(':').map(part => part.trim())).map(([key, value]) => [key, Number(value)])); }
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] || 0;

test('733 MiB text scan full-path qualification', async ({ browser, page, request }, testInfo) => {
    const manifest = await (await request.get('/fixture/manifest')).json();
    const evidence = { schemaVersion: 'log-search-benchmark/1', targets, manifest,
        environment: { runnerNode: process.version, browser: browser.version(), architecture: process.arch, platform: process.platform },
        cases: [], concurrency: null, cancellation: null, cache: null };
    const evidenceFile = process.env.PCM_SEARCH_BENCHMARK_OUTPUT || testInfo.outputPath('benchmark.json');
    /** Retain evidence even on a target miss, without turning missing cases into passes. */
    const save = () => { fs.mkdirSync(path.dirname(evidenceFile), { recursive: true }); fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n'); };
    const metrics = async () => (await request.get('/fixture/metrics')).json();
    evidence.environment.serviceNode = (await metrics()).node;
    await page.addInitScript(() => {
        const interval = window.setInterval.bind(window);
        window.setInterval = (fn, ms, ...args) => ms === 3000 ? 0 : interval(fn, ms, ...args);
        localStorage.setItem('unifiedLogOrderMode', 'timeline');
    });
    await page.goto('/logs-view?role=pcm'); await expect(page.locator('.log-row').first()).toBeVisible();
    await page.locator('#log-list').focus();
    /** Drive actual controls and rendering while sampling real browse requests/CPU/RSS/I/O. */
    async function measure(name, filters, expected, mode = 'warm') {
        const before = await metrics(), browse = []; let peakRss = before.memory.rss, sampling = true;
        const sample = (async () => {
            while (sampling) {
                const started = performance.now();
                const response = await request.get('/api/unified-logs?page=true&role=pcm');
                expect(response.ok()).toBe(true); await response.body(); browse.push(performance.now() - started);
                peakRss = Math.max(peakRss, (await metrics()).memory.rss);
                await new Promise(resolve => setTimeout(resolve, 30));
            }
        })();
        try {
            await page.evaluate(filters => {
                for (const field of FILTER_FIELDS) filterControl(field).value = filters[field] || '';
                for (const field of SEARCH_FIELDS) document.getElementById(`search-${field}`).value = filters[field] || '';
                return startSearch();
            }, filters);
            await expect.poll(() => page.evaluate(() => searchSession?.state), { timeout: 30000, intervals: [20, 30, 50] })
                .toMatch(/^(complete|partial|result-limit)$/);
            const timing = await page.evaluate(() => ({ ...window.logSearchTimings, id: searchSession.id }));
            const after = await metrics(), readBefore = io(before.io), readAfter = io(after.io);
            const record = { name, mode, filters, expected, observed: timing.progress.matched, ...timing,
                cpuMicroseconds: { user: after.cpu.user - before.cpu.user, system: after.cpu.system - before.cpu.system },
                rssBefore: before.memory.rss, rssAfter: after.memory.rss, peakRss,
                io: Object.fromEntries(Object.keys(readAfter).map(key => [key, readAfter[key] - readBefore[key]])),
                browse: { samples: browse.length, p95Milliseconds: quantile(browse, 0.95), maximumMilliseconds: Math.max(...browse) } };
            evidence.cases.push(record); save();
            expect(timing.progress.matched, name).toBe(expected);
            expect(timing.terminalRenderedMilliseconds, name).toBeLessThanOrEqual(targets.targets.singleTerminalApiAndRenderMilliseconds);
            if (name.includes('sparse') || name.includes('late') || name.includes('rare')) expect(timing.firstRenderedMilliseconds, name).toBeLessThanOrEqual(targets.targets.sparseFirstResultApiAndRenderMilliseconds);
            expect(record.browse.p95Milliseconds, name).toBeLessThanOrEqual(targets.targets.browseApiP95MillisecondsDuringSearch);
            return record;
        } finally { sampling = false; await sample; }
    }
    try {
        expect(manifest.files.length).toBe(53); expect(manifest.bytes / 1048576).toBeGreaterThanOrEqual(732);
        await measure('sparse late trace', { traceId: TRACE }, 4);
        await measure('absent exact ID', { traceId: 'absent-literal-id' }, 0);
        await measure('combined source/time/HTTP/ID/text', { source: manifest.lateSource, traceId: TRACE,
            method: 'GET', status: '200', path: '/fhir/Observation', since: '2026-11-04T10:00:00Z', until: '2026-11-04T10:00:03Z', text: 'rare literal [x]' }, 4);
        await measure('rare text late source', { text: RARE }, 4);
        await measure('common text result cap', { text: 'Observation' }, 1000);
        await measure('dense structured result cap', { level: 'INFO' }, 1000);
        await measure('early source exact ID', { correlationId: 'early-match' }, 1);
        await measure('repeated sparse late trace', { traceId: TRACE }, 4);
        await measure('malformed normalized message', { text: 'malformed-benchmark-record' }, 1);
        await measure('oversized omitted with partial state', { text: 'oversized-benchmark-marker' }, 0);
        await measure('AWS value cannot match', { text: 'FAKE_CORPUS_AWS_SECRET' }, 0);
        await measure('diagnostics off', { traceId: TRACE }, 4);
        // Evict only owned regular files, without touching host-wide cache settings.
        const evict = await request.post('/fixture/evict-owned-cache'); evidence.cache = await evict.json();
        if (!evict.ok() && process.env.PCM_SEARCH_OWNED_ROOT) {
            const code = 'import os,sys\nn=0\nfor root,dirs,files in os.walk(sys.argv[1]):\n for name in files:\n  if not name.endswith(".log"): continue\n  f=os.open(os.path.join(root,name),os.O_RDONLY)\n  os.fsync(f)\n  os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED)\n  os.close(f)\n  n+=1\nprint(n)';
            evidence.cache = { method: 'owned-file POSIX_FADV_DONTNEED from browser tooling container',
                files: Number(execFileSync('python3', ['-c', code, process.env.PCM_SEARCH_OWNED_ROOT], { encoding: 'utf8' }).trim()) };
        }
        save(); expect(evidence.cache.files, 'required owned-file cold-equivalent method').toBeGreaterThanOrEqual(53);
        await measure('cold-equivalent sparse late trace', { traceId: TRACE }, 4, 'owned-file cache eviction');
        // Two independent browser sessions, two real workers, live append-only writer.
        await page.evaluate(() => leaveSearch(false));
        const secondContext = await browser.newContext(); const second = await secondContext.newPage();
        await second.goto('http://127.0.0.1:43184/logs-view?role=pcm'); await expect(second.locator('.log-row').first()).toBeVisible();
        const before = await metrics(), browse = []; let peakRss = before.memory.rss, sampling = true;
        const sample = (async () => { while (sampling) {
            const start = performance.now(); const response = await request.get('/api/unified-logs?page=true&role=pcm'); await response.body(); browse.push(performance.now() - start);
            peakRss = Math.max(peakRss, (await metrics()).memory.rss); await new Promise(resolve => setTimeout(resolve, 20));
        } })();
        await request.post('/fixture/writer/on');
        const run = (tab, filters) => tab.evaluate(filters => {
            for (const field of FILTER_FIELDS) filterControl(field).value = filters[field] || '';
            for (const field of SEARCH_FIELDS) document.getElementById(`search-${field}`).value = filters[field] || '';
            return startSearch();
        }, filters);
        await Promise.all([run(page, { traceId: TRACE }), run(second, { text: 'absent-under-live-writers' })]);
        await Promise.all([page, second].map(tab => expect.poll(() => tab.evaluate(() => searchSession?.state), { timeout: 30000, intervals: [30] }).toMatch(/^(complete|partial)$/)));
        sampling = false; await sample; await request.post('/fixture/writer/off');
        const concurrent = await Promise.all([page, second].map(tab => tab.evaluate(() => window.logSearchTimings)));
        const after = await metrics();
        evidence.concurrency = { results: concurrent, rssBefore: before.memory.rss, peakRss,
            incrementalRss: peakRss - before.memory.rss, writes: after.writes - before.writes,
            cpuMicroseconds: { user: after.cpu.user - before.cpu.user, system: after.cpu.system - before.cpu.system },
            browse: { samples: browse.length, p95Milliseconds: quantile(browse, 0.95), maximumMilliseconds: Math.max(...browse) },
            io: Object.fromEntries(Object.entries(io(after.io)).map(([key, value]) => [key, value - io(before.io)[key]])) };
        save();
        expect(concurrent[0].progress.matched).toBe(4); expect(concurrent[1].progress.matched).toBe(0); expect(evidence.concurrency.writes).toBeGreaterThan(0);
        for (const timing of concurrent) expect(timing.terminalRenderedMilliseconds).toBeLessThanOrEqual(targets.targets.twoConcurrentTerminalMillisecondsEach);
        expect(evidence.concurrency.incrementalRss).toBeLessThanOrEqual(targets.targets.incrementalProcessRssBytesTwoWorkers);
        expect(evidence.concurrency.browse.p95Milliseconds).toBeLessThanOrEqual(targets.targets.browseApiP95MillisecondsDuringSearch);
        await secondContext.close();
        // Cancel immediately after admission, then prove captured progress stops changing.
        await new Promise(resolve => setTimeout(resolve, 100));
        const cancellationBaseline = await metrics();
        const start = await request.post('/api/unified-logs/search', { data: { text: 'absent-cancellation-query' } });
        expect(start.status()).toBe(202); const job = await start.json();
        // Exercise interruption after real scan progress, rather than cancelling startup alone.
        await expect.poll(async () => (await (await request.get(`/api/unified-logs/search/${job.id}`)).json()).progress.bytesRead,
            { timeout: 1000, intervals: [10] }).toBeGreaterThan(0);
        const cancelStart = performance.now(), cancelled = await request.delete(`/api/unified-logs/search/${job.id}`);
        const acknowledgementMilliseconds = performance.now() - cancelStart;
        expect(cancelled.ok()).toBe(true); expect((await cancelled.json()).state).toBe('cancelled');
        const one = await (await request.get(`/api/unified-logs/search/${job.id}`)).json();
        await expect.poll(async () => (await metrics()).threads, { timeout: 500, intervals: [5] }).toBeLessThanOrEqual(cancellationBaseline.threads);
        const stopObservedMilliseconds = performance.now() - cancelStart;
        await new Promise(resolve => setTimeout(resolve, 200));
        const two = await (await request.get(`/api/unified-logs/search/${job.id}`)).json();
        const cancellationAfter = await metrics();
        evidence.cancellation = { acknowledgementMilliseconds, workerStopObservedMilliseconds: stopObservedMilliseconds,
            progressStoppedWithinMilliseconds: 200, threadsBeforeAdmission: cancellationBaseline.threads,
            threadsAfterCancellation: cancellationAfter.threads, before: one.progress, after: two.progress, state: two.state };
        expect(two.progress).toEqual(one.progress);
        expect(acknowledgementMilliseconds).toBeLessThanOrEqual(targets.targets.cancelAcknowledgementMilliseconds);
        expect(stopObservedMilliseconds).toBeLessThanOrEqual(targets.targets.workerStopMilliseconds);
        evidence.decision = 'PASS: bounded scan meets declared targets; SQLite evaluation is not warranted'; save();
    } finally { save(); await request.post('/fixture/writer/off'); }
});
