'use strict';
/** Validate ordinary configuration restore against the current live owner's boundaries. */
const fs = require('node:fs');
const path = require('node:path');
const MAX_BACKUP_BYTES = 1024 * 1024;
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => require('node:util').isDeepStrictEqual(a, b);

/** Refuse generic reset/restore of retained checkpoint authority before any mutation. */
function assertOrdinaryRuntime(config) {
    const directory = process.env.STATE_DIR || config.runtime.stateDir;
    require('../../shared/migration-maintenance').assertAvailable(directory);
    require('../../shared/migration-maintenance').assertOperationsIdle(directory);
    if (fs.existsSync(path.join(directory, 'pcm-ig-041', 'manifest.json'))) throw failure('This runtime has a migration checkpoint. Keep workers stopped and use the reviewed migration restore/recovery workflow; ordinary reset/restore cannot discard retained restrictions.', 409);
}

/** Parse either browser input alternative or the ordinary API envelope without echoing secrets.
 * @param {object} body Request body, optionally wrapping backupJson and expectedRevision.
 * @param {object} current Current validated configuration.
 * @param {object} certificates Current backend-owned certificate inventory and exact contents.
 * @returns {object} Complete validated, live-compatible candidate configuration.
 */
function validateRestore(body, current, certificates) {
    let payload;
    try {
        const raw = typeof body?.backupJson === 'string' ? body.backupJson : JSON.stringify(body);
        if (Buffer.byteLength(raw || '', 'utf8') > MAX_BACKUP_BYTES) throw failure('Backup exceeds the 1 MiB restore limit. Select an ordinary configuration backup within this limit.', 413);
        payload = JSON.parse(raw);
    } catch (error) {
        if (error.statusCode) throw error;
        throw failure('Backup is not valid JSON. Select or paste the complete ordinary configuration backup.');
    }
    if (!object(payload) || payload.schema || !object(payload.teamConfig) || !object(payload.certificates)
        || Object.keys(payload).some(key => !['teamId', 'exportedAt', 'security', 'teamConfig', 'certificates', 'thumbprints', 'expectedRevision'].includes(key))) throw failure('Wrong backup scope. Use the complete configuration and credential export; clinical, log and private checkpoint exports use their own recovery workflow.');
    const candidate = payload.teamConfig;
    if (payload.teamId !== current.teamId || candidate.teamId !== current.teamId) throw failure('Backup belongs to another team. Select this team’s configuration backup.');
    if (candidate.configVersion !== current.configVersion) throw failure('Backup configuration version differs. Use the reviewed offline team migration workflow.', 409);
    if (String(body?.expectedRevision) !== String(current.runtime.revision || 0)) throw failure('Saved configuration changed since this page was reviewed. Reload Maintenance and select the backup again.', 409);
    try {
        require('../../shared/team-config-validator').assertValidTeamConfig(candidate, { env: process.env });
        require('../../shared/source-registration-history').validateSourceRegistrationHistory(candidate, current);
    } catch (_) { throw failure('Backup configuration is invalid or would discard a later source removal. Reconcile it with the current configuration owner before restoring.'); }
    // A running UI cannot recreate deployment listeners or publish another team's material.
    const fields = ['publicBaseUrls', 'internalBaseUrls', 'ports', 'certificates', 'certificateRoles', 'oauthClients', 'contract', 'conformance'];
    // Managed database/listener/import ownership is deployment-controlled. Only
    // its existing limits/bootstrap settings may participate in live config restore.
    const managedBindings = value => value.healthOrganizations.map(ho => {
        const { limits, bootstrap, ...clinical } = ho.clinicalData;
        return { ...ho, clinicalData: clinical };
    });
    const registrationBindings = value => {
        const { dataSources = [], removedDataSourceRegistrations, ...organizations } = value.organizations;
        return { organizations, sources: dataSources.map(source => ({ id: source.id, clientId: source.clientId,
            endpointId: source.endpointId, organization: source.organization, pcmClientAuth: source.pcmClientAuth })).sort((a, b) => a.id.localeCompare(b.id)) };
    };
    if (fields.some(key => !equal(candidate[key], current[key])) || !equal(managedBindings(candidate), managedBindings(current))
        || !equal(registrationBindings(candidate), registrationBindings(current))
        || ['stateDir', 'certsDir', 'logsDir'].some(key => candidate.runtime[key] !== current.runtime[key])) throw failure('Backup changes deployment, listener, preset or credential bindings. No files changed. Use the controlled stopped-team operator workflow in retained-team-migration.md before publication and recreation.', 409);
    if (!equal(Object.keys(payload.certificates).sort(), Object.keys(certificates).sort())
        || Object.entries(payload.certificates).some(([name, content]) => typeof content !== 'string' || certificates[name] !== content)) throw failure('Backup credential files differ from the running team. No files changed. Review the protected credential export and controlled stopped-team renewal/recreation workflow before publishing changed material.', 409);
    return structuredClone(candidate);
}
module.exports = { MAX_BACKUP_BYTES, assertOrdinaryRuntime, validateRestore };
