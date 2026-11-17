'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { NATIVE_FILTER_CONTROLS } = require('../../src/shared/conformance-policy');
const { qualifyEasyCountControls } = require('./gateway-count-control-matrix');
/** Model the observable policy and ordinary issuance steps without a runtime or data mutation. */
function fixture() {
    let enabled = false;
    const events = [];
    return { events, dependencies: {
        snapshot: () => ({ preset: 'connectathon-easy', transportChecks: enabled, policyVersion: 'pcm-sandbox-policy/4',
            sourceControls: Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].map(ho => [ho,
                Object.fromEntries(NATIVE_FILTER_CONTROLS.map(name => [name, true]))])) }),
        createConsent: async () => { events.push(`ordinary-consent-${enabled}`); return {}; },
        qualify: async () => { events.push(`count-${enabled}`); return [{ nativeFiltering: true }]; },
        enableTransportChecks: async () => { events.push('enable-transport'); enabled = true; return { status: 200 }; },
        restore: async () => { events.push('restore'); enabled = false; return { status: 200 }; }
    } };
}

test('easy API count proof retains enforced authority across both transport profiles with ordinary Consent setup and restores defaults', async () => {
    const f = fixture(), result = await qualifyEasyCountControls(f.dependencies);
    assert.equal(result.status, 'pass'); assert.deepEqual(result.scenarios.map(s => s.nativeFiltering), [true, true]);
    assert.deepEqual(f.events, ['ordinary-consent-false', 'count-false', 'enable-transport', 'ordinary-consent-true', 'count-true', 'restore']);
});
test('a failed ordinary-token proof restores policy and never claims success', async () => {
    const f = fixture(); f.dependencies.qualify = async () => { throw new Error('actual gateway failure'); };
    await assert.rejects(qualifyEasyCountControls(f.dependencies), /actual gateway failure/);
    assert.equal(f.events.at(-1), 'restore'); assert.ok(!f.events.includes('enable-transport'));
});
test('wrong effective source policy is rejected and restored', async () => {
    const f = fixture(), original = f.dependencies.snapshot;
    f.dependencies.snapshot = () => { const s = original(); s.sourceControls['ho-b'].smartScopes = false; return s; };
    await assert.rejects(qualifyEasyCountControls(f.dependencies), /mandatory native/);
    assert.equal(f.events.at(-1), 'restore');
});
test('failed preset restoration blocks a passing API verdict', async () => {
    const f = fixture(); f.dependencies.restore = async () => ({ status: 500 });
    await assert.rejects(qualifyEasyCountControls(f.dependencies), /restore the named easy preset/);
});
