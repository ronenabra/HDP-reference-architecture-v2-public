'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PRESETS } = require('../../src/shared/conformance-policy');
const { NATIVE_CASES, validateBackendTotalQualification } = require('../scripts/backend-total-coverage');
const approvedScope = require('../../config/demo-services.json').clinicalServices.find(item => item.key === 'lab-follow-up').serviceGrant.scope;
const image = `sha256:${'a'.repeat(64)}`, hos = ['ho-a','ho-b','ho-c'];
/** Tiny independent fixture oracle for the closed TOTAL acceptance inventory. */
function good() {
    return { scope: 'total-backend-small-fixture', releaseQualification: false,
        native: { status: 'pass', results: hos.map(ho => ({ ho, status: 'pass', cases: NATIVE_CASES.map(name => ({ name })) })) },
        mutation: { status: 'pass', cases: [1,2,3].map(() => ({ continuationStatus: 410 })), cleanup: { failures: [] } },
        cache: { status: 'pass', oldCursorStatus: 410, before: ['ds-total-cache-0','ds-total-cache-1'], after: ['ds-total-cache-0','ds-total-cache-1','ds-total-cache-2'], cleanup: { failures: [] } },
        presets: PRESETS.map(preset => ({ preset, status: 'pass', images: Object.fromEntries(hos.map(ho => [`${ho}-hapi`, image])),
            scenarios: hos.flatMap(ho => (['enforced']).map(mode => {
                const ids = [1,2].map(n => `observation-${ho}-000${n}`);
                return { id: `gateway-clinical-total-${mode}-${ho}`, executed: true, status: 'pass', ordinaryPcmToken: true, approvedScope,
                    expectedIds: ids, actualIds: ids, distinctApprovedOpaqueTokens: 2, pages: ids.map((id,i) => ({ ids: [id], total: ids.length, authorityRevalidated: true, grantedScope: approvedScope, distinctEquivalentToken: i === 1, grantedScope: approvedScope, next: i === ids.length-1 ? null : 'next' })) };
            })) })), cleanup: { status: 'pass' } };
}
test('focused backend TOTAL evidence is complete without browser or large-data gates', () => assert.equal(validateBackendTotalQualification(good(), image), true));
test('missing variants, image drift and fake ordinary IDs fail', () => {
    for (const change of [r => r.presets.pop(), r => r.native.results[0].cases.pop(),
        r => { r.presets[0].images['ho-b-hapi'] = 'changed'; }, r => r.presets[0].scenarios[0].actualIds.pop()]) {
        const value = good(); change(value); assert.throws(() => validateBackendTotalQualification(value, image));
    }
});
test('unproven mutation, non-opaque continuations and failed cleanup cannot pass', () => {
    for (const change of [r => { r.mutation.cases[0].continuationStatus = 200; }, r => r.cache.after.pop(),
        r => { r.presets[0].scenarios[0].pages[1].authorityRevalidated = false; },
        r => { r.cleanup.status = 'fail'; }, r => { r.releaseQualification = true; }]) {
        const value = good(); change(value); assert.throws(() => validateBackendTotalQualification(value, image));
    }
});

test('saved scope drift or a missing frozen scope cannot borrow historical result IDs', () => {
    for (const scope of [undefined, approvedScope.replace('laboratoryTests', 'procedures')]) {
        const result = good();
        const scenario = result.presets[0].scenarios.find(item => item.ordinaryPcmToken);
        scenario.approvedScope = scope;
        assert.throws(() => validateBackendTotalQualification(result, image));
    }
});
