'use strict';

/** Authoritative PCM Consent request, decision, and effectiveness rules. */
const { randomUUID: uuidv4 } = require('crypto');
const {
    CODE_SYSTEMS,
    CONSENT_POLICY,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS,
    PROFILES,
    SECURITY
} = require('../../../shared/pcm-contract');
const { normalizePatientIdentifier, SANDBOX_GUID_TAG, sandboxIdentityOptions } = require('../../../shared/identity-mapping');
const {
    localReference,
    organizationIsOperational,
    organizationRole,
    participantEndpoint
} = require('./participant-lifecycle');
const {
    serviceIsOperational,
    serviceKind
} = require('./healthcare-service-lifecycle');

const SUBMIT_PROFILE = 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-consent-submit';
const DEACTIVATE_PROFILE = 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-consent-deactivate';
const SCOPE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/consentscope';
const ACT_CODE_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const PARTICIPATION_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType';
const BUSINESS_STATES = new Set([
    'requested', 'active', 'rejected', 'temporarily-inactive',
    'permanently-inactive', 'service-provider-cancelled'
]);
const TERMINAL_STATES = new Set(['rejected', 'permanently-inactive', 'service-provider-cancelled']);
const STATUS_BY_BUSINESS_STATE = Object.freeze({
    requested: 'proposed',
    active: 'active',
    rejected: 'rejected',
    'temporarily-inactive': 'inactive',
    'permanently-inactive': 'inactive',
    'service-provider-cancelled': 'inactive'
});
const DISPLAY_BY_BUSINESS_STATE = Object.freeze({
    requested: 'Requested',
    active: 'Active',
    rejected: 'Rejected',
    'temporarily-inactive': 'Temporarily inactive',
    'permanently-inactive': 'Permanently inactive',
    'service-provider-cancelled': 'Service Provider cancelled'
});
const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));

class ConsentLifecycleError extends Error {
    constructor(message, status = 400, code = 'business-rule') {
        super(message);
        this.name = 'ConsentLifecycleError';
        this.status = status;
        this.code = code;
    }
}

function extensions(resource, url) {
    return ensureArray(resource?.extension).filter(extension => extension.url === url);
}

function exactCoding(concept, system, code) {
    return ensureArray(concept?.coding).length === 1
        && concept.coding[0].system === system
        && concept.coding[0].code === code;
}

function assertNoModifierExtensions(value, location = 'resource') {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'modifierExtension')) {
        throw new ConsentLifecycleError(`Unsupported modifierExtension at ${location}`);
    }
    for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(child)) child.forEach((item, index) => assertNoModifierExtensions(item, `${location}.${key}[${index}]`));
        else if (child && typeof child === 'object') assertNoModifierExtensions(child, `${location}.${key}`);
    }
}

function consentBusinessStatus(consent) {
    const matches = extensions(consent, EXTENSIONS.consentBusinessStatus);
    if (matches.length !== 1) return null;
    const coding = matches[0].valueCoding;
    return coding?.system === CODE_SYSTEMS.consentBusinessStatus && BUSINESS_STATES.has(coding.code)
        ? coding.code
        : null;
}

function businessStatusExtension(code) {
    return {
        url: EXTENSIONS.consentBusinessStatus,
        valueCoding: {
            system: CODE_SYSTEMS.consentBusinessStatus,
            code,
            display: DISPLAY_BY_BUSINESS_STATE[code]
        }
    };
}

function patientIdentifier(consent) {
    const identifier = Array.isArray(consent?.patient?.identifier)
        ? (consent.patient.identifier.length === 1 ? consent.patient.identifier[0] : null)
        : consent?.patient?.identifier;
    if (!identifier) return null;
    try {
        return normalizePatientIdentifier(identifier, { allowSandboxGuid: consent.meta?.tag?.some(tag => tag.system === SANDBOX_GUID_TAG && tag.code === 'true') });
    } catch (_error) {
        return null;
    }
}

function consentServiceId(consent) {
    const matches = extensions(consent, EXTENSIONS.pcmService);
    if (matches.length !== 1) return null;
    return localReference(matches[0].valueReference?.reference, 'HealthcareService')?.id || null;
}

