'use strict';
/** Closed TOTAL backend acceptance inventory; it never claims browser or release qualification. */
const assert = require('node:assert/strict');
const { PRESETS } = require('../../src/shared/conformance-policy');
const HOS = ['ho-a', 'ho-b', 'ho-c'];
const { laboratoryFixture } = require('../../clinical-data/test/count-fixture-oracle');
const NATIVE_CASES = ['size-1','size-2','size-3','size-100','scope-one','scope-zero','client-zero','overlap-union','read-search-separation','include-excluded'];
/** Reject missing source/preset proof, drifting images and totals not supported by independent primary IDs. */
function validateBackendTotalQualification(result, image) {
    assert.equal(result.scope, 'total-backend-small-fixture'); assert.equal(result.releaseQualification, false);
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.native.status, 'pass');
    for (const ho of HOS) {
        const run = result.native.results.find(item => item.ho === ho);
        assert.equal(run?.status, 'pass');
        for (const name of NATIVE_CASES) assert.ok(run.cases.some(item => item.name === name), `${ho}/${name}`);
    }
    assert.equal(result.mutation.status, 'pass'); assert.equal(result.mutation.cases.length, 3);
    assert.ok(result.mutation.cases.every(item => item.continuationStatus === 410));
    assert.deepEqual(result.mutation.cleanup.failures, []);
    assert.equal(result.cache.status, 'pass'); assert.equal(result.cache.oldCursorStatus, 410);
    assert.deepEqual(result.cache.before, ['ds-total-cache-0','ds-total-cache-1']);
    assert.deepEqual(result.cache.after, ['ds-total-cache-0','ds-total-cache-1','ds-total-cache-2']);
    assert.deepEqual(result.cache.cleanup.failures, []);
    for (const preset of PRESETS) {
        const run = result.presets.find(item => item.preset === preset); assert.equal(run?.status, 'pass', preset);
        for (const ho of HOS) {
            assert.equal(run.images[`${ho}-hapi`], image);
            for (const mode of ['enforced']) {
                const scenario = run.scenarios.find(item => item.id === `gateway-clinical-total-${mode}-${ho}`);
                assert.ok(scenario?.executed && scenario.status === 'pass' && scenario.ordinaryPcmToken);
                const ids = laboratoryFixture(ho, scenario.approvedScope).allowed.map(record => record.id);
                assert.deepEqual(scenario.expectedIds, ids); assert.deepEqual(scenario.actualIds, ids);
                assert.deepEqual(scenario.pages.flatMap(page => page.ids), ids);
                assert.ok(scenario.pages.every(page => page.total === ids.length && page.authorityRevalidated && page.ids.length === 1));
                assert.equal(scenario.pages.at(-1).next, null);
                assert.ok(scenario.pages.every(page => page.grantedScope === scenario.approvedScope), 'exact saved/issued scope on every page');
                assert.equal(scenario.distinctApprovedOpaqueTokens, 2);
                assert.equal(scenario.pages[1].distinctEquivalentToken, true);
            }
        }
    }
    assert.equal(result.cleanup.status, 'pass'); return true;
}
module.exports = { NATIVE_CASES, validateBackendTotalQualification };
