'use strict';
/** Read the shared effective source controls for disclosure, never authorization. */
const { SIMULATION_CONTROLS, sourceSimulationControls } = require('../../shared/conformance-policy');
const LABELS = Object.freeze({ publicClientMtls: 'client certificate', serverCertificateVerification: 'server certificate verification',
    clientAssertionSignature: 'assertion signature', clientAssertionAudience: 'assertion audience', clientAssertionReplay: 'assertion replay', clientAssertionExpiry: 'assertion expiry' });
/** Describe exact enabled sources and their already-resolved transport/assertion simulations. */
function doctorNotice(config, policy) {
    const sources = (config.healthOrganizations || []).filter(source => source.enabled !== false).map(source => {
        const controls = sourceSimulationControls(policy, config, { resource: source.endpoint });
        return { name: source.name || source.id, relaxed: SIMULATION_CONTROLS.filter(key => controls[key] === false).map(key => LABELS[key]) };
    });
    const affected = sources.filter(source => source.relaxed.length);
    return { sources, message: sources.length ? `${affected.length} of ${sources.length} configured data sources have relaxed transport or assertion checks.` : 'No enabled data sources are configured.', affected };
}
module.exports = { doctorNotice };
