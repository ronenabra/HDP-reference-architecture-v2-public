'use strict';

/** Deterministic synthetic HTTP responses for browser-only polling/navigation races.
 * The authored view/assets still come from the owned real operator fixture. Nothing
 * here writes to a team or models a complete live clinical journey.
 */
const SOURCES = [
    { componentId: 'sp-client', label: 'Doctor App', role: 'doctor' },
    { componentId: 'pcm-core', label: 'PCM', role: 'pcm' },
    { componentId: 'ho-a-gateway', label: 'Reference Health Organization A Gateway', role: 'gateway', healthOrganizationId: 'ho-a' },
    { componentId: 'ho-a-adapter', label: 'Reference Health Organization A Adapter', role: 'adapter', healthOrganizationId: 'ho-a' }
];
const FLOW_PREFIX = 'fabricated+flow/&?=';

/** Produce an identifiable record whose byte-for-byte raw body can be checked. */
function event(index) {
    const source = SOURCES[index % SOURCES.length];
    const flowId = `${FLOW_PREFIX}${Math.floor(index / 24)}`;
    const traceId = Math.floor(index / 8).toString(16).padStart(32, 'a');
    return {
        id: `fabricated-event-${index}`, reference: `fabricated-reference-${index}`,
        timestamp: new Date(Date.UTC(2026, 9, 10, 12) + index * 1000).toISOString(),
        component: source.label, level: index % 11 === 0 ? 'WARN' : 'INFO',
        message: `Fabricated ${source.role} event ${index}`,
        details: { type: 'OBSERVED_EVENT', category: 'system', visibility: 'default', flowId, traceId,
            correlationId: `request-${Math.floor(index / 8)}`, role: source.role, healthOrganizationId: source.healthOrganizationId,
            method: 'GET', url: '/fhir/Observation', status: 200 },
        event: { schemaVersion: '1.0', eventName: 'OBSERVED_EVENT', source: { ...source },
            correlation: { flowId, traceId, correlationId: `request-${Math.floor(index / 8)}` }, provenance: { kind: 'emitted' } }
    };
}

