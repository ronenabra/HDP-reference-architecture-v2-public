'use strict';
/** Private, single-target service lifecycle simulations; public PCM FHIR remains unchanged. */
const crypto = require('node:crypto');
const lifecycle = require('./fhir/healthcare-service-lifecycle');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { organizationIsOperational } = require('./fhir/participant-lifecycle');
const { consentServiceId, reconcileConsentsForService, reconcileExpiredConsents } = require('./fhir/consent-lifecycle');
const { browserOrigin } = require('../../shared/browser-navigation');
const DISABLED = 'urn:pcm:sandbox:service-disabled';
const secret = crypto.randomBytes(32);

/** Bind forms to provider, target, displayed version and current Admin epoch. */
function csrf(providerRole, id = '', version = '') {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([providerRole, id, version, require('./migration-checkpoint').sessionEpoch()])).digest('base64url');
}
/** Reject foreign-origin or forged commands before any API call or store operation. */
function assertCommand(req, { providerRole = '', id = '', version = '' } = {}) {
    const token = req.body?.csrf, expected = csrf(providerRole, id, version);
    if ((req.get('origin') && req.get('origin') !== browserOrigin(req)) || typeof token !== 'string'
        || Buffer.byteLength(token) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
        throw Object.assign(new Error('Refresh Services and use the same-origin form.'), { status: 403 });
    }
}
/** List every persisted/configured reference that blocks single-record deletion. */
function dependencies({ store, config, service }) {
    const registrations = store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === service.id);
    const consents = store.getAll('Consent').filter(item => consentServiceId(item) === service.id);
    const contracts = store.getAll('Contract').filter(item => JSON.stringify(item).includes(JSON.stringify(`HealthcareService/${service.id}`)));
    // Seed graph is validated by the same bootstrap builder; failing to inspect it must fail closed.
    const seeded = require('./bootstrap').buildSeedResources(config).some(item => item.resourceType === 'HealthcareService' && item.id === service.id);
    const approvals = Object.entries(store.privateState.approvals).filter(([, value]) => [value.snapshot.service.id, value.snapshot.service.definitionId].includes(service.id)).map(([id]) => id);
    const builtin = service.id === lifecycle.BUILTIN_CATALOG_ID;
    return { builtin, approvals, registrations: registrations.map(item => item.id), consents: consents.map(item => item.id), contracts: contracts.map(item => item.id), seeded };
}
/** Validate the same full definition required by ordinary registration, without managed fields. */
function assertDefinition(service) {
    const definition = { resourceType: 'HealthcareService', name: service.name, extraDetails: service.extraDetails,
        type: service.type, category: service.category, extension: (service.extension || []).filter(item =>
            ![EXTENSIONS.serviceBusinessStatus, EXTENSIONS.approvalWindow, EXTENSIONS.basedOnCanonicalHealthcareService].includes(item.url)) };
    lifecycle.classifyRegistrationRequest(definition);
    // Compiler validation also rejects unknown mappings and unsupported history units.
    const canonical = { ...service, id: 'validation-catalog' };
    const instance = { extension: [{ url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: 'HealthcareService/validation-catalog' } }] };
    const store = { get: () => canonical };
    const buckets = require('./grant-compiler').serviceBuckets(store, instance);
    for (const bucket of buckets) require('./grant-compiler').historyStart(Math.floor(Date.now() / 1000), bucket.history);
}
/** Replace the managed state consistently; unknown extensions and ownership are preserved. */
function withStatus(service, state) {
    return { ...service, active: state === 'active', extension: [lifecycle.statusExtension(state),
        ...(service.extension || []).filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)] };
}
/** Explain actual usability independently of the stored service lifecycle. */
function usability(store, service) {
    if (service.active !== true || lifecycle.businessStatus(service) !== 'active') return 'Not usable: this record is not active.';
    if (store.privateRecords.services.getDefinition(service.id).status !== 'ok') return 'Not usable: the private service definition is missing or invalid.';
    if (lifecycle.serviceKind(service) === 'catalog') return 'Active shared definition; each provider also needs an active registration and organization.';
    const catalog = store.get('HealthcareService', lifecycle.basedOnId(service));
    if (!catalog?.active || lifecycle.businessStatus(catalog) !== 'active') return 'Not usable: the shared service definition is unavailable or inactive.';
    if (!organizationIsOperational(store, store.get('Organization', lifecycle.ownerId(service)))) return 'Not usable: the provider or its parent organization is unavailable or inactive.';
    return 'Usable only while Consent, source, scope and all current access checks pass.';
}
/** Compute target-specific availability, including safe dependency review and terminal denials. */
function serviceActions({ store, config, service }) {
    const kind = lifecycle.serviceKind(service), state = lifecycle.businessStatus(service);
    const refs = dependencies({ store, config, service });
    const actions = [];
    if (state === 'pending') actions.push('activate');
    if (state === 'active') actions.push('disable');
    if (kind === 'instance' && state === 'suspended' || kind === 'catalog' && state === 'frozen' && store.privateRecords.lifecycle.getState('HealthcareService', service.id)?.restoreEligible === true) actions.push('enable');
    const actionReasons = {};
    for (const action of ['activate', 'enable']) if (actions.includes(action)) {
        try {
            const definition = kind === 'catalog' ? service : store.get('HealthcareService', lifecycle.basedOnId(service));
            if (!definition) throw new Error('The shared service definition is unavailable.');
            assertDefinition(definition);
            if (kind === 'instance') {
                lifecycle.assertOperationalServiceProvider(store, store.get('Organization', lifecycle.ownerId(service)));
                if (lifecycle.businessStatus(definition) !== 'active' || definition.active !== true) throw new Error('Activate or enable the shared service definition first.');
            }
            require('./public-fhir').requireDefinition(store, definition);
        } catch (error) { actions.splice(actions.indexOf(action), 1); actionReasons[action] = error.message; }
    }
    if (kind === 'instance' && actions.includes('disable')) {
        try { lifecycle.assertOperationalServiceProvider(store, store.get('Organization', lifecycle.ownerId(service))); }
        catch (error) { actions.splice(actions.indexOf('disable'), 1); actionReasons.disable = error.message; }
    }
    const canDelete = !service.active && !refs.seeded && !refs.builtin && !refs.approvals.length && !refs.registrations.length && !refs.consents.length && !refs.contracts.length;
    if (canDelete) actions.push('delete');
    const history = [refs.consents.length && 'Consent', refs.contracts.length && 'Contract', refs.approvals.length && 'saved approval'].filter(Boolean).join(', ');
    return { actionReasons, actions: config.conformance.preset === 'strict' ? [] : actions, dependencies: refs,
        deleteReason: refs.builtin ? 'This built-in service is protected and cannot be deleted. Disable it to stop new use.' : refs.seeded ? 'This service is defined in the installation configuration. Change that configuration outside this screen before considering deletion; other references may still block it.'
            : refs.registrations.length ? 'This service is assigned to providers. Remove those assignments before deleting it.'
                : history ? `${history} history references this service. Preserve that history; disable the service instead. Removing provider assignments does not remove these references.`
                : service.active ? 'Disable this record before deletion.' : '',
        reason: config.conformance.preset === 'strict' ? 'Private sandbox actions are unavailable in strict mode.'
            : ['cancelled', 'rejected'].includes(state) ? 'Terminal records cannot be activated or enabled.' : '' };
}
/** Project a single private context without widening the ordinary service inventory.
 * Missing definitions remain an explicit prerequisite rather than another guessed target.
 */
