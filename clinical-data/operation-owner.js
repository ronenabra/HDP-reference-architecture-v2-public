'use strict';
/** Share one mounted registry identity between host lifecycle and container helpers. */
const fs = require('fs');
const path = require('path');
const modulePath = fs.existsSync('/pcm-core/data-operations.js')
    ? '/pcm-core/data-operations.js'
    : fs.existsSync('/app/src/data-operations.js') ? '/app/src/data-operations.js'
        : path.resolve(__dirname, '../src/pcm-core/src/data-operations.js');
const { DataOperationRegistry, latestVerifiedLoad } = require(modulePath);

/** Adopt the parent reservation or reserve a validated host-side target. */
function operationOwner({ stateDir, serverId, kind, details = {}, env = process.env }) {
    const registry = new DataOperationRegistry({ directory: path.join(stateDir, 'data-operations') });
    const inherited = Boolean(env.PCM_DATA_OPERATION_ID);
    const operation = inherited
        ? registry.adopt(env.PCM_DATA_OPERATION_ID, env.PCM_DATA_OPERATION_TOKEN)
        : registry.create(serverId, kind, details);
    if (operation.serverId !== serverId) throw new Error('operation target differs from requested managed server');
    if (details.targetIdentity && operation.targetIdentity !== details.targetIdentity) throw new Error('operation target configuration changed');
    const configPath = env.TEAM_CONFIG_PATH;
    if (configPath && operation.targetIdentity) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const target = (config.healthOrganizations || []).find(item => item.id === serverId);
        if (JSON.stringify(target) !== operation.targetIdentity) throw new Error('operation target configuration changed');
    }
    return { registry, operation, inherited, env: {
        ...env, PCM_DATA_OPERATION_ID: operation.id, PCM_DATA_OPERATION_TOKEN: registry.ownerToken(operation.id)
    } };
}

module.exports = { operationOwner, latestVerifiedLoad };
