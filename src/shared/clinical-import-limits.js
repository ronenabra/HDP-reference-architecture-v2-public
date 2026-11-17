'use strict';

/** Shared ceilings for synthetic clinical transaction imports and generated team configurations. */
const CONFIG_MINIMA = Object.freeze({ maxBytes: 27_465_318, maxEntries: 7_155 });
const DEFAULT_LIMITS = Object.freeze({ maxBytes: 768 * 1024 * 1024, maxEntries: 200_000 });

/** Format a byte ceiling in decimal megabytes (1 MB = 1,000,000 bytes), retaining exact bytes. */
function formatByteLimit(bytes) {
    const mb = Number((bytes / 1000000).toPrecision(4));
    return `${mb} MB (${bytes} bytes)`;
}

/** Validate integer ceilings at the shared Admin/CLI bundle boundary.
 * Configuration must support the reviewed candidate; small explicit test/work budgets
 * remain valid for individual bundle inspection.
 * @param {object} limits Explicit byte and entry ceilings.
 * @param {object} options Whether to require canonical configuration minima.
 * @returns {object} The validated ceilings; invalid values throw before parsing.
 */
function validateImportLimits(limits, { configuration = false } = {}) {
    for (const key of ['maxBytes', 'maxEntries']) {
        const minimum = configuration ? CONFIG_MINIMA[key] : 1;
        if (!Number.isSafeInteger(limits?.[key]) || limits[key] < minimum) throw new TypeError(`${key} must be a safe integer of at least ${minimum}`);
    }
    return limits;
}
module.exports = { CONFIG_MINIMA, DEFAULT_LIMITS, validateImportLimits, formatByteLimit };
