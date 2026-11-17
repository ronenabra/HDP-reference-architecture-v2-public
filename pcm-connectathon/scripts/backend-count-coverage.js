'use strict';
/** Owner-scoped COUNT backend acceptance; full UI qualification remains a separate release gate. */
const assert = require('node:assert/strict');
const { PRESETS } = require('../../src/shared/conformance-policy');
const HOS = ['ho-a', 'ho-b', 'ho-c'];
const { laboratoryFixture } = require('../../clinical-data/test/count-fixture-oracle');

/** Required native/gateway API outcomes for one preset, with mandatory authorization in Easy as well. */
function requiredCountScenarios(preset) {
    assert.ok(PRESETS.includes(preset));
    return ['hapi-authorized-counts', ...HOS.flatMap(ho => [`gateway-${ho}`, `gateway-clinical-count-${ho}`,
        `gateway-clinical-count-positive-${ho}`]),
    ...(preset === 'connectathon-easy' ? [] : ['hapi-authorized-results', 'token-assertion-boundary'])];
}

/** Validate known fixture IDs and ordinary opaque-token zero/one/many oracles, not just success labels. */
function validatePositiveCases(scenario, ho) {
    assert.ok(scenario?.ordinaryPcmToken, `${ho} ordinary PCM opaque-token proof required`);
    assert.equal(scenario.nativeFiltering, true, 'mandatory native filtering');
    assert.equal(scenario.grantedScope, scenario.approvedScope, 'exact saved/issued scope');
    const known = laboratoryFixture(ho, scenario.approvedScope).allowed.map(record => record.id);
    for (const size of [0, 1, known.length]) assert.ok(scenario.cases.some(item => item.expectedIds.length === size), `${ho} missing zero/one/many`);
    for (const item of scenario.cases) {
        assert.ok(item.expectedIds.every(id => known.includes(id)));
        assert.deepEqual([...item.ordinaryIds].sort(), [...item.expectedIds].sort());
        assert.deepEqual(item.aliases.map(alias => alias.controls).sort(), ['_count=0', '_summary=count&_total=accurate']);
        assert.ok(item.aliases.every(alias => alias.status === 200 && alias.total === item.expectedIds.length));
    }
}

/** Accept only all-four-preset API evidence with actual cleanup and the expected immutable HAPI image. */
function validateBackendCountQualification(result, expectedHapiImage) {
    assert.equal(result.scope, 'count-backend-small-fixture');
    assert.equal(result.releaseQualification, false);
    assert.match(expectedHapiImage, /^sha256:[a-f0-9]{64}$/);
    for (const preset of PRESETS) {
        const run = result.presets.find(item => item.preset === preset);
        assert.equal(run?.status, 'pass', `${preset} backend API pass required`);
        assert.equal(run.cleanup?.status, 'pass', `${preset} cleanup required`);
        for (const ho of HOS) assert.equal(run.images[`${ho}-hapi`]?.immutable, expectedHapiImage, `${preset}/${ho} immutable image`);
        for (const id of requiredCountScenarios(preset)) {
            const scenario = run.scenarios.find(item => item.id === id);
            assert.ok(scenario?.executed && scenario.status === 'pass', `${preset}/${id} required backend scenario`);
        }
        for (const ho of HOS) {
            validatePositiveCases(run.scenarios.find(item => item.id === `gateway-clinical-count-positive-${ho}`), ho);
        }
    }
    return true;
}
module.exports = { requiredCountScenarios, validatePositiveCases, validateBackendCountQualification };