function projectServiceContext({ store, config, selectedId, providerId }) {
    const selected = selectedId && store.get('HealthcareService', selectedId);
    if (!lifecycle.serviceKind(selected)) return { targets: [], missing: true, foreign: false };
    const linkedId = lifecycle.basedOnId(selected);
    const linked = linkedId && store.get('HealthcareService', linkedId);
    const targets = [linked, selected].filter(service => lifecycle.serviceKind(service)).map(service => {
        const availability = serviceActions({ store, config, service });
        const kind = lifecycle.serviceKind(service), state = lifecycle.businessStatus(service);
        const next = state === 'pending' ? 'activate' : state === 'active' ? 'disable'
            : state === 'suspended' || state === 'frozen' ? 'enable' : '';
        const labels = kind === 'catalog' ? { activate: 'Approve definition', disable: 'Pause shared definition', enable: 'Restore shared definition' }
            : { activate: 'Activate provider registration', disable: 'Pause provider registration', enable: 'Restore provider registration' };
        const blockers = Object.entries(availability.dependencies).filter(([, ids]) => Array.isArray(ids)).flatMap(([key, ids]) => ids.map(id => {
            const type = { registrations: 'HealthcareService', consents: 'Consent', contracts: 'Contract', approvals: 'Consent' }[key];
            const record = store.get(type, id.replace(/^Consent\//, ''));
            return `${type}: ${record?.name || record?.title || id}`;
        }));
        return { id: service.id, name: service.name, kind, state, version: service.meta.versionId,
            providerName: store.get('Organization', lifecycle.ownerId(service))?.name || lifecycle.ownerId(service) || 'Unknown provider',
            next, label: labels[next], blockers, ...availability };
    });
    return { selectedId, name: selected.name, foreign: lifecycle.serviceKind(selected) === 'instance' && lifecycle.ownerId(selected) !== providerId,
        missingDefinition: !!linkedId && !linked, targets };
}
/** Apply one version-bound operation atomically, including Consent and authority reconciliation.
 * @param {object} options Store/configuration, target, action, version, operator and audit sink.
 * @returns {object} Committed result without credentials.
 */
function applyServiceCommand({ store, config, id, action, expectedVersion, operator, audit, now = new Date() }) {
    const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
    if (config.conformance.preset === 'strict') throw Object.assign(new Error('Private sandbox actions are unavailable in strict mode.'), { status: 403 });
    if (typeof operator !== 'string' || !operator || typeof audit !== 'function') throw new Error('Authenticated operator and audit evidence are required.');
    return store.transaction(() => {
        const service = store.get('HealthcareService', id), kind = lifecycle.serviceKind(service);
        if (!service || !kind) throw Object.assign(new Error('Service not found.'), { status: 404 });
        if (typeof expectedVersion !== 'string' || expectedVersion !== service.meta?.versionId) fail('The service changed. Refresh and review its current state.');
        const availability = serviceActions({ store, config, service });
        if (!availability.actions.includes(action)) fail(availability.actionReasons[action] || (action === 'delete' ? availability.deleteReason : availability.reason) || 'This action is unavailable for the current service state.');
        const previous = lifecycle.businessStatus(service);
        let committed;
        if (action === 'delete') {
            store.remove('HealthcareService', id);
        } else {
            // Availability above validates the current definition and prerequisites
            // inside this same transaction before any state is committed.
            if (kind === 'instance' && action !== 'activate') {
                committed = lifecycle.transitionHealthcareService({ store, callerOrganization: store.get('Organization', lifecycle.ownerId(service)), existing: service,
                    request: { extension: [lifecycle.statusExtension(action === 'disable' ? 'suspended' : 'active')] } });
            } else {
                const next = withStatus(service, action === 'disable' ? 'frozen' : 'active');
                committed = store.update(next);
            }
            reconcileExpiredConsents({ store, now });
            const instances = kind === 'instance' ? [committed] : store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === id);
            for (const instance of instances) {
                const operational = lifecycle.serviceIsOperational(store, instance)
                    && organizationIsOperational(store, store.get('Organization', lifecycle.ownerId(instance)));
                reconcileConsentsForService({ store, serviceId: instance.id, serviceState: operational ? 'active' : 'suspended', now });
            }
        }
        const event = { visibility: 'diagnostic', component: 'pcm-services', operation: 'admin-service-command', operator, target: `HealthcareService/${id}`, targetKind: kind, action, previousStatus: previous,
            nextStatus: committed ? lifecycle.businessStatus(committed) : 'deleted', previousVersion: expectedVersion,
            version: committed?.meta.versionId || null, at: now.toISOString(), dependencies: availability.dependencies };
        const committedEvent = store.privateRecords.append('HealthcareService', id, event, { restoreEligible: action === 'disable' });
        store.afterCommit(() => audit({ ...event, eventId: committedEvent.eventId }));
        return { ...event, reviewTarget: action === 'delete' ? lifecycle.basedOnId(service) : id,
            message: action === 'delete' ? 'Deleted from this runtime. Restart/reset follows the configured bootstrap; no seed files were changed.'
            : 'Sandbox change saved. Consent-based access was reconciled. Cached positive decisions may remain usable for up to 30 seconds; disabled sandbox checks remain disabled.' };
    });
}
module.exports = { projectServiceContext, DISABLED, csrf, assertCommand, dependencies, usability, serviceActions, applyServiceCommand, assertDefinition };
