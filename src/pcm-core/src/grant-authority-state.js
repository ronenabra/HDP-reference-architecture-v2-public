'use strict';

/** Private dependency generations: restoring a resource cannot restore an old grant. */
const { randomUUID } = require('crypto');
const { normalizePatientIdentifier } = require('../../shared/identity-mapping');
const { basedOnId } = require('./fhir/healthcare-service-lifecycle');

/** Keep mutation history separate from public FHIR metadata and token wire claims. */
class GrantAuthorityState {
    constructor() {
        this.epoch = randomUUID();
        this.generations = new Map();
        this.configuration = new Map();
    }

    /** Advance an irreversible generation for an authority which changed. */
    advance(key) { this.generations.set(key, (this.generations.get(key) || 0) + 1); }

    /** Compare semantic state, ignoring server metadata and additive Contract membership. */
    changed(previous, current) {
        const type = current.resourceType;
        const id = `${type}/${current.id}`;
        if (!previous) { this.advance(id); return; }
        const semantic = resource => {
            const copy = structuredClone(resource);
            delete copy.meta;
            if (type === 'Contract') for (const term of copy.term || []) delete term.asset;
            if (type === 'Consent' && copy.provision) copy.provision.actor = (copy.provision.actor || [])
                .filter(actor => !actor.role?.coding?.some(code => code.code === 'CST'));
            if (type === 'Endpoint') delete copy.address;
            return JSON.stringify(copy);
        };
        if (semantic(previous) !== semantic(current)) this.advance(id);
        if (type === 'Endpoint' && previous.address !== current.address) this.advance(`${id}/address`);
        if (type === 'Contract' || type === 'Consent') {
            const sources = resource => new Set(type === 'Contract' ? (resource.term || []).flatMap(term => (term.asset || [])
                .flatMap(asset => (asset.context || []).map(context => context.reference?.reference).filter(Boolean)))
                : (resource.provision?.actor || []).filter(actor => actor.role?.coding?.some(code => code.code === 'CST')).map(actor => actor.reference?.reference).filter(Boolean));
            const retained = sources(current);
            for (const source of sources(previous)) if (!retained.has(source)) this.advance(`${id}/${source}`);
        }
    }

    /** Observe accepted configuration, retaining removal history across later restoration. */
    observeConfig(config) {
        const values = new Map();
        const settings = config.systemAuthorization || {};
        for (const [client, scenarios] of Object.entries(settings.clientEntitlements || {})) {
            for (const scenario of scenarios) values.set(`client/${client}/${scenario}`, true);
        }
        for (const source of require('./data-sources').getConfiguredDataSources(config)) {
            values.set(`source/${source.id}`, require('./hmo-sources').sourceFingerprint(source));
            if (source.institutionType === 'hmo') values.set(`hmo/${source.id}`, true);
        }
        for (const member of settings.memberships || []) values.set(`member/${normalizePatientIdentifier(member.identifier).key}`, JSON.stringify({ loginEligibility: member.loginEligibility, sandboxFixture: member.sandboxFixture }));
        for (const patient of settings.presenceEligiblePatients || []) values.set(`eligible/${normalizePatientIdentifier(patient).key}`, true);
        for (const [key, value] of this.configuration) if (values.get(key) !== value) this.advance(key);
        this.configuration = values;
    }

