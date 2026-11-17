'use strict';
/** Repository-owned clinical query budgets. Missing configuration retains existing defaults. */
const { sourceId } = require('./presence-limits');
const DEFAULTS = Object.freeze({
    maxAllocatedBytes: 268435456,
    timeoutMilliseconds: 10000,
    maxConcurrentQueries: 2,
    maxPageIdVisits: 5000,
    maxPageBodyVisits: 5000,
    maxPageRefills: 32,
    maxPageIncludes: 100,
    maxPagePayloadBytes: 2097152,
    maxCountCandidates: 100000,
    maxCountNativeIdVisits: 2000000,
    maxRetainedSearches: 128,
    searchTtlMilliseconds: 300000,
    maxQueryUriCharacters: 8192,
    maxPrivateAuthorizationBytes: 57344
});
const MINIMA = Object.freeze({
    maxAllocatedBytes: 1,
    timeoutMilliseconds: 1001,
    maxConcurrentQueries: 1,
    maxPageIdVisits: 1,
    maxPageBodyVisits: 1,
    maxPageRefills: 1,
    maxPageIncludes: 1,
    maxPagePayloadBytes: 1,
    maxCountCandidates: 1,
    maxCountNativeIdVisits: 1,
    maxRetainedSearches: 1,
    searchTtlMilliseconds: 1,
    maxQueryUriCharacters: 1,
    maxPrivateAuthorizationBytes: 1
});
const MAXIMA = Object.freeze({
    maxAllocatedBytes: 8589934592,
    timeoutMilliseconds: 300000,
    maxConcurrentQueries: 32,
    maxPageIdVisits: 1000000,
    maxPageBodyVisits: 1000000,
    maxPageRefills: 1024,
    maxPageIncludes: 10000,
    maxPagePayloadBytes: 16777216,
    maxCountCandidates: 1000000,
    maxCountNativeIdVisits: 20000000,
    maxRetainedSearches: 4096,
    searchTtlMilliseconds: 3600000,
    maxQueryUriCharacters: 8192,
    maxPrivateAuthorizationBytes: 57344
});
const FIELDS = Object.freeze([
    ["maxAllocatedBytes", "Cumulative worker allocation", "bytes"],
    ["timeoutMilliseconds", "Query timeout", "milliseconds"],
    ["maxConcurrentQueries", "Concurrent queries", "queries"],
    ["maxPageIdVisits", "Page candidate ID visits", "visits"],
    ["maxPageBodyVisits", "Page resource body visits", "visits"],
    ["maxPageRefills", "Page refill rounds", "rounds"],
    ["maxPageIncludes", "Page includes / outcomes (each)", "entries"],
    ["maxPagePayloadBytes", "Serialized page payload", "bytes"],
    ["maxCountCandidates", "Exact count candidates / stream visits", "candidates"],
    ["maxCountNativeIdVisits", "Exact count aggregate native ID visits", "visits"],
    ["maxRetainedSearches", "Retained searches", "searches"],
    ["searchTtlMilliseconds", "Search lifetime from creation", "milliseconds"],
    ["maxQueryUriCharacters", "Query URI length", "characters"],
    ["maxPrivateAuthorizationBytes", "Private authorization token", "bytes"]
].map(([key, label, unit]) => Object.freeze({ key, label, unit, scale: 1, minimum: MINIMA[key], maximum: MAXIMA[key] })));
/** Validate a closed partial row, including exact integer units and finite transport bounds. */
function validateRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('Invalid clinical query limits row');
    for (const [key, value] of Object.entries(row)) {
        if (!Object.hasOwn(DEFAULTS, key) || !Number.isSafeInteger(value) || value < MINIMA[key] || value > MAXIMA[key]) throw new TypeError(`Invalid finite clinical query limit ${key}`);
    }
}
/** Resolve one immutable snapshot using the already parsed configuration and registered identity. */
function clinicalQueryLimits(config = {}, selector = {}) {
    const offset = config.runtime?.queryLimitsRevisionOffset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (config.runtime?.revision ?? 0)) throw new TypeError('Invalid query limits revision offset');
    const block = config.clinicalQuery;
    if (block !== undefined) {
        if (!block || typeof block !== 'object' || Array.isArray(block) || Object.keys(block).some(key => !['defaults', 'sources'].includes(key))) throw new TypeError('Invalid clinicalQuery block');
        if (block.defaults !== undefined) validateRow(block.defaults);
        if (block.sources !== undefined && (!block.sources || typeof block.sources !== 'object' || Array.isArray(block.sources))) throw new TypeError('Invalid clinical query sources');
        const registered = new Set((config.healthOrganizations || []).map(source => source.id));
        for (const [id, row] of Object.entries(block.sources || {})) {
            if (!registered.has(id)) throw new TypeError(`Unknown managed clinical query source ${id}`);
            validateRow(row);
        }
    }
    return Object.freeze({ ...DEFAULTS, ...block?.defaults, ...block?.sources?.[sourceId(config, selector)] });
}
module.exports = { DEFAULTS, MINIMA, MAXIMA, FIELDS, clinicalQueryLimits };
