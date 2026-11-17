'use strict';

/** Custom-source commands reuse configuration, private lifecycle and synchronous store owners. */
const fs = require('node:fs'), path = require('node:path');
const { getConfiguredDataSources } = require('./data-sources');
const { isOpaqueClientId } = require('../../shared/pcm-contract');
const { publishFiles } = require('../../shared/role-credentials');
const { validateServerCa } = require('./source-credentials');

/** Reject traversal/symlinks and allow only an existing managed certificate reference.
 * @param {string} directory Backend certificate directory.
 * @param {string} name Managed relative certificate name.
 * @returns {Buffer} Public CA certificate bytes.
 */
function managedCertificate(directory, name) {
    if (typeof name !== 'string' || !/^(?:custom\/)?[A-Za-z0-9._-]+\.crt$/.test(name)) throw new Error('Choose a managed CA certificate reference');
    const target = path.join(directory, name), base = fs.realpathSync(directory);
    if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target || !target.startsWith(base + path.sep)) throw new Error('CA reference must be a regular managed certificate file');
    return fs.readFileSync(target);
}

/** Validate a new/edited source before files, configuration or registrations are published.
 * @param {object} options Candidate/previous source, config, staged material and owning store.
 * @returns {object} The validated candidate source; throws before publication on failure.
 */
