'use strict';

/** Private restart checkpoint owned by FHIRStore; never contains tokens or HO clinical data. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertAvailable, assertOperationsIdle, fencePath } = require('../../shared/migration-maintenance');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Durably replace a regular file on the same filesystem; bind-mount fallbacks are prohibited. */
function atomicWrite(file, bytes) {
    const temporary = `${file}.pcm041-${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

/** Return exact stored FHIR JSON without introducing server metadata changes. */
function snapshot(store, { privateState = false } = {}) {
    const resources = Object.fromEntries(Object.keys(store.data).map(type => [type, store.getAll(type)]));
    return privateState ? { ...resources, _private: require('./private-records').exportState(store) } : resources;
}

/** Validate in isolation, preserving private authority or starting a fresh legacy epoch; never extract automatically. */
function hydrate(store, resources, { rollback = false } = {}) {
    const data = store.emptyData();
    if (!resources || Object.keys(resources).filter(name => name !== '_private').sort().join('|') !== Object.keys(data).sort().join('|')) throw new Error('Checkpoint must contain all five resource types');
    for (const [type, values] of Object.entries(resources).filter(([type]) => type !== '_private')) {
        if (!data[type] || !Array.isArray(values)) throw new Error(`Invalid checkpoint resource type ${type}`);
        for (const value of values) {
            if (value.resourceType !== type || !value.id || data[type].has(value.id)) throw new Error('Invalid/duplicate checkpoint resource identity');
            data[type].set(value.id, structuredClone(value));
        }
    }
    const privateModule = require('./private-records');
    const privateState = resources._private ? privateModule.validateState(resources._private, resources) : privateModule.emptyState();
    // Legacy resource-only checkpoints remain readable without automatic extraction.
    for (const resource of resources.Consent) require('../../shared/consent-scope-snapshot').readApprovalSnapshot(resource);
    const authority = new (require('./grant-authority-state').GrantAuthorityState)();
    if (resources._private) {
        authority.epoch = privateState.authority.epoch;
        authority.generations = new Map(Object.entries(privateState.authority.generations));
        authority.configuration = new Map(Object.entries(privateState.authority.configuration));
        delete privateState.authority;
    }
    if (!rollback) privateModule.assertRestrictionsPreserved(store, { privateState, authorityState: authority });
    store.data = data; store.privateState = privateState; store.authorityState = authority;
}

/** Persist every committed mutation; disk failure restores in-memory state and authority generations. */
function attach(store, stateDirectory) {
    if (store.migrationCheckpointAttached) return;
    store.migrationCheckpointAttached = true;
    let depth = 0;
    for (const method of ['add', 'create', 'update', 'remove', 'transaction', 'clear', 'reset']) {
        const original = store[method];
        store[method] = function (...args) {
            if (depth) return original.apply(this, args);
            assertAvailable(stateDirectory);
            if (fs.existsSync(path.join(stateDirectory, 'pcm-ig-041', 'checkpoint-mutation.json'))) throw new Error('Checkpoint mutation uncertain: stop workers and review recovery');
            const before = snapshot(this, { privateState: true }), authority = this.authorityState;
            const generations = new Map(authority.generations), configuration = new Map(authority.configuration);
            depth++;
            let publication;
            try {
                const result = original.apply(this, args);
                const root = path.join(stateDirectory, 'pcm-ig-041'), bytes = encode(snapshot(this, { privateState: true }));
                const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
                publication = { schema: 'pcm-checkpoint-mutation/1', before: encode(before).toString('base64'), after: bytes.toString('base64'), manifest };
                atomicWrite(path.join(root, 'checkpoint-mutation.json'), encode(publication));
                atomicWrite(path.join(root, 'checkpoint.json'), bytes);
                atomicWrite(path.join(root, 'manifest.json'), encode({ ...manifest, checkpointHash: sha256(bytes) }));
                fs.rmSync(path.join(root, 'checkpoint-mutation.json'));
                this.flushDiagnostics();
                return result;
            } catch (error) {
                this._diagnostics = [];
                hydrate(this, before, { rollback: true }); this.authorityState = authority;
                Object.assign(authority, { generations, configuration });
                if (publication) {
                    // A crash between the two publications has an explicit, reviewed roll-forward recovery.
                    // Keep all runtime entries unavailable rather than silently using rolled-back memory.
                    try { fs.writeFileSync(fencePath(stateDirectory), 'Checkpoint mutation uncertain; stop workers and review checkpoint-mutation.json before recover-mutation', { mode: 0o600 }); } catch (_) { /* The durable mutation journal independently blocks restart. */ }
                    error.message += '; checkpoint publication uncertain: stop workers, review checkpoint-mutation.json, then use reconcile-pcm-handoff recover-mutation with its exact digest';
                }
                throw error;
            } finally { depth--; }
        };
    }
}

/** Explicit online checkpoint freezes PCM before the operator stops all team workers. */
function prepare({ store, configPath, stateDirectory, runtimeId }) {
    return require('../../shared/migration-maintenance').withConfigurationMutation(stateDirectory, () => prepareFrozen({ store, configPath, stateDirectory, runtimeId }));
}

/** Capture while the configuration writer mutex is held, then retain the maintenance fence. */
function prepareFrozen({ store, configPath, stateDirectory, runtimeId }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(runtimeId || '')) throw new Error('Set PCM_MIGRATION_RUNTIME_ID to the actual immutable image/source artifact SHA256 before checkpoint');
    assertAvailable(stateDirectory);
    assertOperationsIdle(stateDirectory);
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(fencePath(stateDirectory), runtimeId, { flag: 'wx', mode: 0o600 });
    try {
        assertOperationsIdle(stateDirectory);
        const root = path.join(stateDirectory, 'pcm-ig-041'); fs.mkdirSync(root, { recursive: true });
        const manifestPath = path.join(root, 'manifest.json');
        const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath)) : null;
        if (existing && !['applied', 'rolled-back'].includes(existing.phase)) throw new Error('Existing migration requires explicit recovery');
        const checkpoint = encode(snapshot(store, { privateState: true }));
        atomicWrite(path.join(root, 'checkpoint.json'), checkpoint);
        const manifest = { schema: 'pcm-migration/1', phase: 'prepared', runtimeId, configHash: sha256(fs.readFileSync(configPath)), checkpointHash: sha256(checkpoint), previous: existing };
        atomicWrite(manifestPath, encode(manifest));
        attach(store, stateDirectory);
        return { phase: manifest.phase, scope: Object.keys(store.data), privateSchema: 'pcm-private-state/1', publicProjectionSchema: require('./public-fhir').SCHEMA, previewRequired: true, configHash: manifest.configHash, checkpointHash: manifest.checkpointHash, runtimeId, next: 'Stop PCM, SP, adapters and all import/maintenance workers. Preview offline; do not restart before apply/recovery.' };
    } catch (error) { fs.rmSync(fencePath(stateDirectory), { force: true }); throw error; }
}

/** Validate the complete publication before any caller may hydrate or bootstrap. */
function readCheckpoint({ configPath, stateDirectory, runtimeId, required = false }) {
    const root = path.join(stateDirectory, 'pcm-ig-041'), file = path.join(root, 'manifest.json');
    if (!fs.existsSync(file)) {
        if (required || runtimeId) throw new Error('Authoritative migration handoff missing: keep original unbridged process running; use reviewed reconcile-handoff before replacement. Seeds cannot recover retained authority');
        return null;
    }
    const manifest = JSON.parse(fs.readFileSync(file));
    if (manifest.schema !== 'pcm-migration/1') throw new Error('Invalid migration manifest schema');
    if (!['applied', 'rolled-back'].includes(manifest.phase) || fs.existsSync(path.join(root, 'journal.json')) || fs.existsSync(path.join(root, 'checkpoint-mutation.json')) || fs.existsSync(fencePath(stateDirectory))) throw new Error('Migration incomplete: keep team stopped and use --recover');
    if (!/^sha256:[a-f0-9]{64}$/.test(runtimeId || '') || runtimeId !== manifest.runtimeId) throw new Error(`Migration runtime mismatch: start matching immutable runtime ${manifest.runtimeId}`);
    if (sha256(fs.readFileSync(configPath)) !== manifest.configHash) throw new Error('Migration config/checkpoint mismatch; restore matching reviewed config or checkpoint again before restart');
    const bytes = fs.readFileSync(path.join(root, 'checkpoint.json'));
    if (sha256(bytes) !== manifest.checkpointHash) throw new Error('Migration checkpoint hash mismatch; preserve original authority and reconcile reviewed handoff');
    if (manifest.metadataBoundary) {
        require('../../shared/public-metadata-compatibility').assertArtifacts(manifest.metadataBoundary);
        const usageRoot = path.join(stateDirectory, 'first-use-windows') + path.sep;
        for (const [file, expected] of Object.entries(manifest.preservedStateFiles || {})) {
            if (file.startsWith(usageRoot) && (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected)) throw new Error('Original first-use bytes missing/changed; keep stopped and recover matching usage owner without resetting clocks');
        }
    }
    if (manifest.scopeBoundary) require('../../shared/scope-model-versions').assertScopeVersions(manifest.scopeBoundary.versions);
    const resources = JSON.parse(bytes);
    // Validate in isolation: partial/malformed checkpoints cannot mutate the live owner.
    const candidate = new (require('./fhir/store').FHIRStore)();
    hydrate(candidate, resources);
    if (manifest.handoff) {
        const { hash } = require('../../shared/migration-hash');
        const review = JSON.parse(fs.readFileSync(path.join(root, 'handoff-review.json')));
        const observation = JSON.parse(fs.readFileSync(path.join(root, 'handoff-observation.json')));
        if (manifest.handoff.schema !== 'pcm-reconciled-handoff/1' || !manifest.handoff.reviewedBy || !manifest.handoff.inventoryHash
            || review.approved !== true || review.schema !== 'pcm-handoff-review/1' || hash(review) !== manifest.handoff.reviewHash
            || hash(observation) !== manifest.handoff.observationHash || review.inventoryHash !== manifest.handoff.inventoryHash) throw new Error('Unapproved reconciliation handoff');
    }
    return resources;
}

/** Load only a completed, matching runtime/config publication; fresh non-migration startup remains supported. */
function restore(options) {
    const resources = readCheckpoint(options);
    if (!resources) return false;
    hydrate(options.store, resources);
    attach(options.store, options.stateDirectory);
    return true;
}

/** Keep supported config saves restartable without weakening the rollback hash fence. */
function recordConfig(stateDirectory, configPath) {
    const file = path.join(stateDirectory || '', 'pcm-ig-041', 'manifest.json');
    if (!stateDirectory || !fs.existsSync(file)) return;
    const manifest = JSON.parse(fs.readFileSync(file));
    if (['applied', 'rolled-back'].includes(manifest.phase)) atomicWrite(file, encode({ ...manifest, configHash: sha256(fs.readFileSync(configPath)) }));
}

/** Fence every public/runtime entry while the durable checkpoint is being migrated. */
function middleware(req, res, next) {
    try {
        const config = require('./team-config').loadTeamConfig();
        assertAvailable(process.env.STATE_DIR || config.runtime.stateDir); next();
    } catch (error) { res.status(503).json({ error: error.message }); }
}

/** Read only non-secret observed checkpoint status for the existing maintenance interface. */
function observedStatus(stateDirectory) {
    const root = path.join(stateDirectory, 'pcm-ig-041'), file = path.join(root, 'manifest.json');
    if (!fs.existsSync(file)) return { phase: 'No migration checkpoint', scope: Object.keys(new (require('./fhir/store').FHIRStore)().data) };
    try {
        const manifest = JSON.parse(fs.readFileSync(file));
        return { phase: fs.existsSync(path.join(root, 'journal.json')) ? 'Interrupted publication — keep workers stopped; recover the journal' : manifest.phase,
            scope: ['Organization', 'Endpoint', 'HealthcareService', 'Consent', 'Contract'],
            runtimeId: /^sha256:[a-f0-9]{64}$/.test(manifest.runtimeId || '') ? manifest.runtimeId : 'Unavailable',
            privateSchema: manifest.metadataBoundary?.privateSchema || 'Not yet qualified',
            publicProjectionSchema: manifest.metadataBoundary?.publicProjectionSchema || 'Not yet qualified',
            summary: manifest.metadataSummary || null };
    } catch { return { phase: 'Unreadable checkpoint — preserve state and reconcile', scope: [] }; }
}

/** Migration epochs invalidate the old deterministic Admin cookie without changing its password. */
function sessionEpoch(stateDirectory) {
    const file = path.join(stateDirectory || process.env.STATE_DIR || '/runtime/state', 'pcm-ig-041', 'manifest.json');
    if (!fs.existsSync(file)) return '';
    const manifest = JSON.parse(fs.readFileSync(file));
    return `:${manifest.credentialEpoch || manifest.previous?.credentialEpoch || 'checkpoint'}`;
}

module.exports = { atomicWrite, attach, encode, hydrate, middleware, observedStatus, prepare, readCheckpoint, recordConfig, restore, sessionEpoch, sha256, snapshot };
