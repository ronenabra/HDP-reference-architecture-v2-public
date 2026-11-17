'use strict';

/** Typed Consent/source discovery and uncertain-create recovery helpers. */
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS } = require('./constants');

const asArray = value => (Array.isArray(value) ? value : (value ? [value] : []));
const referenceId = (value, type) => {
    const match = new RegExp(`^${type}\/([A-Za-z0-9\\-.]{1,64})$`).exec(value || '');
    return match?.[1] || null;
};

function businessStatus(consent) {
    const values = asArray(consent?.extension).filter(extension => extension.url === EXTENSIONS.consentBusinessStatus);
    return values.length === 1 && values[0].valueCoding?.system === CODE_SYSTEMS.consentBusinessStatus
        ? values[0].valueCoding.code : null;
}

function businessIdentifier(resource, system) {
    const values = asArray(resource?.identifier).filter(identifier => identifier.use === 'official'
        && identifier.system === system && identifier.value);
    return values.length === 1 ? values[0] : null;
}

function requireBusinessIdentifier(resource, system, name) {
    const identifier = businessIdentifier(resource, system);
    if (!identifier) throw new TypeError(`${name} has no unique official PCM business identifier`);
    return identifier;
}

function assertSearchBundle(bundle) {
    if (!bundle || bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset'
        || !Number.isSafeInteger(bundle.total) || !Array.isArray(bundle.entry || [])) {
        throw new TypeError('PCM search response is not a closed searchset Bundle');
    }
    return bundle;
}

function parseConsentSourceBundle(bundle, consentId) {
    assertSearchBundle(bundle);
    const entries = bundle.entry || [];
    const matches = entries.filter(entry => entry.search?.mode === 'match'
        && entry.resource?.resourceType === 'Consent'
        && (!consentId || entry.resource.id === consentId));
    if (matches.length > 1) throw new TypeError('Consent discovery returned multiple matching resources');
    if (!matches.length) return null;
    const consent = matches[0].resource;
    requireBusinessIdentifier(consent, IDENTIFIER_SYSTEMS.consent, 'Consent');
    const active = consent.status === 'active' && businessStatus(consent) === 'active';
    const organizations = new Map(entries.filter(entry => entry.resource?.resourceType === 'Organization')
        .map(entry => [entry.resource.id, entry.resource]));
    const endpoints = new Map(entries.filter(entry => entry.resource?.resourceType === 'Endpoint')
        .map(entry => [entry.resource.id, entry.resource]));
    const discoveredEndpoints = [];
    if (active) {
        for (const actor of asArray(consent.provision?.actor)) {
            const isSource = actor.role?.coding?.length === 1
                && actor.role.coding[0].system === 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType'
                && actor.role.coding[0].code === 'CST';
            if (!isSource) continue;
            const organization = organizations.get(referenceId(actor.reference?.reference, 'Organization'));
            if (!organization || organization.active !== true || asArray(organization.endpoint).length !== 1) continue;
            const organizationIdentifier = requireBusinessIdentifier(
                organization, IDENTIFIER_SYSTEMS.organization, `Organization/${organization.id}`
            );
            const endpoint = endpoints.get(referenceId(organization.endpoint[0].reference, 'Endpoint'));
            if (!endpoint || endpoint.status !== 'active' || typeof endpoint.address !== 'string') continue;
            const address = new URL(endpoint.address);
            if (address.protocol !== 'https:' && address.protocol !== 'http:') continue;
            discoveredEndpoints.push({
                organizationId: organization.id,
                organizationIdentifier,
                endpointId: endpoint.id,
                endpointIdentifier: endpoint.identifier?.[0] || null,
                name: organization.name || actor.reference.display || endpoint.address,
                url: endpoint.address,
                endpoint
            });
        }
    }
    return { consent, active, businessStatus: businessStatus(consent), discoveredEndpoints };
}

function consentRecoverySearch({ patientIdentifier, serviceId }) {
    if (!patientIdentifier?.system || !patientIdentifier?.value || !serviceId) {
        throw new TypeError('Consent recovery requires patient identifier and service id');
    }
    return new URLSearchParams({
        'patient:identifier': `${patientIdentifier.system}|${patientIdentifier.value}`,
        'pcm-service': `HealthcareService/${serviceId}`
    });
}

function recoverConsentCandidates(bundle, { patientIdentifier, serviceId }) {
    assertSearchBundle(bundle);
    return (bundle.entry || []).filter(entry => entry.search?.mode === 'match' && entry.resource?.resourceType === 'Consent')
        .map(entry => entry.resource)
        .filter(consent => consent.patient?.identifier?.system === patientIdentifier.system
            && consent.patient.identifier.value === patientIdentifier.value
            && asArray(consent.extension).some(extension => extension.url === EXTENSIONS.pcmService
                && extension.valueReference?.reference === `HealthcareService/${serviceId}`));
}

module.exports = {
    assertSearchBundle,
    businessStatus,
    consentRecoverySearch,
    parseConsentSourceBundle,
    recoverConsentCandidates
};
