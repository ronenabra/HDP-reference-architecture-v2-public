'use strict';

/** Explicit preload bridge for an immutable pre-041 runtime's existing private owners.
 * Install with NODE_OPTIONS=--require=/absolute/path/migration-legacy-bridge.js
 * and PCM_MIGRATION_LEGACY_ROOT pointing to that runtime's repository root.
 * The bridge adds checkpoint/restart/fencing only; legacy grant interpretation stays legacy.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const checkpoint = require('./migration-checkpoint');
const maintenance = require('../../shared/migration-maintenance');

/** Add checkpoint behavior before the legacy entrypoint imports its singleton owners. */
function install(root) {
    const base = path.resolve(root, 'src/pcm-core/src'), load = Module._load;
    const stateDirectory = process.env.STATE_DIR;
    if (!stateDirectory || !process.env.TEAM_CONFIG_PATH) throw new Error('Legacy checkpoint bridge requires explicit STATE_DIR and TEAM_CONFIG_PATH');
    // A preload replaces a retained process, so ordinary fresh-team seeds are never authority here.
    checkpoint.readCheckpoint({ configPath: process.env.TEAM_CONFIG_PATH, stateDirectory,
        runtimeId: process.env.PCM_MIGRATION_RUNTIME_ID, required: true });
    let expressBridge;
    const fence = (req, res, next) => {
        try {
            maintenance.assertAvailable(stateDirectory);
            const migrated = fs.existsSync(path.join(stateDirectory, 'pcm-ig-041', 'manifest.json'));
            if (migrated && ['/admin/reset', '/admin/restore'].includes(req.path)) return res.status(409).json({ error: 'Use guarded migration rollback; generic reset/restore cannot discard retained restrictions' });
            // Old deterministic cookies have no migration epoch. Legacy Admin
            // requires the unchanged password/header after a checkpoint boundary.
            if (migrated && req.headers.cookie) req.headers.cookie = req.headers.cookie.split(';').filter(value => !value.trim().startsWith('teamAdminSession=')).join(';');
            next();
        } catch (error) { res.status(503).json({ error: error.message }); }
    };
    Module._load = function (request, parent, isMain) {
        const filename = Module._resolveFilename(request, parent, isMain);
        const exported = load.apply(this, arguments);
        if (request === 'express') {
            if (!expressBridge) {
                expressBridge = Object.assign(function (...args) { const app = exported(...args); app.use(fence); return app; }, exported);
            }
            return expressBridge;
        }
        if (filename === path.join(base, 'bootstrap.js') && !exported.pcmMigrationBridge) {
            const wrapped = async function (...args) {
                const store = load.call(Module, path.join(base, 'fhir/store.js'), parent, false);
                checkpoint.restore({ store, configPath: process.env.TEAM_CONFIG_PATH, stateDirectory, runtimeId: process.env.PCM_MIGRATION_RUNTIME_ID, required: true });
            };
            Object.assign(wrapped, exported, { pcmMigrationBridge: true });
            require.cache[filename].exports = wrapped; return wrapped;
        }
        if (filename === path.join(base, 'team-config.js') && !exported.pcmMigrationBridge) {
            const save = exported.saveTeamConfig;
            exported.saveTeamConfig = (...args) => maintenance.withConfigurationMutation(stateDirectory, () => { maintenance.assertAvailable(stateDirectory); const result = save(...args); checkpoint.recordConfig(stateDirectory, process.env.TEAM_CONFIG_PATH); return result; });
            exported.pcmMigrationBridge = true;
        }
        if (filename === path.join(base, 'data-operations.js') && !exported.pcmMigrationBridge) {
            const create = exported.DataOperationRegistry.prototype.create;
            exported.DataOperationRegistry.prototype.create = function (...args) {
                maintenance.assertAvailable(stateDirectory);
                const operation = create.apply(this, args);
                // A racing online freeze leaves the new reservation blocked for
                // ordinary reconciliation; it must never submit an import.
                maintenance.assertAvailable(stateDirectory);
                return operation;
            };
            exported.pcmMigrationBridge = true;
        }
        if (filename === path.join(base, 'routes/ui.js') && !exported.pcmMigrationBridge) {
            // The legacy router's earlier /admin middleware still authenticates this route.
            exported.post('/admin/migration/checkpoint', (req, res) => {
                try {
                    const store = load.call(Module, path.join(base, 'fhir/store.js'), parent, false);
                    store.authorityState ||= new (require('./grant-authority-state').GrantAuthorityState)();
                    res.json(checkpoint.prepare({ store, configPath: process.env.TEAM_CONFIG_PATH, stateDirectory, runtimeId: process.env.PCM_MIGRATION_RUNTIME_ID }));
                } catch (error) { res.status(409).json({ error: error.message }); }
            });
            exported.pcmMigrationBridge = true;
        }
        return exported;
    };
}

if (process.env.PCM_MIGRATION_LEGACY_ROOT) install(process.env.PCM_MIGRATION_LEGACY_ROOT);
module.exports = { install };
