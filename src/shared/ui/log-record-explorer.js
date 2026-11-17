'use strict';
/** Selected-record navigation only; no network, persistence or authority checks. */
(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PCM_LOG_RECORD = api;
})(typeof window === 'object' ? window : globalThis, function createExplorer() {
    const LIMITS = Object.freeze({ children: 40, rows: 400, depth: 12, preview: 320, searchVisits: 12000, matches: 50 });
    const own = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);
    /** Preserve JSON scalar types and distinguish empty containers. */
    function type(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
    function container(value) { return value !== null && typeof value === 'object'; }
    /** JSON bracket notation is unambiguous even for dots, quotes and empty keys. */
    function fieldPath(parts) { return '$' + parts.map(key => `[${JSON.stringify(key)}]`).join(''); }
    function at(record, parts) { return parts.reduce((value, key) => own(value, key) ? value[key] : undefined, record); }
    /** Individual strings copy without quotes; every other value copies as JSON. */
    function copyValue(value) { return typeof value === 'string' ? value : JSON.stringify(value); }
    /** Avoid quadratic indentation output for deeply nested selected records. */
    function completeJson(value) { return JSON.stringify(value); }
    function preview(value) {
        const description = container(value) ? `${type(value)} (${Object.keys(value).length} fields)` : JSON.stringify(value);
        return String(description).slice(0, LIMITS.preview) + (String(description).length > LIMITS.preview ? '…' : '');
    }
    /** Iterative resumable DFS bounds each search action without losing later fields. */
    function search(record, query) {
        const needle = String(query).toLowerCase();
        const stack = [{ value: record, path: [], entered: false }];
        return { next() {
            const matches = []; let visits = 0;
            while (stack.length && visits < LIMITS.searchVisits && matches.length < LIMITS.matches) {
                const frame = stack[stack.length - 1];
                if (!frame.entered) {
                    frame.entered = true; visits++;
                    const key = frame.path.at(-1);
                    // Search scalar contents, never serialize entire subtrees per node.
                    const text = container(frame.value) ? '' : String(frame.value);
                    if (String(key ?? '').toLowerCase().includes(needle) || text.toLowerCase().includes(needle)) matches.push({ path: frame.path, value: frame.value });
                    frame.keys = container(frame.value) ? Object.keys(frame.value) : [];
                    frame.offset = 0;
                } else if (frame.offset < frame.keys.length) {
                    const key = frame.keys[frame.offset++];
                    stack.push({ value: frame.value[key], path: [...frame.path, key], entered: false });
                } else stack.pop();
            }
            return { matches, visits, done: stack.length === 0 };
        } };
    }
    /** Decode recorded JWT syntax only; never verifies a signature or current validity. */
    function decodeJwt(value) {
        if (typeof value !== 'string') return null;
        const token = value.replace(/^Bearer\s+/i, '');
        const parts = token.split('.');
        if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
        try {
            const decode = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))));
            const header = decode(parts[0]), payload = decode(parts[1]);
            return container(header) && !Array.isArray(header) && container(payload) && !Array.isArray(payload) ? { header, payload } : null;
        } catch (_) { return null; }
    }
    const TOKEN_KEYS = new Set(['access_token', 'token', 'assertion', 'client_assertion', 'authorization']);
    /** Bounded token discovery finds nested HTTP bodies/headers without guessing claims. */
    function tokens(record) {
        const found = []; const pending = [{ value: record.details, path: ['details'] }]; let visits = 0;
        while (pending.length && visits++ < LIMITS.searchVisits && found.length < 20) {
            const item = pending.pop();
            if (!container(item.value)) continue;
            for (const key of Object.keys(item.value)) {
                if (found.length >= 20 || visits++ >= LIMITS.searchVisits) break;
                const value = item.value[key], path = [...item.path, key];
                if (TOKEN_KEYS.has(key.toLowerCase()) && typeof value === 'string') found.push({ path, value,
                    opaque: record.details?.type === 'TOKEN_ISSUED' && key === 'access_token' });
                if (container(value) && path.length < 10) pending.push({ value, path });
            }
        }
        return found;
    }
    /** Small declarative registry: summaries always link back to generic recorded data. */
    const renderers = [
        { title: 'Token evidence', matches: record => /TOKEN|INTROSPECTION/.test(record.details?.type || '') || tokens(record).length > 0,
            fields: ['kind', 'access_token', 'token', 'scope', 'audience', 'authorization_details', 'clinicalPolicy', 'lifetimeSeconds', 'active', 'decision', 'reason', 'issuanceRecord'] },
        { title: 'Issuance-time grant constraints', matches: record => record.details?.type === 'TOKEN_ISSUED' && container(record.details?.issuanceRecord?.authorization),
            base: ['details', 'issuanceRecord', 'authorization'],
            fields: ['scenario', 'scope', 'requestedScope', 'patient.system', 'patient.value', 'requested.basis.type', 'requested.basis.identifier.system', 'requested.basis.identifier.value', 'requested.patients', 'deadline', 'compiledAt', 'consentId', 'contractId', 'serviceId', 'dataSourceOrganizationId', 'clinicalPolicy', 'authority'] },
        { title: 'HTTP exchange', matches: record => /REQUEST|RESPONSE|ROUTE_ERROR|OUTGOING_ERROR/.test(record.details?.type || ''),
            fields: ['method', 'url', 'status', 'statusCode', 'durationMs', 'headers', 'body', 'request', 'response', 'error'] },
        { title: 'Recorded authorization decision', matches: record => own(record.details, 'decision') || /AUTHORIZATION|PERMISSION/.test(record.details?.type || ''),
            fields: ['decision', 'reason', 'active', 'scope', 'requestedScope', 'audience', 'basis', 'authorization_details', 'clinicalPolicy', 'error'] }
    ];
    function specialized(record) {
        return renderers.filter(renderer => renderer.matches(record)).map(renderer => ({ title: renderer.title,
            fields: renderer.fields.map(key => {
                const path = [...(renderer.base || ['details']), ...key.split('.')], value = at(record, path);
                return { key, path, available: value !== undefined, value };
            }) }));
    }

    /** Event-specific facts use only recorded values; missing counts never become zero.
     * @param {object} record Resolved normalized selected event.
     * @returns {Array<{label: string, value: unknown}>} Present summary facts.
     */
    function summary(record) {
        const d = record.details || {};
        const fields = d.type === 'HAPI_RESULT_FILTER_SUMMARY'
            ? [['Input examined', 'examined'], ['Kept', 'allowed'], ['Excluded', 'removed']]
            : /AUTH|PERMISSION|CONTEXT_VALIDATION|ADMISSION|TOKEN|INTROSPECTION/.test(d.type || '')
                ? [['Decision', 'decision'], ['Outcome', 'outcome'], ['Active', 'active'], ['Reason', 'reasonCode'], ['Reason detail', 'reason']]
                : /REQUEST|RESPONSE|ERROR/.test(d.type || '')
                    ? [['Method', 'method'], ['Request', 'url'], ['Request path', 'requestPath'], ['Status', 'status'], ['Status code', 'statusCode'], ['Outcome', 'outcome']]
                    : [['Event', 'type'], ['Outcome', 'outcome'], ['Reason', 'reasonCode']];
        return fields.filter(([, key]) => d[key] !== undefined && d[key] !== null).map(([label, key]) => ({ label, value: d[key] }));
    }

    /** Mount lazy DOM using textContent exclusively for all recorded keys/values. */
    function mount(host, record, { copy = async () => {}, status = () => {}, state = {} } = {}) {
        host.replaceChildren();
        const document = host.ownerDocument;
        const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
        const button = (label, action, help = 'logs.explorer') => { const element = node('button', label, 'btn'); element.type = 'button'; element.dataset.helpKey = help; element.addEventListener('click', action); return element; };
        const facts = summary(record);
        const factList = node('dl', undefined, 'record-metadata');
        for (const fact of facts) factList.append(node('dt', fact.label), node('dd', typeof fact.value === 'object' ? JSON.stringify(fact.value) : String(fact.value)));
        host.append(facts.length ? factList : node('p', 'No summary facts recorded for this event.'));
        const heading = node('h3', 'Recorded event views'); host.append(heading);
        const evidence = node('p', `Source event ${record.id ?? 'unavailable'} · timestamp ${record.timestamp ?? 'unavailable'}. Only recorded fields are shown; missing fields are unavailable. Unknown fields remain in the field explorer.`); host.append(evidence);
        const groups = specialized(record);
        if (!groups.length) host.append(node('p', 'No specialized view for this event. Explore all recorded fields below.'));
        const explorer = node('div', undefined, 'record-explorer');
        const results = node('div', undefined, 'explorer-results');
        const tree = node('div', undefined, 'explorer-tree');
        let rootPath = state.rootPath || [], renderedRows = 0, chosenPath = state.chosenPath;
        const expanded = new Map((state.expanded || []).map(item => [JSON.stringify(item.path), item]));
        const fullValue = node('pre', '', 'explorer-value'); fullValue.tabIndex = 0; fullValue.hidden = true; fullValue.setAttribute('aria-label', 'Complete chosen field value');
        const valueHeading = node('p', 'Choose Read value to view the complete value here.');
        let copyRevision = 0;
        /** Reveal action results; restoration keeps its saved scroll/focus.
         * @param {HTMLElement} element Result to focus and scroll into view.
         * @returns {void}
         */
        function reveal(element) { element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'nearest' }); }
        const read = (path, value, restoring = false) => { copyRevision++; chosenPath = path; valueHeading.textContent = `Complete value · ${fieldPath(path)} · ${type(value)}`; fullValue.textContent = copyValue(value); fullValue.hidden = false; if (!restoring) reveal(fullValue); };
        const copyField = async (path, value) => {
            const revision = ++copyRevision;
            const current = () => revision === copyRevision && host.isConnected;
            try {
                const result = await copy(copyValue(value), current);
                if (current() && result === undefined) status(`Copied value · ${fieldPath(path)}`);
            } catch (_) {
                if (!current()) return;
                read(path, value); status('Copy is unavailable. Select the complete value and use your browser’s copy command.');
            }
        };
        const rootLabel = node('p'); rootLabel.tabIndex = -1;
        /** Re-rooting keeps deeply nested data reachable without growing DOM depth. */
        function navigate(path, restoring = false) { copyRevision++; if (!restoring) expanded.clear(); rootPath = path; tree.replaceChildren(); renderedRows = 0; rootLabel.textContent = `Exploring ${fieldPath(path)}`; addRow(tree, path, at(record, path), 0); if (!restoring) reveal(rootLabel); }
        function addRow(parent, path, value, depth) {
            if (renderedRows >= LIMITS.rows) { status('400 field rows reached. Collapse a branch or explore an object as the root to continue.'); return false; }
            renderedRows++;
            const row = node('div', undefined, 'explorer-row'); row.dataset.fieldPath = fieldPath(path);
            const label = node('span', `${fieldPath(path)} · ${type(value)} · ${preview(value)}`, 'field-label');
            row.append(label, button('Read value', () => read(path, value)), button('Copy value', () => copyField(path, value), 'logs.copy-value'));
            if (container(value)) {
                row.append(button('Explore object', () => navigate(path)));
                const branch = node('details'); const summary = node('summary', 'Expand fields'); summary.dataset.helpKey = 'logs.explorer';
                const children = node('div', undefined, 'explorer-children'); branch.append(summary, children); row.append(branch);
                let offset = 0;
                const expansionKey = JSON.stringify(path), savedExpansion = expanded.get(expansionKey);
                const keys = Object.keys(value);
                const more = button('More fields', () => { more.remove(); appendPage(); });
                function appendPage() {
                    if (depth >= LIMITS.depth) { children.append(button('Continue at this object', () => navigate(path))); return; }
                    const end = Math.min(offset + LIMITS.children, keys.length);
                    while (offset < end && renderedRows < LIMITS.rows) { const key = keys[offset++]; addRow(children, [...path, key], value[key], depth + 1); }
                    if (offset < keys.length) children.append(more);
                    expanded.set(expansionKey, { path, count: offset });
                    if (keys.length === 0) children.append(node('p', `Empty ${type(value)}.`));
                    if (renderedRows >= LIMITS.rows) status('400 field rows reached. Collapse a branch or explore an object as the root to continue.');
                }
                branch.addEventListener('toggle', () => {
                    if (branch.open && !children.childNodes.length) appendPage();
                    if (!branch.open) {
                        renderedRows -= children.querySelectorAll('.explorer-row').length; children.replaceChildren(); offset = 0;
                        for (const [key, item] of expanded) if (item.path.length >= path.length && path.every((part, index) => item.path[index] === part)) expanded.delete(key);
                    }
                });
                if (savedExpansion) {
                    branch.open = true; appendPage();
                    while (offset < savedExpansion.count && renderedRows < LIMITS.rows && depth < LIMITS.depth) { more.remove(); appendPage(); }
                }
            }
            parent.append(row); return true;
        }
        for (const group of groups) {
            const section = node('details'); section.open = true; section.append(node('summary', group.title));
            if (group.title === 'Token evidence') section.append(node('p', 'Opaque access tokens are exact recorded values. The issuance-time server record is historical server evidence, not decoded token contents or a current authorization verdict. Legacy rows without it remain unavailable.'));
            for (const field of group.fields) {
                const label = field.key === 'issuanceRecord' ? 'Issuance-time server record' : field.key;
                const item = node('div', `${label}: ${field.available ? preview(field.value) : 'Unavailable (not recorded)'}`, 'specialized-field');
                if (field.available) {
                    if (container(field.value)) item.append(button('Explore ' + label, () => navigate(field.path)));
                    item.append(button('Read ' + label, () => read(field.path, field.value)));
                }
                if (field.key === 'scope' && typeof field.value === 'string') {
                    const scopes = node('ul'); for (const scope of field.value.split(/\s+/).filter(Boolean).slice(0, 40)) scopes.append(node('li', scope));
                    item.append(scopes); if (field.value.split(/\s+/).length > 40) item.append(node('p', 'First 40 scopes; Read scope shows the complete recorded value.'));
                }
                section.append(item);
            }
            host.append(section);
        }
        for (const token of tokens(record)) {
            const item = node('details'); item.append(node('summary', `${token.opaque ? 'Exact opaque token' : 'Recorded token / assertion'} · ${fieldPath(token.path)}`));
            const original = node('pre', token.value); original.tabIndex = 0; item.append(original, button('Copy token value', () => copyField(token.path, token.value), 'logs.copy-value'));
            if (!token.opaque) {
                const decoded = decodeJwt(token.value);
                item.append(node('p', decoded ? 'Decoded recorded JWT header/payload only. Decoding does not establish signature validity, expiry or current authorization.' : 'No decodable JWT header/payload. Original recorded value retained.'));
                if (decoded) item.append(node('pre', completeJson(decoded)));
            }
            host.append(item);
        }
        const title = node('h3', 'All recorded fields'); title.dataset.helpKey = 'logs.explorer'; explorer.append(title);
        const form = node('form'); const label = node('label', 'Search field names or values '); const input = node('input'); input.type = 'search'; input.maxLength = 512; input.dataset.helpKey = 'logs.field-search'; label.append(input);
        input.value = state.query || '';
        let session = state.searchSession || null, lastBatch = state.searchBatch || null;
        const searchStatus = node('p'); searchStatus.setAttribute('role', 'status');
        const next = button('Search next batch', () => runSearch()); next.hidden = true;
        function showBatch(batch) {
            lastBatch = batch; results.replaceChildren();
            for (const match of batch.matches) { const item = node('div', `${fieldPath(match.path)} · ${type(match.value)} · ${preview(match.value)}`, 'field-match'); item.append(button('Explore match', () => navigate(match.path)), button('Read match', () => read(match.path, match.value)), button('Copy match value', () => copyField(match.path, match.value), 'logs.copy-value')); results.append(item); }
            searchStatus.textContent = `${batch.matches.length} matches in this batch · ${batch.visits} fields inspected. ${batch.done ? 'Search complete.' : 'More fields remain; use Search next batch. No completeness claim until the search is complete.'}`; next.hidden = batch.done;
        }
        function runSearch() { showBatch(session.next()); }
        form.addEventListener('submit', event => { event.preventDefault(); if (!input.value) { results.replaceChildren(); searchStatus.textContent = ''; next.hidden = true; session = null; lastBatch = null; return; } session = search(record, input.value); runSearch(); });
        const submit = button('Search fields', () => {} , 'logs.field-search'); submit.type = 'submit'; form.append(label, submit);
        explorer.append(form, next, searchStatus, results, button('Reset field tree', () => navigate([])), rootLabel, tree, valueHeading, fullValue);
        host.append(explorer); navigate(rootPath, true);
        if (lastBatch) showBatch(lastBatch);
        if (chosenPath) read(chosenPath, at(record, chosenPath), true);
        // History owns at most twenty in-tab snapshots. Retain only bounded
        // explorer state and the selected-record traversal, never browser storage.
        return { navigate, read, state: () => ({ rootPath, chosenPath, expanded: [...expanded.values()].map(item => ({ path: item.path, count: item.count })),
            query: input.value, searchSession: session, searchBatch: lastBatch }) };
    }
    return { LIMITS, type, fieldPath, at, copyValue, completeJson, preview, search, decodeJwt, tokens, specialized, summary, mount };
});
