'use strict';

/** Shared private fence for config writers and the existing data-operation registry. */
const fs = require('fs');
const path = require('path');
const activeConfigurationWriters = new Set();

/** Resolve the fence on the same state mount as operation reservations. */
function fencePath(directory) { return path.join(directory, 'pcm-ig-041-maintenance'); }

/** Reject mutation while the operator has frozen a migration checkpoint. */
function assertAvailable(directory) {
    if (directory && (fs.existsSync(fencePath(directory)) || fs.existsSync(path.join(directory, 'pcm-ig-041', 'checkpoint-mutation.json')))) throw new Error('PCM migration maintenance: stop/reconcile workers, then apply or recover the reviewed migration');
    if (directory && fs.existsSync(path.join(directory, 'configuration-mutation')) && !activeConfigurationWriters.has(path.resolve(directory))) throw new Error('Configuration publication is uncertain; stop workers and reconcile the private configuration journal before restart');
}

/** Serialize configuration publication and checkpoint capture on the existing state mount. */
function withConfigurationMutation(directory, action) {
    if (!directory) throw new Error('A shared state directory is required for configuration publication');
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, 'configuration-mutation');
    try { fs.mkdirSync(lock); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Configuration publication is active/uncertain; stop workers and reconcile configuration-mutation before retry');
        throw error;
    }
    const synchronizeDirectory = () => { const descriptor = fs.openSync(directory, 'r'); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } };
    synchronizeDirectory();
    activeConfigurationWriters.add(path.resolve(directory));
    try { return action(lock); } finally {
        activeConfigurationWriters.delete(path.resolve(directory));
        // A source publication journal deliberately retains this existing mutex
        // across a crash/uncertain checkpoint; only reviewed recovery removes it.
        if (!fs.readdirSync(lock).length) { fs.rmdirSync(lock); synchronizeDirectory(); }
    }
}

/** Never infer that a crashed configuration writer completed safely. */
function assertConfigurationIdle(directory) {
    if (fs.existsSync(path.join(directory, 'configuration-mutation'))) throw new Error('Configuration publication is active/uncertain; stop workers and reconcile configuration-mutation before migration');
}

/** Reject unfinished, uncertain, initializing and concurrently maintained targets. */
function assertOperationsIdle(directory) {
    const root = path.join(directory, 'data-operations');
    if (!fs.existsSync(root)) return;
    for (const name of fs.readdirSync(root)) {
        if (/^(lock-|mutation-|reconciling-)/.test(name)) throw new Error(`Migration blocked by data-operation reservation ${name}; reconcile it without replay before checkpoint/apply`);
        if (name.endsWith('.json')) {
            const operation = JSON.parse(fs.readFileSync(path.join(root, name)));
            if (!['succeeded', 'failed'].includes(operation.phase) || operation.needsReconciliation) {
                throw new Error(`Migration blocked by active/uncertain operation ${operation.id || name}; stop worker and use existing read-only reconciliation`);
            }
        }
    }
}

module.exports = { assertAvailable, assertOperationsIdle, assertConfigurationIdle, fencePath, withConfigurationMutation };