function actorHasRole(actor, code) {
    return exactCoding(actor?.role, PARTICIPATION_SYSTEM, code)
        && Boolean(localReference(actor.reference?.reference, 'Organization'));
}

function requesterId(consent) {
    const requesters = ensureArray(consent?.provision?.actor).filter(actor => actorHasRole(actor, 'IRCP'));
    return requesters.length === 1
        ? localReference(requesters[0].reference.reference, 'Organization').id
        : null;
}

function sourceIds(consent) {
    return ensureArray(consent?.provision?.actor)
        .filter(actor => actorHasRole(actor, 'CST'))
        .map(actor => localReference(actor.reference.reference, 'Organization').id);
}

function accessMode(consent) {
    const matches = ensureArray(consent?.category).filter(category => ensureArray(category.coding)
        .some(coding => coding.system === CODE_SYSTEMS.consentAccessMode));
    if (matches.length !== 1 || ensureArray(matches[0].coding).length !== 1) return null;
    const coding = matches[0].coding[0];
    return coding.system === CODE_SYSTEMS.consentAccessMode && ['one-time', 'continuous'].includes(coding.code)
        ? coding.code
        : null;
}

function accessModeCategory(code) {
    return { coding: [{
        system: CODE_SYSTEMS.consentAccessMode,
        code,
        display: code === 'one-time' ? 'One-time' : 'Continuous'
    }] };
}

function informationAccessCategory() {
    return { coding: [{ system: ACT_CODE_SYSTEM, code: 'INFA', display: 'information access' }] };
}

function assertPolicyEnvelope(resource) {
    if (ensureArray(resource?.policy).length !== 1
        || resource.policy[0]?.authority !== CONSENT_POLICY.authority
        || resource.policy[0]?.uri !== CONSENT_POLICY.uri
        || resource.policyRule !== undefined) {
        throw new ConsentLifecycleError('Consent requires exactly the fixed legal policy and prohibits policyRule (FHIR ppc-1)');
    }
}

function assertSubmitRequest(request, config) {
    assertNoModifierExtensions(request);
    assertPolicyEnvelope(request);
    if (request.status !== 'proposed' || !exactCoding(request.scope, SCOPE_SYSTEM, 'patient-privacy')) {
        throw new ConsentLifecycleError('Consent submit requires status=proposed and the exact patient-privacy scope');
    }
    if (ensureArray(request.category).length !== 1
        || !exactCoding(request.category[0], ACT_CODE_SYSTEM, 'INFA')) {
        throw new ConsentLifecycleError('Consent submit requires exactly the fixed INFA category');
    }
    if (request.patient?.reference !== undefined || Array.isArray(request.patient?.identifier)) {
        throw new ConsentLifecycleError('Consent.patient must be one identifier-only logical reference');
    }
    let normalized;
    try {
        normalized = normalizePatientIdentifier(request.patient?.identifier, sandboxIdentityOptions(config));
    } catch (error) {
        throw new ConsentLifecycleError(error.message);
    }
    const services = extensions(request, EXTENSIONS.pcmService);
    if (services.length !== 1 || !localReference(services[0].valueReference?.reference, 'HealthcareService')) {
        throw new ConsentLifecycleError('Consent submit requires exactly one local pcmService reference');
    }
    if (extensions(request, EXTENSIONS.consentBusinessStatus).length) {
        throw new ConsentLifecycleError('Consent business status is server-managed');
    }
    return normalized;
}

function assertOperationalRequester(store, callerOrganization) {
    if (organizationRole(callerOrganization) !== 'service-provider'
        || !organizationIsOperational(store, callerOrganization)) {
        throw new ConsentLifecycleError('Only an operational Service Provider may submit or cancel Consent', 403, 'forbidden');
    }
}

function durationExtension(service) {
    const matches = extensions(service, EXTENSIONS.accessDuration);
    return matches.length === 1 ? matches[0].valueDuration : null;
}

function serviceAccessMode(service) {
    const matches = extensions(service, EXTENSIONS.accessMode);
    return matches.length === 1 && ['one-time', 'continuous'].includes(matches[0].valueCode)
        ? matches[0].valueCode
        : null;
}

