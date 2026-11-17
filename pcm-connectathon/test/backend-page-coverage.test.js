'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PRESETS } = require('../../src/shared/conformance-policy');
const { NATIVE_CASES, validateBackendPageQualification } = require('../scripts/backend-page-coverage');
const approvedScope = require('../../config/demo-services.json').clinicalServices.find(item => item.key === 'lab-follow-up').serviceGrant.scope;
const image = `sha256:${'a'.repeat(64)}`, hos = ['ho-a','ho-b','ho-c'];
/** Tiny independent fixture oracle for the closed PAGE acceptance inventory. */
function good() {
    return { scope: 'page-backend-small-fixture', releaseQualification: false,
        native: { status: 'pass', results: hos.map(ho => ({ ho, status: 'pass', cases: NATIVE_CASES.map(name => ({ name })) })) },
        startup: { status: 'pass', results: hos.map(ho => ({ ho, protectedReady: true, transitions: [{ status: 503 }, { status: 403 }] })) },
        small: { status: 'pass', visibility: { fraction: 1/201 }, cleanup: { failures: [] }, otherPatientStatus: 403 },
        presets: PRESETS.map(preset => ({ preset, status: 'pass', images: Object.fromEntries(hos.map(ho => [`${ho}-hapi`, image])),
            scenarios: hos.flatMap(ho => (['enforced']).map(mode => {
                const ids = [1,2].map(n => `observation-${ho}-000${n}`);
                return { id: `gateway-clinical-page-${mode}-${ho}`, executed: true, status: 'pass', ordinaryPcmToken: true, approvedScope,
                    expectedIds: ids, actualIds: ids, distinctApprovedOpaqueTokens: 2, pages: ids.map((id,i) => ({ ids: [id], authorityRevalidated: true, distinctEquivalentToken: i === 1, grantedScope: approvedScope, next: i === ids.length-1 ? null : 'next' })) };
            })) })), cleanup: { status: 'pass' } };
}
test('focused backend PAGE evidence is complete without browser or large-data gates', () => assert.equal(validateBackendPageQualification(good(), image), true));
test('missing variants, image drift and fake ordinary IDs fail', () => {
    for (const change of [r => r.presets.pop(), r => r.native.results[0].cases.pop(),
        r => { r.presets[0].images['ho-b-hapi'] = 'changed'; }, r => r.presets[0].scenarios[0].actualIds.pop()]) {
        const value = good(); change(value); assert.throws(() => validateBackendPageQualification(value, image));
    }
});
test('unprotected startup, non-opaque continuations and failed cleanup cannot pass', () => {
    for (const change of [r => { r.startup.results[0].transitions[0].status = 200; },
        r => { r.presets[0].scenarios[0].pages[1].authorityRevalidated = false; },
        r => { r.cleanup.status = 'fail'; }, r => { r.releaseQualification = true; }]) {
        const value = good(); change(value); assert.throws(() => validateBackendPageQualification(value, image));
    }
});

test('saved scope drift or a missing frozen scope cannot borrow historical result IDs', () => {
    for (const scope of [undefined, approvedScope.replace('laboratoryTests', 'procedures')]) {
        const result = good();
        const scenario = result.presets[0].scenarios.find(item => item.ordinaryPcmToken);
        scenario.approvedScope = scope;
        assert.throws(() => validateBackendPageQualification(result, image));
    }
});