function validateSource({ config, source, previous, directory, material = {}, store }) {
    if (!source.name?.trim() || source.name.length > 240) throw new Error('Source name is required and must be at most 240 characters');
    const endpoint = require('../../shared/outbound-destination').parseOutboundUrl(source.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('FHIR base must be an HTTPS URL without credentials, query or fragment');
    if (!['hmo','hospital','other'].includes(source.institutionType)) throw new Error('Institution type must be HMO, Hospital or Other');
    if (!isOpaqueClientId(source.clientId) || [source.id, source.businessIdentifier?.value].includes(source.clientId)) throw new Error('Client ID must be an opaque assigned identifier independent of Organization identity');
    if (previous && [source.id !== previous.id, source.clientId !== previous.clientId, source.parentId !== previous.parentId, source.endpointId !== previous.endpointId].some(Boolean)) throw new Error('Existing source identities cannot be replaced by an edit');
    const ids = getConfiguredDataSources(config, { includeDisabled: true });
    const clients = [...ids, ...Object.values(config.organizations || {}).filter(value => value && !Array.isArray(value)), ...Object.values(config.oauthClients || {})];
    if (clients.some(item => item.id !== source.id && item.clientId === source.clientId)) throw new Error('Client ID is already registered');
    if ((config.organizations.removedDataSourceRegistrations || []).some(item => item.clientId === source.clientId || item.id === source.id)) throw new Error('Historical source identity cannot be reused');
    for (const [identity, value] of Object.entries(store.privateRecords?.state?.provisioning || {})) {
        if (identity !== `Organization/${source.id}` && value.sourceRegistration?.clientId === source.clientId) throw new Error('Client ID belongs to a historical source registration and cannot be reused');
    }
    const trust = source.serverTrust || {};
    if (!['team-root-ca','system-ca','custom-ca','pinned-thumbprint','insecure-skip-verify'].includes(trust.mode)) throw new Error('Unsupported source HTTPS trust mode');
    if (trust.mode === 'insecure-skip-verify' && !['connectathon-easy','connectathon-balanced'].includes(config.conformance.preset)) throw new Error('Skip verification is unavailable in this security preset');
    if (trust.mode === 'custom-ca' && !trust.caCert) throw new Error('Choose the source HTTPS server CA before saving custom CA trust');
    // Even inactive fields may reach protected exports; every retained reference
    // must identify public CA material, never an authority signing key.
    if (trust.caCert) validateServerCa(material[trust.caCert] || managedCertificate(directory, trust.caCert));
    if (trust.mode === 'pinned-thumbprint' && !/^[A-Za-z0-9_-]{43}$/.test(trust.certThumbprint || '')) throw new Error('Server pin must be a 43-character base64url SHA-256 fingerprint');
    return source;
}

/** Only custom non-seed registrations may be edited or removed by this command.
 * @param {object} config Current validated configuration.
 * @param {string} id Exact registered source Organization identity.
 * @returns {object} The owned custom registration, or throws for missing/seed identities.
 */
function customSource(config, id) {
    const source = config.organizations?.dataSources?.find(item => item.id === id);
    if (!source) throw Object.assign(new Error('Custom source was not found; refresh Sources'), { status: 404 });
    if (id === config.organizations?.teamDataSource?.id) throw Object.assign(new Error('This seed-backed team source is operator-controlled; registration removal or identity editing would be unsafe'), { status: 409 });
    return source;
}

/** Publish files/config/public registration together, retaining historical references and private tombstones.
 * No network/remote data mutation occurs. A checkpoint uncertainty keeps its existing maintenance fence.
 * @param {object} options Exact source/config/file/store owners and the config publisher.
 * @param {string} lock Existing private configuration mutex directory.
 * @returns {object} Saved source and successful public/private revision facts.
 */
function publishSourceLocked({ config, source, previous, material = {}, action = 'save', directory, store, expectedRevision, saveConfig, configPath }, lock) {
    if (String(expectedRevision) !== String(Number(config.runtime.revision) || 0)) throw Object.assign(new Error('Source settings changed. Refresh and review the current source before saving'), { status: 409 });
    const priorConfig = fs.readFileSync(configPath), next = structuredClone(config);
    if (action === 'remove' && previous?.enabled !== false) throw Object.assign(new Error('Disable this source before removing its registration. Historical Consent references and remote data are retained'), { status: 409 });
    const sources = next.organizations.dataSources || [];
    next.organizations.dataSources = action === 'remove' ? sources.filter(item => item.id !== source.id)
        : [...sources.filter(item => item.id !== source.id), source];
    if (action === 'remove') next.organizations.removedDataSourceRegistrations = [...(next.organizations.removedDataSourceRegistrations || []),
        { id: source.id, clientId: source.clientId, endpointId: source.endpointId }];
    next.runtime.revision = (Number(config.runtime.revision) || 0) + 1;
    next.runtime.updatedAt = new Date().toISOString(); next.runtime.lastChangeReason = `source-registration-${action}`;
    const stateDirectory = process.env.STATE_DIR || config.runtime.stateDir;
    const recovery = require('./source-publication-recovery');
    const staged = recovery.begin({ lock, configPath, directory, stateDirectory, material, nextConfig: next, sourceId: source.id });
    const stateBefore = store.privateRecords.state.revision;
    const publication = () => store.transaction(() => {
        // Source resources remain as inactive historical facts on disable/removal.
        if (!previous) require('./data-sources').syncDataSourcesToStore(store, next, null, { preserveExisting: true });
        const organization = store.get('Organization', source.id), endpoint = store.get('Endpoint', source.endpointId);
        if (!organization || !endpoint) throw new Error('Source registration graph is unavailable; preserve the configuration and reconcile its owner');
        const active = action !== 'remove' && source.enabled !== false;
        const changed = { ...organization, name: source.name, active };
        store.privateRecords.lifecycle.command({ type: 'Organization', id: source.id, resource: changed,
            event: { kind: `source-registration-${action}`, at: new Date().toISOString(), sourceId: source.id },
            state: { sourceRegistrationRemoved: action === 'remove' }, expectedRevision: store.privateRecords.state.revision,
            expectedVersions: { [`Organization/${source.id}`]: organization.meta.versionId } });
        store.update({ ...endpoint, address: source.endpoint, status: active ? 'active' : 'off' });
        const current = store.get('Organization', source.id);
        const provisioning = store.privateRecords.provisioning.get('Organization', source.id) || {};
        store.privateRecords.provisioning.put({ type: 'Organization', id: source.id,
            value: { ...provisioning, sourceRegistration: { clientId: source.clientId, removed: action === 'remove' } },
            expectedRevision: store.privateRecords.state.revision, expectedVersions: { [`Organization/${source.id}`]: current.meta.versionId } });
        // Every credential/trust/availability change fences outstanding operations and grants.
        store.authorityState.advance(`Organization/${source.id}`);
        const result = saveConfig(next);
        for (const file of [configPath, path.dirname(configPath)]) { const descriptor = fs.openSync(file, 'r'); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
        return result;
    });
    try { publishFiles(directory, material, publication); }
    catch (error) {
        // Config publication can fail after rename (for example checkpoint IO). Restore
        // original bytes; the checkpoint owner's uncertainty journal/fence is preserved.
        if (!fs.readFileSync(configPath).equals(priorConfig)) fs.writeFileSync(configPath, priorConfig);
        if (fs.existsSync(path.join(stateDirectory, 'pcm-ig-041', 'checkpoint-mutation.json'))) {
            error.status = 503;
            error.message += '; source publication is uncertain and fenced. Stop workers, review configuration-mutation/source-publication.json, then use recover-mutation with its exact digest for coherent rollback';
        } else {
            recovery.recover({ stateDirectory, configPath, certsDirectory: directory, workersStopped: true, expectedDigest: require('../../shared/migration-hash').hash(staged.journal), retainLock: true });
        }
        throw error;
    }
    fs.rmSync(staged.file);
    return { source, revision: next.runtime.revision, privateRevision: store.privateRecords.state.revision, previousPrivateRevision: stateBefore };
}
/** Serialize staging, publication and any immediate rollback in the existing configuration mutex.
 * @param {object} options Owned publication inputs; no browser-provided filesystem paths.
 * @returns {object} Publication result after every owning boundary commits.
 */
function publishSource(options) {
    const maintenance = require('../../shared/migration-maintenance');
    const directory = process.env.STATE_DIR || options.config.runtime.stateDir;
    maintenance.assertAvailable(directory);
    return maintenance.withConfigurationMutation(directory, lock => publishSourceLocked(options, lock));
}
module.exports = { managedCertificate, validateSource, customSource, publishSource };
