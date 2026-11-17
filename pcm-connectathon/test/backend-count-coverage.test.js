'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PRESETS } = require('../../src/shared/conformance-policy');
const { requiredCountScenarios, validateBackendCountQualification } = require('../scripts/backend-count-coverage');
const approvedScope = require('../../config/demo-services.json').clinicalServices.find(item => item.key === 'lab-follow-up').serviceGrant.scope;
const image = `sha256:${'a'.repeat(64)}`;
/** Construct independently known small clinical IDs for the declared policy variant. */
function proof(ho) {
    const values = [1, 2];
    return { ordinaryPcmToken: true, nativeFiltering: true, approvedScope, grantedScope: approvedScope, cases: [[], [1], values].map(list => {
        const ids = list.map(n => `observation-${ho}-${String(n).padStart(4, '0')}`);
        return { expectedIds: ids, ordinaryIds: [...ids], aliases: ['_summary=count&_total=accurate', '_count=0']
            .map(controls => ({ controls, status: 200, total: ids.length })) };
    }) };
}
function good() {
    return { scope: 'count-backend-small-fixture', releaseQualification: false, presets: PRESETS.map(preset => ({
        preset, status: 'pass', cleanup: { status: 'pass' }, images: Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].map(ho => [`${ho}-hapi`, { immutable: image }])),
        scenarios: requiredCountScenarios(preset).map(id => ({ id, executed: true, status: 'pass',
            ...(id.includes('positive-') ? proof(id.slice(-4)) : {}) }))
    })) };
}
test('backend acceptance requires the API matrix without imposing UI or workflow browser gates', () => {
    assert.equal(validateBackendCountQualification(good(), image), true);
    assert.ok(PRESETS.every(p => requiredCountScenarios(p).every(id => !id.includes('browser') && !id.includes('workflow'))));
});
test('missing presets, HOs, failed or unexecuted backend cases cannot pass', () => {
    for (const change of [r => r.presets.pop(), r => r.presets[0].scenarios.pop(),
        r => { r.presets[0].scenarios[0].executed = false; }, r => { r.presets[0].scenarios[0].status = 'fail'; }]) {
        const r = good(); change(r); assert.throws(() => validateBackendCountQualification(r, image));
    }
});
test('zero-only or old bypass/V-visible oracle cannot satisfy enforced Easy evidence', () => {
    for (const values of [[[]], [[], [1], [1, 2, 4]], [[], [1], [1, 2, 3, 4]]]) {
        const r = good(), s = r.presets.find(x => x.preset === 'connectathon-easy').scenarios.find(x => x.id.includes('positive'));
        s.cases = values.map(list => ({ expectedIds: list.map(n => `observation-ho-a-${String(n).padStart(4, '0')}`), ordinaryIds: [], aliases: [] }));
        assert.throws(() => validateBackendCountQualification(r, image));
    }
    const r = good(); r.presets[0].scenarios.find(x => x.id.includes('positive')).nativeFiltering = false;
    assert.throws(() => validateBackendCountQualification(r, image));
});
test('opaque-token, independent ordinary IDs and exact two-alias totals are mandatory', () => {
    for (const change of [s => { s.ordinaryPcmToken = false; }, s => { s.cases[1].ordinaryIds = []; },
        s => { s.cases[1].aliases[0].total = 0; }, s => { s.cases[1].aliases.pop(); }]) {
        const r = good(), s = r.presets[0].scenarios.find(x => x.id.includes('positive')); change(s);
        assert.throws(() => validateBackendCountQualification(r, image));
    }
});
test('failed cleanup, changed HAPI images or a fabricated full-release claim are rejected', () => {
    for (const change of [r => { r.presets[0].cleanup.status = 'fail'; }, r => { r.presets[0].images['ho-b-hapi'].immutable = 'changed'; },
        r => { r.releaseQualification = true; }]) { const r = good(); change(r); assert.throws(() => validateBackendCountQualification(r, image)); }
});

test('saved scope drift or a missing frozen scope cannot borrow historical result IDs', () => {
    for (const scope of [undefined, approvedScope.replace('laboratoryTests', 'procedures')]) {
        const result = good();
        const scenario = result.presets[0].scenarios.find(item => item.id.includes('positive'));
        scenario.approvedScope = scope;
        assert.throws(() => validateBackendCountQualification(result, image));
    }
});
