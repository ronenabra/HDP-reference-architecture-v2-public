'use strict';
/** Private sandbox source simulation; this never repeats approval or changes patient policy. */
const { ConsentLifecycleError, assertConsentResource, consentIsActive, sourceIds, requesterId, consentServiceId } = require('./consent-lifecycle');
const { organizationIsOperational, organizationRole, participantEndpoint } = require('./participant-lifecycle');
const { serviceIsOperational } = require('./healthcare-service-lifecycle');
const { getConfiguredDataSources } = require('../data-sources');
const TAG = 'urn:pcm:sandbox:source-change';
const CODE = 'source-set-v1';
const PARTICIPATION = 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType';
const NOTICE = 'Sandbox only: changes the sources on this existing consent to simulate newly available data sources. This action is not available in the live system and is not a new patient approval.';

/** Return whether server-managed simulation provenance requires exact source binding. */
function hasSourceSimulation(consent, store) { return Boolean(consent && store?.privateRecords.lifecycle.getState('Consent', consent.id)?.exactSourceMembership); }
/** An empty active decision remains exact even when Apply is a no-op and adds no simulation metadata. */
function requiresExactSourceMembership(consent, store) {
    return hasSourceSimulation(consent, store) || (consent?.status === 'active' && sourceIds(consent).length === 0);
}
/** Read the latest committed source event from its typed owner; public tags are never evidence. */
function sourceSimulationAudit(consent, store) {
    return store?.privateRecords.lifecycle.getEvents('Consent', consent.id)
        .filter(event => event.provenance === 'sandbox-source-simulation').at(-1) || null;
}
/** Test the explicit connectathon gate; retained configuration cannot enable the action in strict. */
function sandboxEnabled(config) { return require('../../../shared/conformance-policy').sandboxSourceChangesAllowed(config); }
/** Project current and registered sources for display, keeping unavailable current actors removable. */
function sourceChangeView({ store, config, consent, now = new Date() }) {
    const current = new Set(sourceIds(consent));
    const configured = new Map(getConfiguredDataSources(config).map(source => [source.id, source]));
    const ids = new Set([...configured.keys(), ...current]);
    const choices = [...ids].map(id => {
        const organization = store.get('Organization', id), source = configured.get(id);
        const endpoint = participantEndpoint(store, organization, { requireActive: true });
        const eligible = Boolean(source && organizationRole(organization) === 'source'
            && organizationIsOperational(store, organization) && endpoint?.address === source.endpoint);
        return { id, name: organization?.name || source?.name || id, endpoint: endpoint?.address || source?.endpoint || '',
            selected: current.has(id), registered: organizationRole(organization) === 'source', eligible, state: eligible ? 'available' : 'unavailable' };
    });
    const canEdit = sandboxEnabled(config) && consentIsActive(consent, now)
        && organizationIsOperational(store, store.get('Organization', requesterId(consent)))
        && serviceIsOperational(store, store.get('HealthcareService', consentServiceId(consent)));
    return { notice: NOTICE, canEdit, choices,
        current: [...current], version: consent.meta?.versionId, audit: sourceSimulationAudit(consent, store) };
}

/** Direct private helpers accept source-only commands, never ignored policy fields. */
function assertSourceFields(options, allowed) {
    if (!options || Object.keys(options).some(key => !allowed.includes(key))) throw new ConsentLifecycleError('Source commands accept source changes only; approval fields are read-only');
}