/** Add a positive UCUM duration using deterministic UTC calendar arithmetic. */
function addUcumDuration(start, duration) {
    if (!(start instanceof Date) || Number.isNaN(start.getTime())
        || typeof duration?.value !== 'number' || !Number.isFinite(duration.value) || duration.value <= 0
        || duration.system !== 'http://unitsofmeasure.org') return null;
    const result = new Date(start.getTime());
    const multiplier = { s: 1000, min: 60000, h: 3600000, d: 86400000, wk: 604800000 }[duration.code];
    if (multiplier) return new Date(start.getTime() + duration.value * multiplier);
    if (!Number.isInteger(duration.value) || !['mo', 'a'].includes(duration.code)) return null;
    const months = duration.value * (duration.code === 'a' ? 12 : 1);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
}

function operationalDataSources(store) {
    return store.getAll('Organization').filter(organization =>
        organizationRole(organization) === 'source'
        && organizationIsOperational(store, organization)
        && participantEndpoint(store, organization, { requireActive: true }));
}

function createConsent({ store, callerOrganization, request, config, clock = () => new Date(), idGenerator = uuidv4 }) {
    require('../public-fhir').assertPublic(request);
    assertOperationalRequester(store, callerOrganization);
    const patient = assertSubmitRequest(request, config);
    const serviceId = consentServiceId(request);
    const service = store.get('HealthcareService', serviceId);
    if (!serviceIsOperational(store, service) || serviceKind(service) !== 'instance') {
        throw new ConsentLifecycleError('Consent must reference an operational HealthcareService instance owned by the caller');
    }
    if (service.providedBy?.reference !== `Organization/${callerOrganization.id}`) {
        throw new ConsentLifecycleError('Consent HealthcareService does not belong to the requesting Service Provider', 403, 'forbidden');
    }
    const mode = serviceAccessMode(service);
    const maximumDuration = durationExtension(service);
    if (!mode || !addUcumDuration(clock(), maximumDuration)) {
        throw new ConsentLifecycleError('Consent service has no valid access mode and maximum duration', 409, 'conflict');
    }
    return store.transaction(() => {
        const logicalId = idGenerator();
        const businessId = idGenerator();
        const createdAt = clock();
        let created = store.create({
            resourceType: 'Consent',
            meta: {
                profile: [PROFILES.consent],
                ...(patient.sandboxSynthetic ? { tag: [{ system: SANDBOX_GUID_TAG, code: 'true' }] } : {}),
                ...((patient.synthetic || patient.sandboxSynthetic) ? { security: [{
                    system: SECURITY.system,
                    code: SECURITY.syntheticTestCode,
                    display: 'test health data'
                }] } : {})
            },
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.consent, value: `PCM-CONSENT-${String(businessId).toUpperCase()}` }],
            extension: [
                businessStatusExtension('requested'),
                { url: EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${service.id}` } }
            ],
            status: 'proposed',
            scope: { coding: [{ system: SCOPE_SYSTEM, code: 'patient-privacy' }] },
            category: [accessModeCategory(mode), informationAccessCategory()],
            patient: { identifier: { system: patient.system, value: patient.value } },
            dateTime: createdAt.toISOString(),
            policy: [{ authority: CONSENT_POLICY.authority, uri: CONSENT_POLICY.uri }],
            provision: {
                type: 'permit',
                purpose: [{ system: CODE_SYSTEMS.actReason, code: 'TREAT', display: 'treatment' }],
                actor: [{
                    role: { coding: [{ system: PARTICIPATION_SYSTEM, code: 'IRCP', display: 'information recipient' }] },
                    reference: { reference: `Organization/${callerOrganization.id}`, ...(callerOrganization.name ? { display: callerOrganization.name } : {}) }
                }]
            }
        }, () => {}, { id: logicalId });
        if (patient.synthetic) {
            created = approveConsent({
                store,
                consent: created,
                sourceOrganizationIds: operationalDataSources(store).map(source => source.id),
                clock,
                actor: { id: 'synthetic-test-auto-approval', simulation: true }
            });
        }
        return created;
    });
}

function replaceState(consent, state) {
    return {
        ...consent,
        status: STATUS_BY_BUSINESS_STATE[state],
        extension: [
            businessStatusExtension(state),
            ...ensureArray(consent.extension).filter(extension => extension.url !== EXTENSIONS.consentBusinessStatus)
        ]
    };
}

/** Atomically freeze an explicit complete scope, actor provenance and approval validity.
 * Caller supplies a current Consent/version; browser reviews additionally bind exact
 * service versions and generation time. Failures restore resources and authority state.
 */
function approveConsent({ store, consent, sourceOrganizationIds, approvedAccessMode, approvedEnd,
    scopeChoice = 'service-provided', customScope, expectedVersion = consent?.meta?.versionId, review,
    actor = { id: 'sandbox-operator', simulation: true }, clock = () => new Date() }) {
    return store.transaction(() => {
        const current = store.get('Consent', consent?.id);
        if (!current || current.meta?.versionId !== expectedVersion || consent?.meta?.versionId !== expectedVersion) {
            throw new ConsentLifecycleError('Consent changed; refresh and review the current request', 409, 'conflict');
        }
        // Use committed state, never a caller-mutated detached policy object.
        consent = current;
        if (consentBusinessStatus(consent) !== 'requested' || consent.status !== 'proposed') {
            throw new ConsentLifecycleError('Only a requested Consent may be approved', 409, 'conflict');
        }
        const service = store.get('HealthcareService', consentServiceId(consent));
        if (!serviceIsOperational(store, service)) {
            throw new ConsentLifecycleError('Consent service is not operational', 409, 'conflict');
        }
        const maximumMode = serviceAccessMode(service);
        const mode = approvedAccessMode || maximumMode;
        if (!['one-time', 'continuous'].includes(mode) || (maximumMode === 'one-time' && mode !== 'one-time')) {
            throw new ConsentLifecycleError('Patient decision may narrow but cannot widen the service access mode');
        }
        const start = clock();
        const cap = addUcumDuration(start, durationExtension(service));
        const requestedEnd = approvedEnd === undefined ? cap : new Date(approvedEnd);
        if (!cap || Number.isNaN(requestedEnd.getTime()) || requestedEnd <= start || requestedEnd > cap) {
            throw new ConsentLifecycleError('Patient-approved period must be positive and no longer than the service maximum');
        }
        if (sourceOrganizationIds !== undefined && (!Array.isArray(sourceOrganizationIds)
            || new Set(sourceOrganizationIds).size !== sourceOrganizationIds.length)) {
            throw new ConsentLifecycleError('Approved Data Source ids must be a unique array');
        }
        const selected = sourceOrganizationIds === undefined
            ? operationalDataSources(store)
            : sourceOrganizationIds.map(id => store.get('Organization', id));
        if (selected.some(source => !source || organizationRole(source) !== 'source'
            || !organizationIsOperational(store, source)
            || !participantEndpoint(store, source, { requireActive: true }))) {
            throw new ConsentLifecycleError('Every approved Data Source must be operational');
        }
        const requesterActors = ensureArray(consent.provision?.actor).filter(actor => actorHasRole(actor, 'IRCP'));
        const sourceActors = selected.map(source => ({
            role: { coding: [{ system: PARTICIPATION_SYSTEM, code: 'CST', display: 'custodian' }] },
            reference: { reference: `Organization/${source.id}`, ...(source.name ? { display: source.name } : {}) }
        }));
        const approved = replaceState(consent, 'active');
        approved.category = [accessModeCategory(mode), informationAccessCategory()];
        approved.provision = {
            ...approved.provision,
            type: 'permit',
            purpose: [{ system: CODE_SYSTEMS.actReason, code: 'TREAT', display: 'treatment' }],
            period: { start: start.toISOString(), end: requestedEnd.toISOString() },
            actor: [...requesterActors, ...sourceActors]
        };
        const { approvalScopeOptions, validateApprovalReview } = require('../approval-scopes');
        const { MODEL, approvalDiagnostics } = require('../../../shared/consent-scope-snapshot');
        const anchor = review ? validateApprovalReview(store, consent, review, start) : start.getTime() / 1000;
        const menu = approvalScopeOptions(store, service, { now: anchor });
        const selectedOption = menu.find(option => option.id === scopeChoice);
        if (!selectedOption && scopeChoice !== 'custom') throw new ConsentLifecycleError('Select an explicit approval scope choice');
        const scope = scopeChoice === 'custom' ? customScope : selectedOption.value;
        const diagnostics = approvalDiagnostics(scope);
        if (!actor || Object.keys(actor).sort().join(',') !== 'id,simulation' || typeof actor.id !== 'string' || !actor.id || typeof actor.simulation !== 'boolean') {
            throw new ConsentLifecycleError('Approval actor and simulation provenance are required');
        }
        const definitionId = require('./healthcare-service-lifecycle').basedOnId(service);
        const definition = store.get('HealthcareService', definitionId);
        const retained = require('../public-fhir').requireDefinition(store, service);
        const grant = retained.grant;
        const snapshot = { model: MODEL, scope, choice: scopeChoice,
            origin: scopeChoice === 'custom' ? 'manual' : scopeChoice === 'service-provided' ? `service-${selectedOption.origin}` : 'generated',
            service: { id: service.id, version: service.meta.versionId, definitionId, definitionVersion: retained.definitionVersion,
                grant: grant ? structuredClone(grant) : null },
            generator: scopeChoice === 'custom' ? null : selectedOption.generator,
            anchor: scopeChoice === 'custom' ? start.toISOString() : selectedOption.anchor,
            historyMode: scopeChoice === 'custom' ? 'manual-literal' : selectedOption.historyMode,
            actor: structuredClone(actor), approvedAt: start.toISOString(),
            validity: { mode, start: start.toISOString(), end: requestedEnd.toISOString() }, diagnostics,
            usable: Object.entries(diagnostics).every(([axis, value]) => axis === 'issues' || ['valid', 'supported'].includes(value)) };
        const committed = store.update(approved);
        store.privateRecords.approvals.createDecision({ consentId: committed.id, snapshot,
            expectedRevision: store.privateState.revision,
            expectedVersions: { [`Consent/${committed.id}`]: committed.meta.versionId,
                [`HealthcareService/${service.id}`]: service.meta.versionId,
                [`HealthcareService/${definition.id}`]: definition.meta.versionId } });
        return committed;
    });
}

function rejectConsent({ store, consent }) {
    if (consentBusinessStatus(consent) !== 'requested' || consent.status !== 'proposed') {
        throw new ConsentLifecycleError('Only a requested Consent may be rejected', 409, 'conflict');
    }
    const rejected = replaceState(consent, 'rejected');
    delete rejected.provision.period;
    rejected.provision.actor = ensureArray(rejected.provision.actor).filter(actor => actorHasRole(actor, 'IRCP'));
    return store.privateRecords.lifecycle.command({ type: 'Consent', id: consent.id, resource: rejected,
        event: { kind: 'rejection', consentId: consent.id, at: store.clock().toISOString() }, expectedRevision: store.privateState.revision,
        expectedVersions: { [`Consent/${consent.id}`]: consent.meta.versionId } }).resource;
}

function assertDeactivateRequest(request) {
    assertNoModifierExtensions(request);
    assertPolicyEnvelope(request);
    if (request.status !== 'inactive' || !exactCoding(request.scope, SCOPE_SYSTEM, 'patient-privacy')
        || ensureArray(request.category).length !== 1
        || !exactCoding(request.category[0], ACT_CODE_SYSTEM, 'INFA')) {
        throw new ConsentLifecycleError('Consent deactivation requires the exact inactive/patient-privacy/INFA envelope');
    }
}

function cancelConsent({ store, callerOrganization, consent, request, event }) {
    require('../public-fhir').assertPublic(request);
    assertOperationalRequester(store, callerOrganization);
    assertDeactivateRequest(request);
    if (requesterId(consent) !== callerOrganization.id) {
        throw new ConsentLifecycleError('Only the requesting Service Provider may cancel this Consent', 403, 'forbidden');
    }
    const state = consentBusinessStatus(consent);
    if (state === 'service-provider-cancelled') return consent;
    if (!['requested', 'active'].includes(state)) {
        throw new ConsentLifecycleError('This Consent is terminal or cannot be cancelled by its provider', 409, 'conflict');
    }
    return store.privateRecords.lifecycle.command({ type: 'Consent', id: consent.id, resource: replaceState(consent, 'service-provider-cancelled'),
        event: event || { kind: 'provider-cancellation', consentId: consent.id, provider: callerOrganization.id, previousState: state, newState: 'service-provider-cancelled', at: store.clock().toISOString() },
        expectedRevision: store.privateState.revision, expectedVersions: { [`Consent/${consent.id}`]: consent.meta.versionId } }).resource;
}

function consentIsActive(consent, now = Date.now()) {
    // OAuth services use integer NumericDate seconds. Treat that value as the
    // complete represented second so a Consent approved milliseconds earlier
    // in the same second is immediately usable.
    const nowMs = now instanceof Date ? now.getTime() : (now < 100000000000 ? (now * 1000) + 999 : now);
    if (!consent || consent.status !== 'active' || consentBusinessStatus(consent) !== 'active') return false;
    const period = consent.provision?.period;
    const start = Date.parse(period?.start);
    const end = Date.parse(period?.end);
    return Number.isFinite(start) && Number.isFinite(end) && start < end && start <= nowMs && end > nowMs;
}

/** Validate a complete authoritative Consent snapshot against PCM invariants. */
function assertConsentResource(consent) {
    assertPolicyEnvelope(consent);
    const identifier = ensureArray(consent?.identifier);
    const state = consentBusinessStatus(consent);
    const statusMatches = STATUS_BY_BUSINESS_STATE[state] === consent?.status
        || (state === 'permanently-inactive' && consent?.status === 'entered-in-error');
    if (!ensureArray(consent?.meta?.profile).includes(PROFILES.consent)
        || identifier.length !== 1 || identifier[0].use !== 'official'
        || identifier[0].system !== IDENTIFIER_SYSTEMS.consent || !identifier[0].value
        || !state || !statusMatches
        || !exactCoding(consent.scope, SCOPE_SYSTEM, 'patient-privacy')
        || ensureArray(consent.category).length !== 2
        || !ensureArray(consent.category).some(category => exactCoding(category, ACT_CODE_SYSTEM, 'INFA'))
        || !accessMode(consent)
        || !consentServiceId(consent)
        || !requesterId(consent)
        || consent.provision?.type !== 'permit'
        || ensureArray(consent.provision?.purpose).length !== 1
        || consent.provision.purpose[0].system !== CODE_SYSTEMS.actReason
        || consent.provision.purpose[0].code !== 'TREAT'
        || !patientIdentifier(consent)
        || !Number.isFinite(Date.parse(consent.dateTime))) {
        throw new ConsentLifecycleError('Consent is not a complete authoritative PCM Consent');
    }
    const period = consent.provision?.period;
    const sources = sourceIds(consent);
    if (state === 'active') {
        if (!period || !Number.isFinite(Date.parse(period.start)) || !Number.isFinite(Date.parse(period.end))
            || Date.parse(period.end) <= Date.parse(period.start)) {
            throw new ConsentLifecycleError('Active Consent requires an ordered approval period');
        }
    } else if (['requested', 'rejected'].includes(state) && (period !== undefined || sources.length)) {
        throw new ConsentLifecycleError('Requested and rejected Consents cannot contain a period or Data Source actor');
    }
    const patient = patientIdentifier(consent);
    const htest = ensureArray(consent.meta?.security).filter(coding =>
        coding.system === SECURITY.system && coding.code === SECURITY.syntheticTestCode);
    if (Boolean(patient.synthetic || patient.sandboxSynthetic) !== (htest.length === 1)) {
        throw new ConsentLifecycleError('Synthetic test patient and HTEST security label must be present together');
    }
    return true;
}

function expireConsent({ store, consent, now = new Date() }) {
    if (consentBusinessStatus(consent) !== 'active') return consent;
    if (consentIsActive(consent, now)) return consent;
    const end = Date.parse(consent.provision?.period?.end);
    if (!Number.isFinite(end) || end > now.getTime()) return consent;
    return setPolicyState({ store, consent, state: 'permanently-inactive', now, cause: 'approval-period-expired' });
}

function reconcileExpiredConsents({ store, now = new Date() }) {
    const changed = [];
    for (const consent of store.getAll('Consent')) {
        const expired = expireConsent({ store, consent, now });
        if (expired.meta?.versionId !== consent.meta?.versionId) changed.push(expired);
    }
    return changed;
}

function setPolicyState({ store, consent, state, now = new Date(), cause }) {
    const current = consentBusinessStatus(consent);
    if (!['temporarily-inactive', 'permanently-inactive', 'active'].includes(state)) {
        throw new ConsentLifecycleError('Unsupported PCM-managed Consent state');
    }
    if (TERMINAL_STATES.has(current)) {
        throw new ConsentLifecycleError('Terminal Consent state cannot be restored or changed', 409, 'conflict');
    }
    if (state === 'active') {
        if (current !== 'temporarily-inactive' || !consentIsActive(replaceState(consent, 'active'), now)) {
            throw new ConsentLifecycleError('Temporarily inactive Consent cannot currently be restored', 409, 'conflict');
        }
        const service = store.get('HealthcareService', consentServiceId(consent));
        if (!serviceIsOperational(store, service)) {
            throw new ConsentLifecycleError('Consent prerequisites are not operational', 409, 'conflict');
        }
    }
    const next = replaceState(consent, state);
    const event = { kind: 'status-change', consentId: consent.id, previousState: current, newState: state,
        ...(cause ? { cause } : {}), operator: 'PCM lifecycle', provider: 'PCM', at: now.toISOString(),
        previousVersion: consent.meta.versionId, version: String(Number(consent.meta.versionId) + 1) };
    return store.privateRecords.lifecycle.command({ type: 'Consent', id: consent.id, resource: next, event,
        expectedRevision: store.privateState.revision, expectedVersions: { [`Consent/${consent.id}`]: consent.meta.versionId } }).resource;
}

function reconcileConsentsForService({ store, serviceId, serviceState, now = new Date() }) {
    const target = serviceState === 'suspended' ? 'temporarily-inactive'
        : (serviceState === 'active' ? 'active' : (serviceState === 'cancelled' ? 'permanently-inactive' : null));
    if (!target) return [];
    const changed = [];
    for (const consent of store.getAll('Consent').filter(item => consentServiceId(item) === serviceId)) {
        const current = consentBusinessStatus(consent);
        if ((target === 'temporarily-inactive' && current !== 'active')
            || (target === 'active' && current !== 'temporarily-inactive')
            || (target === 'permanently-inactive' && !['active', 'temporarily-inactive'].includes(current))) continue;
        try {
            changed.push(setPolicyState({ store, consent, state: target, now, cause: `service-${serviceState}` }));
        } catch (error) {
            if (!(target === 'active' && error instanceof ConsentLifecycleError)) throw error;
        }
    }
    return changed;
}

function findMatchingConsentRequests(store, { requesterOrganizationId, patient, serviceId }) {
    const normalized = normalizePatientIdentifier(patient);
    return store.getAll('Consent').filter(consent => {
        const currentPatient = patientIdentifier(consent);
        return requesterId(consent) === requesterOrganizationId
            && consentServiceId(consent) === serviceId
            && currentPatient?.key === normalized.key;
    });
}

module.exports = {
    ConsentLifecycleError,
    DEACTIVATE_PROFILE,
    SUBMIT_PROFILE,
    accessMode,
    addUcumDuration,
    approveConsent,
    assertConsentResource,
    assertDeactivateRequest,
    assertPolicyEnvelope,
    assertSubmitRequest,
    businessStatusExtension,
    cancelConsent,
    consentBusinessStatus,
    consentIsActive,
    consentServiceId,
    createConsent,
    expireConsent,
    findMatchingConsentRequests,
    patientIdentifier,
    reconcileExpiredConsents,
    reconcileConsentsForService,
    rejectConsent,
    requesterId,
    setPolicyState,
    sourceIds
};
