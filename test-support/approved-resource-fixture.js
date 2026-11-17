'use strict';

/** Lifecycle-created exact approvals for small protocol-unit resource graphs. */
const { FHIRStore } = require('../src/pcm-core/src/fhir/store');
const { EXTENSIONS } = require('../src/shared/pcm-contract');
const { serviceDefinitionDraft } = require('../src/pcm-core/src/service-definition-form');
const { createConsent, approveConsent } = require('../src/pcm-core/src/fhir/consent-lifecycle');
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
const SCOPE = `patient/Patient.rs?${V} patient/Observation.rs?${V}`;
const CEILING = 'patient/Patient.rs patient/Observation.rs';
const checkpoints = new WeakMap();

/** Restore a fixture's separate private checkpoint without putting it on a FHIR resource. */
function installApprovedResources(store, resources) {
    const checkpoint = checkpoints.get(resources);
    if (!checkpoint) throw new Error('Owned approval checkpoint is required');
    require('../src/pcm-core/src/migration-checkpoint').hydrate(store, checkpoint, { rollback: true });
    // Negative protocol tests deliberately corrupt a persisted public fact after restoring valid authority.
    store.data = Object.fromEntries(Object.keys(store.emptyData()).map(type => [type, new Map(resources.filter(resource => resource.resourceType === type).map(resource => [resource.id, structuredClone(resource)]))]));
    return store;
}

/** Create a new owned decision; never attach inferred metadata to a decided legacy Consent. */
function approveResources(resources, { mode = 'continuous', scope = SCOPE, end = 10800, now = 0 } = {}) {
    const legacy = resources.find(item => item.resourceType === 'Consent');
    const instanceId = legacy.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference.slice('HealthcareService/'.length);
    const instance = resources.find(item => item.id === instanceId && item.resourceType === 'HealthcareService');
    const definition = serviceDefinitionDraft({ name: 'Explicit protocol fixture', purpose: 'Owned lifecycle approval', category: '35', accessMode: mode,
        duration: end / 3600, durationUnit: 'h', allowChanges: true, buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'a', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 'rs' }], scopeOrigin: 'custom', approvalScope: scope }, { now });
    // The ordinary service duration binds this fresh approval; later tests never edit it to renew access.
    const store = new FHIRStore();
    store.authorityState.epoch = 'isolated-unit-fixture';
    for (const resource of resources.filter(item => item.resourceType !== 'Consent')) {
        if (resource.resourceType === 'HealthcareService') {
            resource.extension = [...resource.extension.filter(item => [EXTENSIONS.serviceBusinessStatus, EXTENSIONS.basedOnCanonicalHealthcareService].includes(item.url)), ...definition.extension];
        }
        require('../src/pcm-core/src/public-fhir').publishNewResource(store, resource);
    }
    const request = structuredClone(require('../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
    request.patient = legacy.patient;
    request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${instanceId}`;
    let sequence = 0;
    const pending = createConsent({ store, config: require('./team-config').buildTeamConfig(), request,
        callerOrganization: store.get('Organization', instance.providedBy.reference.slice('Organization/'.length)),
        clock: () => new Date(now * 1000), idGenerator: () => sequence++ ? 'UNIT' : legacy.id });
    if (pending.status === 'proposed') approveConsent({ store, consent: pending, scopeChoice: 'service-provided', clock: () => new Date(now * 1000),
        sourceOrganizationIds: legacy.provision.actor.filter(actor => actor.role?.coding?.some(code => code.code === 'CST')).map(actor => actor.reference.reference.slice('Organization/'.length)) });
    const result = Object.values(store.data).flatMap(values => [...values.values()].map(value => structuredClone(value)));
    checkpoints.set(result, require('../src/pcm-core/src/migration-checkpoint').snapshot(store, { privateState: true }));
    return result;
}
module.exports = { approveResources, installApprovedResources, SCOPE, CEILING, V };
