'use strict';
/** Practical accepted/rejected combinations for the existing simulation controls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRESETS, validateSimulationDependencies, SIMULATION_CONTROLS, NATIVE_FILTER_CONTROLS, buildEffectivePolicy, presetSimulationDefaults, simulationPolicyStamp } = require('../../src/shared/conformance-policy');
const example = require('../example-team-config.json');

function config(preset = 'connectathon-balanced', overrides = {}) {
    const value = structuredClone(example);
    value.conformance.preset = preset;
    value.securitySimulation.global = { ...presetSimulationDefaults(preset), ...overrides };
    return value;
}

test('individual controls either remain independently enforceable or return explicit native dependencies', () => {
    for (const name of SIMULATION_CONTROLS) {
        const value = config('connectathon-balanced', { [name]: false });
        if (NATIVE_FILTER_CONTROLS.includes(name) || ['oauthBearer', 'patientIdentifier'].includes(name)) {
            assert.throws(() => buildEffectivePolicy(value, {}), /require|together/, name);
        } else {
            const controls = buildEffectivePolicy(value, {}).simulation.controls;
            assert.equal(controls[name], false);
            assert.equal(controls.resultFiltering, true);
        }
    }
    const easy = buildEffectivePolicy(config('connectathon-easy'), {});
    assert.equal(easy.simulation.controls.smartScopes, true);
    assert.equal(easy.simulation.controls.oauthBearer, true);
    assert.equal(buildEffectivePolicy(config('connectathon-easy', { clientAssertionSignature: true }), {}).simulation.controls.clientAssertionSignature, true);
    assert.throws(() => buildEffectivePolicy(config('connectathon-easy', { oauthBearer: true }), {}), /unknown/);
});

test('source changes preserve other sources and invalidate policy fingerprints', () => {
    const value = config();
    value.securitySimulation.perSource = { ...value.securitySimulation.perSource, 'ho-a': { clientAssertionReplay: false } };
    const policy = buildEffectivePolicy(value, {});
    assert.equal(policy.simulation.perSource['ho-a'].clientAssertionReplay, false);
    assert.equal(policy.simulation.controls.clientAssertionReplay, true);
    const old = simulationPolicyStamp(policy.simulation.controls, 'ho-a');
    assert.notEqual(old, simulationPolicyStamp(policy.simulation.perSource['ho-a'], 'ho-a'));
    assert.notEqual(old, simulationPolicyStamp(policy.simulation.controls, 'ho-b'));
    assert.notEqual(old, simulationPolicyStamp(policy.simulation.controls, 'ho-a', 1));
});

/** Keep the operator browser probe invalid even when all native filters default off. */
test('operator dependency probe rejects mixed native filters in every preset', () => {
    for (const preset of PRESETS) {
        assert.throws(() => validateSimulationDependencies({
            ...presetSimulationDefaults(preset), history: false, paging: true
        }), /required/, preset);
    }
    assert.throws(() => validateSimulationDependencies({
        ...presetSimulationDefaults('connectathon-easy'), history: false
    }), /required/);
});
