'use strict';
/** Direct starts cannot silently change Compose health configuration on a later import. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { planReadinessState } = require('../scripts/readiness-state');

test('default start persists its selected grace and retains a longer stored budget', () => {
    const original = 'TEAM_ID=own-team\nPCM_HAPI_HEALTH_START_PERIOD=90s\nTEAM_ADMIN_PASSWORD=unchanged\n';
    const initial = planReadinessState(original);
    assert.equal(initial.waitTimeout, 600);
    assert.equal(initial.environment, original.replace('90s', '600s'));
    const explicit = planReadinessState(initial.environment, 900);
    assert.equal(explicit.waitTimeout, 900);
    assert.equal(planReadinessState(explicit.environment).waitTimeout, 900);
    assert.equal(planReadinessState(explicit.environment).environment, explicit.environment);
});

test('older .env files gain one health field and malformed or excessive values fail before writes', () => {
    const original = 'TEAM_ID=own-team\n';
    assert.equal(planReadinessState(original).environment, `${original}PCM_HAPI_HEALTH_START_PERIOD=600s\n`);
    for (const value of ['bad', '0s', '3601s', '"600s"']) {
        assert.throws(() => planReadinessState(`${original}PCM_HAPI_HEALTH_START_PERIOD=${value}\n`), /bounded|wait-timeout/);
    }
    assert.throws(() => planReadinessState(original, 'NaN'), /wait-timeout/);
});

/** Existing short budgets upgrade, while an explicit shorter override remains supported. */
test('default upgrades the former 240-second budget and respects explicit overrides', () => {
    const original = 'TEAM_ID=own-team\nPCM_HAPI_HEALTH_START_PERIOD=240s\n';
    const upgraded = planReadinessState(original);
    assert.equal(upgraded.waitTimeout, 600);
    assert.equal(upgraded.environment, original.replace('240s', '600s'));
    const overridden = planReadinessState(upgraded.environment, 120);
    assert.equal(overridden.waitTimeout, 120);
    assert.equal(overridden.environment, original.replace('240s', '120s'));
});