/** Validate one complete source set against the current version; return a detached preview without writes. */
function previewSourceChange(options) {
    assertSourceFields(options, ['store', 'config', 'consentId', 'expectedVersion', 'sourceOrganizationIds', 'now']);
    const { store, config, consentId, expectedVersion, sourceOrganizationIds, now = new Date() } = options;
    if (!sandboxEnabled(config)) throw new ConsentLifecycleError('Source simulation is available only in a connectathon sandbox', 403, 'forbidden');
    const consent = store.get('Consent', consentId);
    if (!consent) throw new ConsentLifecycleError('Consent was not found', 404, 'not-found');
    if (typeof expectedVersion !== 'string' || !/^[1-9][0-9]*$/.test(expectedVersion)) throw new ConsentLifecycleError('Displayed Consent version is required');
    if (expectedVersion !== consent.meta?.versionId) throw new ConsentLifecycleError('Consent changed in another tab; refresh and review current sources', 409, 'conflict');
    assertConsentResource(consent);
    if (store.privateRecords.approvals.getDecision(consent.id).status !== 'ok') throw new ConsentLifecycleError('Private approval authority is missing or invalid', 409, 'conflict');
    if (!consentIsActive(consent, now) || !organizationIsOperational(store, store.get('Organization', requesterId(consent)))
        || !serviceIsOperational(store, store.get('HealthcareService', consentServiceId(consent)))) throw new ConsentLifecycleError('Only a currently effective active Consent can simulate source changes', 409, 'conflict');
    if (!Array.isArray(sourceOrganizationIds) || sourceOrganizationIds.some(id => typeof id !== 'string')
        || new Set(sourceOrganizationIds).size !== sourceOrganizationIds.length) throw new ConsentLifecycleError('Sources must be an explicit unique array, including an empty array for zero sources');
    const view = sourceChangeView({ store, config, consent, now });
    const choices = new Map(view.choices.map(choice => [choice.id, choice]));
    const before = view.current, after = [...sourceOrganizationIds], current = new Set(before);
    for (const id of after) {
        const choice = choices.get(id);
        if (!choice || !choice.registered || (!current.has(id) && !choice.eligible)) throw new ConsentLifecycleError('Unknown, non-source or newly unavailable source cannot be added');
    }
    return { consent, before, after, added: after.filter(id => !current.has(id)), removed: before.filter(id => !after.includes(id)), version: view.version };
}

/** Apply a validated set atomically, preserving every non-source policy field and emitting separate audit metadata. */
function simulateSourceChange(options) {
    assertSourceFields(options, ['store', 'config', 'consentId', 'expectedVersion', 'sourceOrganizationIds', 'actor', 'sessionId', 'audit', 'clock']);
    const { store, config, consentId, expectedVersion, sourceOrganizationIds, actor, sessionId, audit, clock = () => new Date() } = options;
    const plan = previewSourceChange({ store, config, consentId, expectedVersion, sourceOrganizationIds, now: clock() });
    if (!plan.added.length && !plan.removed.length) return { ...plan, state: 'unchanged', audit: null };
    if (typeof actor !== 'string' || !actor || typeof sessionId !== 'string' || !sessionId || typeof audit !== 'function') throw new ConsentLifecycleError('Server operator and audit context are required');
    const isSourceActor = item => item.role?.coding?.some(coding => coding.system === PARTICIPATION && coding.code === 'CST');
    const existing = new Map((plan.consent.provision.actor || []).filter(isSourceActor).map(item => [item.reference.reference.split('/')[1], item]));
    const desired = plan.after.map(id => existing.get(id) || {
        role: { coding: [{ system: PARTICIPATION, code: 'CST', display: 'custodian' }] },
        reference: { reference: `Organization/${id}`, display: store.get('Organization', id).name || id }
    });
    const next = structuredClone(plan.consent), actors = []; let inserted = false;
    for (const item of next.provision.actor) {
        if (isSourceActor(item)) { if (!inserted) actors.push(...desired); inserted = true; }
        else actors.push(item);
    }
    if (!inserted) actors.push(...desired);
    next.provision.actor = actors;
    const event = { provenance: 'sandbox-source-simulation', consentId, actor, sessionId, at: clock().toISOString(),
        previousVersion: plan.version, version: String(Number(plan.version) + 1), before: plan.before, after: plan.after, added: plan.added, removed: plan.removed };
    assertConsentResource(next);
    return store.transaction(() => {
        const committed = store.privateRecords.lifecycle.command({ type: 'Consent', id: consentId, resource: next, event,
            state: { exactSourceMembership: true, sources: plan.after }, expectedRevision: store.privateState.revision, expectedVersions: { [`Consent/${consentId}`]: expectedVersion } });
        const consent = committed.resource;
        store.afterCommit(() => audit({ ...event, eventId: committed.eventId }));
        return { ...plan, state: 'applied', consent, audit: event };
    });
}
module.exports = { TAG, CODE, NOTICE, hasSourceSimulation, requiresExactSourceMembership, sourceSimulationAudit, sandboxEnabled, sourceChangeView, previewSourceChange, simulateSourceChange };
