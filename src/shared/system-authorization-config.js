'use strict';

/** Explicit sandbox workflow settings; no national membership or relationship policy is inferred. */
const { presenceLimits } = require('./presence-limits');
const { normalizePatientIdentifier } = require('./identity-mapping');
const SYSTEM_CLIENTS = Object.freeze({
    presenceOrchestrator: 'presence-check',
    authenticationOrchestrator: 'patient-authentication',
    discoveryOrchestrator: 'dependent-discovery'
});

/** Return bounded local defaults with empty membership/relationship eligibility. */
function defaultSystemAuthorization(config) {
    return {
        configurationKind: 'synthetic-local',
        clientEntitlements: { ...Object.fromEntries(Object.entries(SYSTEM_CLIENTS).map(([role, scenario]) => [
            config.oauthClients[role].clientId, [scenario]
        ])), ...(config.sandboxSampling ? Object.fromEntries(['serviceProvider', 'hospitalBServiceProvider'].map(role => [config.organizations[role].clientId, ['sandbox-patient-sample']])) : {}) },
        participatingHmos: [],
        memberships: [],
        presenceEligiblePatients: [],
        otp: { transport: 'local', channels: ['sms'], expirySeconds: 300, resendSeconds: 30,
            maxAttempts: 5, maxResends: 3, contactMaxAgeSeconds: 2592000 },
        authentication: { flowLifetimeSeconds: 600, authenticatedLifetimeSeconds: 300, timeoutMilliseconds: 10000 },
        discovery: { timeoutMilliseconds: 30000, maxPagesPerSource: 20, maxRetries: 1, eligibleRelationships: [] }
    };
}

/** Reject unknown clients/HMOs and ambiguous or weak membership identities. */
function validateSystemAuthorization(config) {
    const errors = [];
    const settings = config.systemAuthorization;
    if (!settings) return ['systemAuthorization is required'];
    try {
        presenceLimits(config);
        for (const id of Object.keys(config.presence?.sources || {})) presenceLimits(config, { id });
    } catch (error) { errors.push(error.message); }
    const registered = Object.values(config.oauthClients || {}).map(client => client.clientId);
    if (new Set(registered).size !== registered.length) errors.push('system OAuth client IDs must be distinct');
    const participantIds = new Set(Object.values(config.organizations || {}).map(org => org?.clientId).filter(Boolean));
    for (const id of registered) {
        if (participantIds.has(id)) errors.push('system OAuth client IDs must be separate from participant clients');
    }
    const managed = new Set((config.healthOrganizations || []).map(ho => ho.id));
    for (const id of settings.participatingHmos || []) {
        if (!managed.has(id)) errors.push(`systemAuthorization.participatingHmos contains unknown managed source ${id}`);
    }
    for (const [id, scenarios] of Object.entries(settings.clientEntitlements || {})) {
        const appSampling = ['serviceProvider', 'hospitalBServiceProvider'].some(role => config.organizations[role]?.clientId === id);
        if (!registered.includes(id) && !appSampling) errors.push(`systemAuthorization.clientEntitlements contains unregistered client ${id}`);
        if (appSampling && (!Array.isArray(scenarios) || scenarios.some(value => value !== 'sandbox-patient-sample'))) errors.push('Participant applications may receive only sandbox sampling entitlements');
        if (!Array.isArray(scenarios) || scenarios.some(value => ![...Object.values(SYSTEM_CLIENTS), 'sandbox-patient-sample'].includes(value))) {
            errors.push('systemAuthorization contains an unknown scenario');
        }
    }
    if (config.sandboxSampling && !config.serviceCatalog) errors.push('sandboxSampling requires an explicitly selected service catalog');
    for (const id of config.sandboxSampling?.sourceIds || []) if (!managed.has(id)) errors.push('Unknown sandbox sampling target');
    const memberships = new Set();
    for (const member of settings.memberships || []) {
        try {
            const identity = normalizePatientIdentifier(member.identifier);
            if (member.sandboxFixture === true && !identity.synthetic) throw new Error('Only HTEST identifiers may enroll a synthetic lookup fixture');
            if (identity.synthetic && member.sandboxFixture !== true) throw new Error('Synthetic test-id cannot authenticate a person');
            if (memberships.has(identity.key)) throw new Error('Membership identity must resolve to one home HMO');
            memberships.add(identity.key);
            if (member.sandboxFixture === true || member.localSso) {
                const sources = (config.healthOrganizations || []).map(ho => [ho.id, ho.dataSourceOrganization.id, require('./source-institution').sourceInstitutionType(ho, { managed: true })]);
                sources.push(...(config.organizations.dataSources || []).filter(source => source.enabled !== false).map(source => [source.id, source.id, require('./source-institution').sourceInstitutionType(source)]));
                if (!sources.some(([id, organizationId, type]) => type === 'hmo' && [id, organizationId].includes(member.homeHmoId))) throw new Error('Explicit fixture home HMO must be registered and classified HMO');
            }
        } catch (error) { errors.push(`systemAuthorization.memberships: ${error.message}`); }
    }
    const eligible = new Set();
    for (const patient of settings.presenceEligiblePatients || []) {
        try {
            const identity = normalizePatientIdentifier(patient);
            if (eligible.has(identity.key)) throw new Error('Duplicate presence eligibility identity');
            eligible.add(identity.key);
        } catch (error) { errors.push(`systemAuthorization.presenceEligiblePatients: ${error.message}`); }
    }
    if (settings.otp?.resendSeconds >= settings.otp?.expirySeconds) errors.push('OTP resend interval must be shorter than OTP expiry');
    return errors;
}

/** Return only explicitly enrolled HTEST lookup fixtures; ordinary configuration has none. */
function syntheticWorkflowFixtureIdentities(config) {
    if (config?.systemAuthorization?.configurationKind !== 'synthetic-local') return [];
    return (config.systemAuthorization.memberships || []).flatMap(member => {
        const patient = normalizePatientIdentifier(member.identifier);
        return patient.synthetic && member.sandboxFixture === true ? [{ system: patient.system, value: patient.value }] : [];
    });
}

module.exports = { syntheticWorkflowFixtureIdentities, SYSTEM_CLIENTS, defaultSystemAuthorization, validateSystemAuthorization };
