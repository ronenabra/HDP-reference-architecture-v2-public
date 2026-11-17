'use strict';
/** Private backup/candidate primitives; coordinated offline apply remains the migration owner's job. */
const crypto = require('node:crypto');
const checkpoint = require('./migration-checkpoint');
const { FHIRStore } = require('./fhir/store');
const { assertRestrictionsPreserved, PrivateRecordError, SCHEMA } = require('./private-records');
const SCHEMA_VERSION = 'pcm-public-metadata-migration/1';
const COMPONENTS = ['pcm', 'doctor', 'adapter', 'native', 'cli'];
const BINDINGS = ['config', 'certificates', 'catalog', 'firstUse', 'operations'];
const digest = value => checkpoint.sha256(checkpoint.encode(value));
/** Require the complete component/scope/config and external usage inventory, never guessed compatibility. */
function validateCompatibility(value) {
    if (value?.privateSchema !== SCHEMA || typeof value.publicProjectionSchema !== 'string' || !value.publicProjectionSchema) throw new PrivateRecordError('Incompatible private/projection version', 'unsupported-version');
    for (const component of COMPONENTS) if (!/^sha256:[a-f0-9]{64}$/.test(value.components?.[component] || '')) throw new PrivateRecordError(`Missing immutable component ${component}`, 'invalid');
    require('../../shared/scope-model-versions').assertScopeVersions(value.scopeVersions);
    for (const field of BINDINGS) if (!/^[a-f0-9]{64}$/.test(value.bindings?.[field] || '')) throw new PrivateRecordError(`Missing checkpoint binding ${field}`, 'invalid');
}
/** Export detached public/private state; tokens/codes/caches/HO data/usage files are deliberately absent. */
function exportPrivateCheckpoint(store, compatibility) {
    validateCompatibility(compatibility);
    const state = checkpoint.snapshot(store, { privateState: true });
    checkpoint.hydrate(new FHIRStore(), state);
    const payload = { schema: SCHEMA_VERSION, compatibility: structuredClone(compatibility), state };
    return { ...payload, hash: digest(payload) };
}
/** Validate in isolation with exact current component and external-state bindings. */
function validateCandidate(candidate, compatibility) {
    validateCompatibility(compatibility);
    const { hash, ...payload } = candidate || {};
    if (payload.schema !== SCHEMA_VERSION || digest(payload) !== hash) throw new PrivateRecordError('Private backup hash/schema mismatch', 'invalid');
    if (JSON.stringify(payload.compatibility) !== JSON.stringify(compatibility)) throw new PrivateRecordError('Mixed component/config/usage state; review a coordinated migration', 'conflict');
    const isolated = new FHIRStore(); checkpoint.hydrate(isolated, payload.state);
    if (!payload.state._private) throw new PrivateRecordError('Private authority is missing', 'missing');
    return isolated;
}
/** Explicit reviewed restore under an existing maintenance fence; never runs at startup. */
function restorePrivateCheckpoint(store, backup, { compatibility, reviewedHash, workersStopped, stateDirectory } = {}) {
    if (!workersStopped || reviewedHash !== backup?.hash || !stateDirectory || !require('node:fs').existsSync(require('../../shared/migration-maintenance').fencePath(stateDirectory))) throw new PrivateRecordError('Stop/drain workers and review the exact backup under maintenance before restore');
    require('../../shared/migration-maintenance').assertOperationsIdle(stateDirectory);
    require('../../shared/migration-maintenance').assertConfigurationIdle(stateDirectory);
    const isolated = validateCandidate(backup, compatibility); assertRestrictionsPreserved(store, isolated);
    // Publication by 07 uses the existing checkpoint journal. Do not bypass an attached live journal here.
    if (store.migrationCheckpointAttached) throw new PrivateRecordError('Use coordinated offline checkpoint publication for an attached owner');
    const state = checkpoint.snapshot(isolated, { privateState: true });
    state._private.authority.epoch = crypto.randomUUID(); // Backups never make old tokens portable.
    checkpoint.hydrate(store, state, { rollback: true });
    return { revision: store.privateState.revision, tokensInvalidated: true };
}
module.exports = { SCHEMA_VERSION, COMPONENTS, BINDINGS, validateCompatibility, exportPrivateCheckpoint, validateCandidate, assertRestrictionsPreserved, restorePrivateCheckpoint };
