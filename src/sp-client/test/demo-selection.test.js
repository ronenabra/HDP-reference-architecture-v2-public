'use strict';
/** Application/patient/service changes invalidate stale local access state exactly once. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { SelectionState } = require('../src/selection-state');
test('patient, service and identity contexts remain distinct and changes clear state', () => {
    const changes = [];
    const state = new SelectionState(identity => changes.push(identity));
    state.select('a', 'system|1', 'lab'); state.select('a', 'system|1', 'lab');
    assert.equal(changes.length, 1);
    state.select('a', 'system|2', 'lab'); state.select('a', 'system|2', 'medications');
    state.select('b', 'system|1', 'lab');
    assert.deepEqual(state.get('a'), { patientId: 'system|2', serviceId: 'medications' });
    assert.deepEqual(changes, ['a','a','a','b']);
    state.clear(); assert.equal(state.get('a'), undefined);
});

test('catalog projection excludes canonicals and foreign instances and disables inactive owned ones', () => {
    require('../../../test-support/team-config').installTestRuntime();
    const { EXTENSIONS, PROFILES, CODE_SYSTEMS } = require('../../shared/pcm-contract');
    const { projectOwnedServices } = require('../src/client');
    const service = { meta: { profile: [PROFILES.healthcareServiceInstance] }, resourceType: 'HealthcareService', id: 'mine', active: true, providedBy: { reference: 'Organization/sp' }, extension: [{ url: EXTENSIONS.serviceBusinessStatus, valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'active' } }, { url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: 'HealthcareService/catalog' } }, { url: EXTENSIONS.informationBucket, extension: [{ url: 'bucket', valueCodeableConcept: { coding: [{ code: 'laboratoryTests' }] } }] }] };
    const bundle = { entry: [service, { ...service, id: 'foreign', providedBy: { reference: 'Organization/other' } }, { ...service, id: 'inactive', active: false }, { ...service, id: 'canonical', extension: [] }].map(resource => ({ resource })) };
    bundle.entry.push({ resource: { ...service, id: 'catalog', providedBy: undefined, meta: { profile: [PROFILES.healthcareServiceCanonical] }, extension: service.extension.filter(item => item.url !== EXTENSIONS.basedOnCanonicalHealthcareService) } });
    const result = projectOwnedServices(bundle, 'sp', { id: 'sp', active: true });
    assert.deepEqual(result.map(item => item.id), ['mine', 'inactive']);
    assert.equal(result[1].available, false);
    assert.equal(result[0].scope, 'patient/Patient.rs');
    assert.equal(result[0].permissions.usable, true);
    assert.equal(result[0].permissions.mapping, 'doctor-clinical-intent/1');
    // The accepted public-category mapping supplies request intent, never a saved approval.
    assert.match(result[0].permissions.message, /granted permissions are not yet obtained/);
});
