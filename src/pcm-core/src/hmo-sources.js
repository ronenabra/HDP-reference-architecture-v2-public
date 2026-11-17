'use strict';

/** One registered-source view for local HMO workflows; browser URLs never define targets. */
const { getConfiguredDataSources } = require('./data-sources');
const { organizationRole, organizationIsOperational, participantEndpoint } = require('./fhir/participant-lifecycle');

/** Stable source state used to reject substitutions and late results after reconfiguration. */
function sourceFingerprint(source) {
    return JSON.stringify([source.id, source.endpointId, source.endpoint, source.institutionType, source.enabled,
        source.clientId, source.serverTrust, source.pcmClientAuth]);
}

/** Resolve configured HMO institutions and, when supplied, current authoritative FHIR readiness. */
function hmoSources(config, store, { includeUnavailable = false } = {}) {
    return getConfiguredDataSources(config).filter(source => source.institutionType === 'hmo').flatMap(source => {
        if (!store) return [source];
        const organization = store.get('Organization', source.id);
        const endpoint = participantEndpoint(store, organization, { requireActive: false });
        const available = organizationRole(organization) === 'source' && organizationIsOperational(store, organization)
            && endpoint?.status === 'active';
        // Endpoint is PCM's current authoritative address; configuration remains the registration/trust seed.
        const projected = endpoint ? { ...source, endpointId: endpoint.id, endpoint: endpoint.address } : source;
        return available || includeUnavailable ? [projected] : [];
    });
}

/** Ordinary targets use Organization IDs; managed aliases are reserved for explicit older fixtures. */
function resolveHmoSource(config, id, { store, allowManagedAlias = false } = {}) {
    const matches = hmoSources(config, store).filter(source => source.id === id || (allowManagedAlias && source.healthOrganizationId === id));
    if (matches.length !== 1) throw new Error('Choose a registered, operational HMO source for this test. Check its institution type, Organization and Endpoint in Admin.');
    return matches[0];
}
module.exports = { hmoSources, resolveHmoSource, sourceFingerprint };
