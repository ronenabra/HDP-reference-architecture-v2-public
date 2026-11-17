'use strict';

/** Shared process-local identity boundary used by browser routes and OAuth invocation lookup. */
const path = require('node:path');
const { PresenceStore } = require('./presence-store');
const { getSystemFlowStore } = require('./system-flow-store');
const { createSystemWorkflowClient } = require('./system-workflow-client');
const { SystemWorkflows, LocalOtpTransport } = require('./system-workflows');
let transport;
let team;

/** Re-read current configuration while preserving only the current team's local deliveries. */
function systemWorkflows(config, logger) {
    if (team !== config.teamId) {
        transport?.dispose();
        team = config.teamId;
        transport = new LocalOtpTransport();
    }
    const flows = getSystemFlowStore(config);
    const store = require('./fhir/store');
    return new SystemWorkflows({ config, flows, transport, logger, store, presenceStore: new PresenceStore(path.join(process.env.STATE_DIR || config.runtime.stateDir, 'source-presence')),
        request: createSystemWorkflowClient({ config, flows, logger, store, getConfig: require('./team-config').loadTeamConfig }) });
}
module.exports = { systemWorkflows };
