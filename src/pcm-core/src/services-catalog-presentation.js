'use strict';
/** Read-only catalog wording derived from exact saved authority, never generator buckets. */
const { inspectScope } = require('../../shared/service-grant');
const { UNITS } = require('./service-definition-form');

/** Describe one protected definition without claiming that a service grants clinical access.
 * @param {object} row Exact versioned protected catalog item.
 * @returns {object} Item plus concise scope, lifecycle and period presentation.
 */
function catalogRow(row) {
    const grant = row.definition?.status === 'ok' && row.definition.grant;
    let access = 'Saved scope unavailable — access cannot be established.';
    if (grant) {
        const parsed = inspectScope(grant.scope), clauses = parsed.clauses;
        if (Object.values(parsed.diagnostics).some(value => value === 'invalid' || value === 'unsupported')) access = 'Experimental scope — runtime authority unavailable. Review exact text.';
        else {
            const types = [...new Set(clauses.map(clause => clause.type))];
            const actions = new Set(clauses.flatMap(clause => [...clause.actions]));
            const verb = actions.has('r') && actions.has('s') ? 'Read and search' : actions.has('s') ? 'Search' : 'Read';
            access = grant.scope === 'patient/*.rs' ? 'All supported patient data · read/search' : `${verb}: ${types.slice(0, 3).join(', ')}${types.length > 3 ? ` and ${types.length - 3} more resource types` : ''}. ${clauses.some(clause => clause.filters.length) ? 'Saved filters apply.' : 'No scope predicates.'}`;
        }
    }
    const next = ({ pending: 'activate', active: 'disable', frozen: 'enable' })[row.state];
    const input = grant?.authoring;
    return { ...row, name: row.name || 'Unnamed service', access,
        stateLabel: ({ pending: 'Pending approval', active: 'Active', frozen: 'Disabled / frozen', suspended: 'Suspended', rejected: 'Rejected', cancelled: 'Ended' })[row.state] || 'Unknown',
        next, nextLabel: ({ activate: 'Approve', disable: 'Disable', enable: 'Enable' })[next],
        period: input ? `${input.duration} ${UNITS[input.durationUnit] || input.durationUnit}; ${input.accessMode === 'one-time' ? 'one hour from first use per client/source' : 'ongoing within the approved period'}` : 'Not available' };
}
module.exports = { catalogRow };
