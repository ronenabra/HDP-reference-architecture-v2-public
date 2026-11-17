'use strict';

/** Select registered source policy through current authoritative FHIR identity. */
const { presenceLimits } = require('../../shared/presence-limits');
const { findOperationalDataSourceByAddress } = require('./fhir/participant-lifecycle');

/** Resolve budget and security identities together without conflating the legacy alias with a source ID. */
function registeredSourceIdentity(store, config, selector = {}) {
    if (selector.resource) {
        const target = findOperationalDataSourceByAddress(store, selector.resource);
        if (target) selector = { organizationId: target.organization.id };
    }
    const sources = [
        ...(config.healthOrganizations || []).map(source => ({ ...source, budgetId: source.id, securityId: source.id,
            organizationId: source.dataSourceOrganization?.id })),
        ...(config.organizations?.dataSources || []).map(source => ({ ...source, budgetId: source.id, securityId: source.id,
            organizationId: source.id })),
        { budgetId: 'legacy', securityId: config.legacyDataSource?.id,
            organizationId: config.organizations?.referenceDataSource?.id,
            clientId: config.organizations?.referenceDataSource?.clientId }
    ];
    // An unrecognized/stale resource must not recover identity through its configured URL.
    return sources.find(source => (selector.id && [source.budgetId, source.securityId, source.organizationId].includes(selector.id))
        || (selector.organizationId && source.organizationId === selector.organizationId)
        || (selector.clientId && source.clientId === selector.clientId)) || null;
}

/** Return the stable presence configuration key, including the retained `legacy` alias. */
function registeredSourceId(store, config, selector = {}) {
    return registeredSourceIdentity(store, config, selector)?.budgetId || null;
}

/** Apply finite budgets for the registered source, before authentication or state consumption. */
function sourceLimits(store, config, selector = {}) {
    return presenceLimits(config, { id: registeredSourceId(store, config, selector) });
}

/** Use the same stable source selection for lifecycle and caller simulation controls. */
function sourceControls(store, policy, config, selector = {}) {
    const id = registeredSourceIdentity(store, config, selector)?.securityId;
    const overrides = policy?.simulation?.perSource || {};
    return id && Object.hasOwn(overrides, id) ? overrides[id] : policy?.simulation?.controls || {};
}

module.exports = { registeredSourceId, sourceLimits, sourceControls };