/** Install only read-route interception; test-controlled reads execute the real polling code. */
async function installWorkbenchFixture(page, { count = 400 } = {}) {
    const state = { entries: Array.from({ length: count }, (_, index) => event(index)), reads: [], details: [],
        failure: null, sourceFailures: [], detailResponder: null, responseGate: null, pageResponder: null };
    const snapshots = new Map();
    let snapshotId = 0;
    // Make refresh timing deterministic, preserving the real fetch/render/state code.
    await page.addInitScript(() => {
        const schedule = window.setInterval.bind(window);
        window.setInterval = (callback, milliseconds, ...args) => milliseconds === 3000 ? 0 : schedule(callback, milliseconds, ...args);
    });
    await page.route('**/api/unified-logs?**', async route => {
        const params = new URL(route.request().url()).searchParams;
        state.reads.push(Object.fromEntries(params));
        if (state.responseGate) await state.responseGate;
        if (state.pageResponder && await state.pageResponder(route, params)) return;
        if (state.failure) return route.fulfill({ status: state.failure.status || 503, json: { error: state.failure.message } });
        let rows = state.entries.filter(row => {
            for (const field of ['role', 'healthOrganizationId', 'flowId', 'traceId', 'correlationId', 'method', 'status']) {
                if (params.has(field) && String(row.details[field] || '') !== params.get(field)) return false;
            }
            return !params.has('level') || row.level === params.get('level');
        });
        rows = rows.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        let key, offset, end;
        const cursor = params.get('cursor');
        if (cursor?.startsWith('live@')) {
            const [oldKey, oldOffset] = cursor.slice(5).split(':');
            const previous = snapshots.get(oldKey);
            const high = Number(oldOffset) ? Number(previous.rows[Number(oldOffset)].id.replace('fabricated-event-', '')) + 1 : previous.high;
            key = previous.high === state.entries.length ? oldKey : `fabricated-snapshot-${++snapshotId}`;
            if (key !== oldKey) snapshots.set(key, { rows, high: state.entries.length });
            const unseen = rows.filter(row => Number(row.id.replace('fabricated-event-', '')) >= high).length;
            offset = Math.max(0, unseen - 200); end = unseen;
            if (!unseen) rows = [];
        } else if (cursor) {
            [key, offset, end] = cursor.split(':');
            end = end === undefined ? undefined : Number(end);
            rows = snapshots.get(key)?.rows || [];
            offset = Number(offset);
        } else {
            key = `fabricated-snapshot-${++snapshotId}`; offset = 0;
            snapshots.set(key, { rows, high: state.entries.length });
        }
        while (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
        end = end === undefined ? offset + 200 : end;
        const hasMore = rows.length > end;
        rows = rows.slice(offset, end).map(row => ({ ...row }));
        if (params.get('tail') === 'bottom') rows.reverse();
        if (params.get('order') === 'flow') rows = rows.map((row, index) => ({ ...row,
            flowGroup: { start: index === 0 || rows[index - 1].details.flowId !== row.details.flowId,
                title: 'Fabricated observed flow', subtitle: `${row.details.flowId} · this returned page only` } }));
        await route.fulfill({ json: { entries: rows, liveCursor: `live@${key}:${offset}`, resumeCursor: `${key}:${offset}`, previousCursor: offset > 0 ? `${key}:${Math.max(0, offset - 200)}:${offset}` : null, nextCursor: hasMore ? `${key}:${end}` : null,
            bytesRead: 524288, rowLimit: 200, coverage: { state: 'partial', rowLimit: 200, reasons: ['read-budget', ...(hasMore ? ['older-records'] : [])] },
            failures: state.sourceFailures, sources: SOURCES.map(source => ({ ...source, state: state.sourceFailures.some(failure => failure.component === source.componentId) ? 'unavailable' : 'available', coverage: 'synthetic browser response' })) } });
    });
    // Synthetic navigation/race tests mirror the accepted job transport. They
    // freeze matching summaries at admission; real engine correctness is covered
    // by log-search/inspection against the owned source/API fixture.
    const jobs = new Map();
    state.searches = [];
    await page.route('**/api/unified-logs/search', async route => {
        const filters = route.request().postDataJSON();
        const id = `fabricated-job-${jobs.size + 1}`;
        const rows = state.entries.filter(row => Object.entries(filters).every(([key, value]) => {
            if (['diagnostics', 'order', 'tail'].includes(key) || value === '') return true;
            if (key === 'level') return row.level === value;
            if (key === 'source') return row.event.source.componentId === value;
            return String(row.details[key] || '') === value;
        }));
        jobs.set(id, rows.map(row => structuredClone(row)));
        state.searches.push({ id, filters });
        await route.fulfill({ status: 202, json: { id, state: 'running' } });
    });
    await page.route('**/api/unified-logs/search/*', async route => {
        const url = new URL(route.request().url()), id = url.pathname.split('/').pop();
        if (route.request().method() === 'DELETE') {
            jobs.delete(id); return route.fulfill({ json: { id, state: 'cancelled' } });
        }
        const rows = jobs.get(id);
        if (!rows) return route.fulfill({ status: 410, json: { error: 'Synthetic job unavailable' } });
        const offset = Number(url.searchParams.get('offset') || 0);
        let entries = rows.slice(offset, offset + 200).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        if (url.searchParams.get('tail') === 'bottom') entries.reverse();
        await route.fulfill({ json: { id, state: 'complete', entries,
            nextOffset: offset + 200 < rows.length ? offset + 200 : null,
            progress: { matched: rows.length, bytesRead: rows.length * 200, scannedFiles: SOURCES.length, totalFiles: SOURCES.length },
            failures: [], sources: SOURCES.map(source => ({ ...source, state: 'available' })) } });
    });
    await page.route('**/api/unified-logs/detail?**', async route => {
        const reference = new URL(route.request().url()).searchParams.get('reference');
        state.details.push(reference);
        if (state.detailResponder && await state.detailResponder(route, reference)) return;
        const index = Number(reference.replace('fabricated-reference-', ''));
        const entry = event(index);
        entry.details = { ...entry.details, payload: 'Fabricated safe payload <script>never run</script>\r\n'.repeat(90) };
        const raw = `Fabricated exact source ${index}\r\n` + 'raw text stays stable\t<>&\r\n'.repeat(100);
        await route.fulfill({ json: { entry, raw, source: { componentId: entry.event.source.componentId, logFile: 'current.log', byteOffset: index * 200 } } });
    });
    state.append = amount => {
        const start = state.entries.length;
        state.entries.push(...Array.from({ length: amount }, (_, index) => event(start + index)));
    };
    return state;
}

module.exports = { SOURCES, FLOW_PREFIX, event, installWorkbenchFixture };
