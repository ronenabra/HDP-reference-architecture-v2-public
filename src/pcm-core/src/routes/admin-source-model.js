'use strict';
/** Project registered sources into presentation capabilities without granting authority. */
const views = Object.freeze({ registration: 'Registration', trust: 'HTTPS trust', credentials: 'PCM credentials',
    data: 'Clinical data', limits: 'Limits & capabilities', diagnostics: 'Diagnostics', mappings: 'Identity mappings', upstream: 'Custom upstream' });

/** Resolve hosting from registry ownership and managed targets, never institution type.
 * @param {object[]} sources Registered sources, including disabled entries.
 * @param {object[]} servers Existing managed private targets.
 * @returns {object[]} Non-authoritative display facts and applicable views.
 */
function sourceDirectory(sources, servers) {
    return sources.map(source => {
        const server = servers.find(item => item.healthOrganizationId === source.healthOrganizationId);
        const hosting = source.compatibilityOnly || (source.builtIn && !source.healthOrganizationId) ? 'legacy'
            : source.builtIn && source.healthOrganizationId !== 'legacy-ds' ? 'managed' : 'custom';
        const available = source.enabled !== false && Boolean(source.endpoint);
        const tabs = ['registration', 'trust', 'credentials', ...(server ? ['data'] : []), 'limits', 'diagnostics',
            ...(hosting === 'legacy' ? ['mappings', 'upstream'] : [])];
        return { ...source, hosting, server, available, tabs, role: 'Data source',
            capability: hosting === 'legacy' ? 'Identity compatibility; clinical access unsupported'
                : server ? 'Managed clinical import and deletion' : hosting === 'managed' ? 'Configured managed source; local data operations unavailable' : 'External clinical endpoint; no local import or deletion',
            status: source.enabled === false ? 'Disabled · runtime not checked' : !source.endpoint ? 'Unavailable · endpoint missing' : 'Configured · runtime not checked' };
    });
}

/** Select exactly the registered identity without replacing unknown sources.
 * @param {object} req Current source/view query.
 * @param {object[]} rows Projected registered source directory.
 * @returns {object} Selected source and a bounded view, or no selected source.
 */
function sourceWorkspace(req, rows) {
    const sourceId = typeof req?.query?.source === 'string' ? req.query.source : '';
    const selected = rows.find(row => row.id === sourceId);
    const requested = typeof req?.query?.view === 'string' ? req.query.view : 'registration';
    return { selected, view: selected?.tabs.includes(requested) ? requested : 'registration',
        invalidView: Boolean(selected && !selected.tabs.includes(requested)), sourceId };
}
module.exports = { views, sourceDirectory, sourceWorkspace };
