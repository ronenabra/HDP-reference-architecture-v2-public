'use strict';
/** Validated, literal search semantics. No request value is interpreted as a path or regex. */
const { matches } = require('./unified-log-page');
const FIELDS = ['role', 'healthOrganizationId', 'level', 'method', 'correlationId', 'flowId', 'traceId', 'operationId', 'sourceId',
    'path', 'status', 'source', 'since', 'until', 'text', 'diagnostics', 'visibility'];
const LIMITS = Object.freeze({ workers: 2, jobs: 8, results: 1000, page: 200, chunk: 256 * 1024,
    line: 256 * 1024, deadline: 30000, lifetime: 5 * 60 * 1000 });

/** Reject ambiguous/malformed filters before reserving a worker.
 * @param {object} input Plain search request.
 * @returns {object} Canonical scalar filters with validated inclusive UTC time bounds.
 */
function validateFilters(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Search filters must be an object');
    const filters = {};
    for (const key of Object.keys(input)) {
        if (!FIELDS.includes(key)) throw new TypeError('Unknown search filter');
        if (typeof input[key] !== 'string' || input[key].length > (key === 'text' ? 512 : 256)) throw new TypeError(`Invalid search filter: ${key}`);
        if (input[key]) filters[key] = input[key];
    }
    for (const key of ['diagnostics']) if (filters[key] && !['true', 'false'].includes(filters[key])) throw new TypeError(`Invalid search filter: ${key}`);
    if (filters.visibility && !['all', 'default'].includes(filters.visibility)) throw new TypeError('Invalid visibility');
    for (const key of ['since', 'until']) {
        if (!filters[key]) continue;
        const time = Date.parse(filters[key]);
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(filters[key]) || !Number.isFinite(time)
            || new Date(time).toISOString().slice(0, 16) !== filters[key].slice(0, 16)) {
            throw new TypeError(`${key} must be an ISO UTC time ending in Z`);
        }
    }
    if (filters.since && filters.until && Date.parse(filters.since) > Date.parse(filters.until)) throw new TypeError('Search start must precede end');
    return filters;
}

/** Search message and individual string values recursively under normalized details.
 * Property names, raw JSON syntax and values blocked by AWS policy are excluded.
 * A literal never crosses two values. Unicode uses JavaScript lowercase, without
 * locale, accent folding or regex interpretation. Containers are bounded by line size.
 */
function containsText(entry, needle) {
    if (String(entry.message || '').toLowerCase().includes(needle)) return true;
    const stack = Object.entries(entry.details || {}).filter(([key]) =>
        !['role', 'healthOrganizationId', 'category', 'visibility', 'causesSystemFlow'].includes(key)).map(([, value]) => value);
    while (stack.length) {
        const value = stack.pop();
        if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
        if (value && typeof value === 'object') for (const item of Object.values(value)) stack.push(item);
    }
    return false;
}

/** Validate canonical projections, never raw substring hits or producer source claims. */
function matchesSearch(entry, filters) {
    if (!matches(entry, filters)) return false;
    const time = Date.parse(entry.timestamp || '');
    if (filters.since && (!Number.isFinite(time) || time < Date.parse(filters.since))) return false;
    if (filters.until && (!Number.isFinite(time) || time > Date.parse(filters.until))) return false;
    return !filters.text || containsText(entry, filters.text.toLowerCase());
}

/** Conservative rejection only: escaped JSON/extension/derived records need parsing.
 * IDs are case sensitive; free text is lowercase literal. Unicode and optional
 * slash escapes require parsing; ordinary JSON escapes use the encoded needle.
 */
function candidate(raw, filters, component) {
    if (component.external || raw.includes('\\u') || raw.includes('\\/')) return true;
    for (const key of ['correlationId', 'traceId', 'flowId']) {
        if (filters[key] && !raw.includes(filters[key]) && !raw.includes(JSON.stringify(filters[key]).slice(1, -1))) return false;
    }
    if (!filters.text) return true;
    const lower = raw.toLowerCase();
    return lower.includes(filters.text.toLowerCase()) || lower.includes(JSON.stringify(filters.text.toLowerCase()).slice(1, -1)) || raw.includes('GATEWAY_RESPONSE');
}
module.exports = { FIELDS, LIMITS, validateFilters, matchesSearch, containsText, candidate };
