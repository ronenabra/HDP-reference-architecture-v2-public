'use strict';
/** Translate legacy Admin bookmarks into the existing exact Logs filters. */
const { configuredLogComponents } = require('./log-ordering');
const { managedFhirServers } = require('./data-operations');

/** Preserve supported scalar identity; disclose every omitted legacy constraint.
 * @param {object} input Legacy query, never filesystem input.
 * @param {object} config Current configured source inventory.
 * @returns {object} Central-viewer query and an explicit exact/broader verdict.
 */
function bridge(input = {}, config = {}) {
    const params = new URLSearchParams({ diagnostics: 'true' });
    const omitted = [];
    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'string' || value.length > 256) throw new TypeError(`Invalid diagnostic context: ${key}`);
        if (!value) continue;
        if (['operationId', 'sourceId', 'correlationId'].includes(key)) params.set(key, value);
        else if (key === 'severity') params.set('level', value);
        else if (key === 'component' && configuredLogComponents(config).some(item => item.dir === value)) params.set('source', value);
        else if (key === 'target') {
            const server = managedFhirServers(config).find(item => item.id === value);
            const ho = config.healthOrganizations?.find(item => item.id === value || item.id === server?.healthOrganizationId);
            if (ho && !input.operationId) params.set('healthOrganizationId', ho.id);
            // Operation IDs already identify records across PCM and native components.
            // A target constraint cannot be silently lost, even for a known target.
            else omitted.push(key);
        } else omitted.push(key);
    }
    return { query: '?' + params.toString(), exact: omitted.length === 0,
        notice: omitted.length ? `The central viewer cannot preserve these legacy constraints: ${omitted.join(', ')}. The link below opens broader context using only the supported filters. No event has been selected.`
            : 'Open the exact supported context in Logs with Diagnostics shown. Missing, cleared or unavailable evidence is not replaced by another event.' };
}
module.exports = { bridge };
