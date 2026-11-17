'use strict';

/** Exact configured business identities for private workflow consumers, without a FHIR lookup. */
const { loadServiceCatalog } = require('./service-catalog');
const SYSTEM = 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id';
const DEFAULTS = Object.freeze({
    'presence-check': 'PCM-POLICY-PRESENCE-001',
    'patient-authentication': 'PCM-POLICY-PATIENT-AUTHENTICATION-001',
    'dependent-discovery': 'PCM-POLICY-DEPENDENT-DISCOVERY-001'
});

/** Resolve the same authored catalog identities used to provision PCM system Contracts. */
function workflowIdentities(config = {}) {
    const catalog = loadServiceCatalog(config);
    const identities = { ...DEFAULTS };
    for (const policy of catalog?.systemPolicies || []) identities[policy.scenario] = policy.policyIdentifier;
    return Object.freeze(identities);
}

/** Require purpose, configured Contract identity and context to describe the same workflow. */
function assertWorkflowIdentity(identifier, scenario, identities = DEFAULTS) {
    if (!Object.hasOwn(identities, scenario) || identifier?.system !== SYSTEM
        || identifier.value !== identities[scenario]) throw new TypeError('Workflow Contract identity does not match the configured scenario');
}
module.exports = { DEFAULTS, SYSTEM, assertWorkflowIdentity, workflowIdentities };
