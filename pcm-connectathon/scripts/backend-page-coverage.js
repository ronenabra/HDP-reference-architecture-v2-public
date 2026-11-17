'use strict';
/** PAGE backend acceptance inventory; ordinary API evidence never implies full UI/release qualification. */
const assert = require('node:assert/strict');
const { PRESETS } = require('../../src/shared/conformance-policy');
const HOS = ['ho-a', 'ho-b', 'ho-c'];
const { laboratoryFixture } = require('../../clinical-data/test/count-fixture-oracle');
/** Required native traversal variants on independently known tiny fixture IDs. */
const NATIVE_CASES = ['count-1','count-2','count-3','count-999999999','default','sort-desc','filtered','all-denied','true-empty','duplicate-union','included-supporting-read'];

/** Reject missing presets, source/image drift, empty nonterminal pages and false broad-release claims. */
function validateBackendPageQualification(result, image) {
    assert.equal(result.scope, 'page-backend-small-fixture'); assert.equal(result.releaseQualification, false);
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.native.status, 'pass');
    for (const ho of HOS) {
        const native = result.native.results.find(item => item.ho === ho);
        assert.equal(native?.status, 'pass');
        for (const name of NATIVE_CASES) assert.ok(native.cases.some(item => item.name === name), `${ho}/${name}`);
    }
    assert.equal(result.startup.status, 'pass');
    for (const ho of HOS) {
        const observed = result.startup.results.find(item => item.ho === ho);
        assert.equal(observed?.protectedReady, true);
        assert.ok(observed.transitions.every(item => ['unreachable',403,503].includes(item.status)));
    }
    assert.ok(result.startup.results.some(item => item.transitions.some(t => t.status === 503)), 'actual startup503 proof');
    assert.equal(result.small.status, 'pass'); assert.ok(result.small.visibility.fraction < 0.01);
    assert.equal(result.small.cleanup.failures.length, 0); assert.equal(result.small.otherPatientStatus, 403);
    for (const preset of PRESETS) {
        const run = result.presets.find(item => item.preset === preset);
        assert.equal(run?.status, 'pass', preset);
        for (const ho of HOS) {
            assert.equal(run.images[`${ho}-hapi`], image);
            for (const mode of ['enforced']) {
                const scenario = run.scenarios.find(item => item.id === `gateway-clinical-page-${mode}-${ho}`);
                assert.ok(scenario?.executed && scenario.status === 'pass' && scenario.ordinaryPcmToken);
                const expected = laboratoryFixture(ho, scenario.approvedScope).allowed.map(record => record.id);
                assert.deepEqual(scenario.expectedIds, expected); assert.deepEqual(scenario.actualIds, expected);
                assert.deepEqual(scenario.pages.flatMap(page => page.ids), expected);
                assert.ok(scenario.pages.every(page => (page.authorityRevalidated || page.freshOpaqueToken) && page.ids.length === 1));
                assert.equal(scenario.pages.at(-1).next, null);
                assert.ok(scenario.pages.every(page => page.grantedScope === scenario.approvedScope), 'exact saved/issued scope on every page');
                if (mode === 'enforced') {
                    assert.equal(scenario.distinctApprovedOpaqueTokens, 2);
                    assert.equal(scenario.pages[1].distinctEquivalentToken, true);
                    assert.ok(scenario.pages.every(page => page.grantedScope === scenario.pages[0].grantedScope));
                }
            }
        }
    }
    assert.equal(result.cleanup.status, 'pass');
    return true;
}
module.exports = { NATIVE_CASES, validateBackendPageQualification };
