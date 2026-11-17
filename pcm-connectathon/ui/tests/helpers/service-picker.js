'use strict';

/** Verify the demo's current ordinary picker without treating its prompt as authority. */
const assert = require('node:assert/strict');

/**
 * Compare rendered options with the selected provider's exact configured registrations.
 * @param {object[]} options Actual picker option values, text, stamp and disabled state.
 * @param {object} config Current selected team's config, read from its Admin status API.
 * @param {string} identity Doctor identity whose ordinary picker is displayed.
 * @returns {{ids: string[], laboratoryId: string, laboratoryStamp: string}} Verified owned choices.
 */
function verifyOwnedPicker(options, config, identity) {
    const owner = { 'hospital-a': ['doctor', 'serviceProvider'], 'hospital-b': ['doctor-b', 'hospitalBServiceProvider'] }[identity];
    assert.ok(owner, 'Known ordinary Doctor provider required');
    const bindings = (config.serviceCatalog?.bindings || []).filter(binding => binding.application === owner[0] && binding.providerRole === owner[1]);
    assert.equal(bindings.length, 5, 'Demo fixture must configure five owned registrations');
    const ids = bindings.map(binding => binding.instanceId);
    assert.equal(new Set(ids).size, 5, 'Configured owned registration identities must be distinct');
    assert.equal(new Set(bindings.map(binding => binding.serviceKey)).size, 5, 'Configured clinical service keys must be distinct');
    const prompts = options.filter(option => option.value === '');
    assert.equal(prompts.length, 1, 'Exactly one empty registration prompt required');
    assert.equal(prompts[0].text, 'Choose a clinical service');
    assert.equal(prompts[0].disabled, false, 'Registration prompt must remain available');
    assert.equal(prompts[0].stamp, null, 'Empty prompt carries no service stamp');
    const registrations = options.filter(option => option.value !== '');
    assert.equal(registrations.length, 5, 'Only the five nonempty owned choices are registrations');
    assert.equal(new Set(registrations.map(option => option.value)).size, 5, 'Duplicate picker registration');
    assert.deepEqual(registrations.map(option => option.value).sort(), [...ids].sort(), 'Picker must contain the exact owned IDs, with no foreign registration');
    for (const option of registrations) assert.match(option.stamp || '', /^[0-9a-f]{64}$/, 'Each actual registration retains its exact version stamp');
    const laboratoryId = bindings.find(binding => binding.serviceKey === 'lab-follow-up')?.instanceId;
    const laboratory = registrations.find(option => option.value === laboratoryId);
    assert.ok(laboratory && !laboratory.disabled, 'Owned laboratory registration must be ready for this positive journey');
    return { ids, laboratoryId, laboratoryStamp: laboratory.stamp };
}

module.exports = { verifyOwnedPicker };