    /** Freeze only dependencies enforced by the existing effective source controls. */
    stamp(store, config, grant, client, controls) {
        controls = require('../../shared/conformance-policy').effectiveControls(controls);
        this.observeConfig(config);
        const keys = new Set();
        const add = (type, id) => {
            if (!id) return;
            keys.add(`${type}/${id}`);
            if (type === 'Organization') {
                const parent = store.get(type, id)?.partOf?.reference?.split('/')[1];
                if (parent && !keys.has(`Organization/${parent}`)) add('Organization', parent);
            }
        };
        add('Organization', grant.dataSourceOrganizationId);
        add('Organization', client.organizationId);
        // Endpoint state is structural; address remains the existing audience simulation.
        add('Endpoint', grant.endpointId);
        if (controls.tokenAudience !== false || grant.scenario === 'sandbox-patient-sample') keys.add(`Endpoint/${grant.endpointId}/address`);
        if (grant.scenario !== 'consent-access') {
            add('Contract', grant.contractId);
            keys.add(`Contract/${grant.contractId}/Organization/${grant.dataSourceOrganizationId}`);
            keys.add(`client/${client.clientId}/${grant.scenario}`);
            keys.add(`source/${grant.dataSourceOrganizationId}`);
            if (grant.scenario !== 'presence-check' && grant.scenario !== 'sandbox-patient-sample') keys.add(`hmo/${grant.dataSourceOrganizationId}`);
            for (const patient of grant.requested?.patients || []) if (grant.scenario === 'presence-check') keys.add(`eligible/${normalizePatientIdentifier(patient).key}`);
            if (grant.invocationIdentity) {
                const identity = normalizePatientIdentifier(grant.invocationIdentity);
                if (identity.synthetic || identity.system.includes('/passport-')) keys.add(`member/${identity.key}`);
            }
        } else if (controls.consentState !== false) {
            add('Consent', grant.consentId);
            keys.add(`Consent/${grant.consentId}/Organization/${grant.dataSourceOrganizationId}`);
        }
        if (grant.serviceId && (controls.serviceState !== false || grant.scenario === 'sandbox-patient-sample')) {
            add('HealthcareService', grant.serviceId);
            add('HealthcareService', basedOnId(store.get('HealthcareService', grant.serviceId)));
        }
        return { epoch: this.epoch, generations: Object.fromEntries([...keys].sort().map(key => [key, this.generations.get(key) || 0])) };
    }
}

/** Compare the generations retained at issuance, allowing newly added authority only to stay unused. */
function authorityStillAllowed(issued, current) {
    return issued?.epoch === current?.epoch && Object.entries(current.generations)
        .every(([key, generation]) => issued.generations[key] === generation);
}

/** Bind custom-source caller credentials to their existing private authority generations.
 * @param {object} store Owning FHIRStore and authority state.
 * @param {object} config Current validated team configuration.
 * @param {object} client Authenticated registered client identity.
 * @returns {object|null} Private source stamp, or null for unavailable custom sources and unchanged built-in/other callers.
 */
function sourceClientAuthority(store, config, client) {
    const source = require('./data-sources').getConfiguredDataSources(config)
        .find(item => !item.builtIn && item.id === client.organizationId && item.clientId === client.clientId);
    if (!source) return null;
    const organization = store.get('Organization', source.id);
    if (!require('./fhir/participant-lifecycle').organizationIsOperational(store, organization)) return null;
    const parent = organization.partOf?.reference;
    store.authorityState.observeConfig(config);
    return { epoch: store.authorityState.epoch, sourceId: source.id,
        parent, parentGeneration: store.authorityState.generations.get(parent) || 0,
        organizationGeneration: store.authorityState.generations.get(`Organization/${source.id}`) || 0,
        sourceGeneration: store.authorityState.generations.get(`source/${source.id}`) || 0 };
}

/** Refuse stale/missing custom-source caller stamps without changing built-in bearer behavior.
 * @param {object} credential Stored opaque management/introspection caller credential.
 * @param {object} store Owning FHIRStore.
 * @param {object} config Current validated team configuration.
 * @returns {boolean} Whether the credential retains its original source authority.
 */
function sourceClientCredentialStillAllowed(credential, store, config) {
    const reserved = (config.organizations?.removedDataSourceRegistrations || [])
        .some(item => item.id === credential.organization_id || item.clientId === credential.client_id);
    if (reserved) return false;
    const source = require('./data-sources').getConfiguredDataSources(config, { includeDisabled: true })
        .find(item => !item.builtIn && item.id === credential.organization_id && item.clientId === credential.client_id);
    if (!source) return credential.source_registration_authority === undefined;
    if (source.enabled === false) return false;
    const current = sourceClientAuthority(store, config, { clientId: credential.client_id, organizationId: credential.organization_id });
    return Boolean(current && credential.source_registration_authority
        && JSON.stringify(current) === JSON.stringify(credential.source_registration_authority));
}

module.exports = { GrantAuthorityState, authorityStillAllowed, sourceClientAuthority, sourceClientCredentialStillAllowed };
