'use strict';
/** Fixture expectations refuse retired all-off authority under every preset. */
const test = require('node:test'), assert = require('node:assert/strict');
const { NATIVE_FILTER_CONTROLS } = require('../../src/shared/conformance-policy');
const { countFixtureCases, laboratoryFixture } = require('./count-fixture-oracle');
const scope = require('../../config/demo-services.json').clinicalServices.find(item => item.key === 'lab-follow-up').serviceGrant.scope;
const controls = enabled => Object.fromEntries(NATIVE_FILTER_CONTROLS.map(name => [name, enabled]));
test('ordinary Consent fixture always excludes procedures and V confidentiality, including Easy', () => {
    const enforced = countFixtureCases('ho-a', controls(true), scope);
    assert.equal(enforced.mode, 'enforced-native-filtering');
    assert.ok(!enforced.known.includes('observation-ho-a-0003'));
    assert.ok(!enforced.known.includes('observation-ho-a-0004'));
    assert.equal(enforced.cases.find(([query]) => query === 'status=final')[1].length, 1);
    assert.deepEqual(enforced.cases.find(([query]) => query === 'status=entered-in-error')[1], []);
});
test('incomplete, mixed or all-off policy cannot select a false exact oracle', () => {
    assert.throws(() => countFixtureCases('ho-a', {}), /complete effective/);
    const mixed = controls(true); mixed.resultFiltering = false;
    assert.throws(() => countFixtureCases('ho-a', mixed), /mandatory/);
    assert.throws(() => countFixtureCases('ho-a', controls(false)), /mandatory/);
    assert.throws(() => countFixtureCases('unowned', controls(true)));
});

// Independent fixture classification and actual issuance bind this oracle to current approved semantics.
test('the labelled V fixture is excluded by real lifecycle Laboratory follow-up authority', () => {
    const fixture = require('../../test-support/clinical-token-fixture').clinicalTokenFixture({ scope });
    const issued = require('../../src/pcm-core/src/data-grant').resolveGrant(fixture.request);
    assert.equal(issued.scope, scope);
    assert.ok(issued.scope.includes('_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V'));
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        const bundle = require(`../ci/${ho}.source.transaction.json`);
        const labelled = bundle.entry.find(entry => entry.resource.id === `observation-${ho}-0004`).resource;
        assert.ok(labelled.meta.security.some(value => value.system === 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality' && value.code === 'V'));
        assert.deepEqual(countFixtureCases(ho, controls(true), scope).known, [1, 2].map(n => `observation-${ho}-000${n}`));
    }

});

test('changed saved predicates/history cannot borrow the old two-record result oracle', () => {
    assert.throws(() => laboratoryFixture('ho-a', scope.replace('laboratoryTests', 'procedures')));
    assert.throws(() => laboratoryFixture('ho-a', scope.replace(/date=ge[^& ]+/, 'date=ge2035-01-01')));
    assert.throws(() => laboratoryFixture('ho-a', scope.replace(/&_security:not=[^& ]+[|]R/g, '')));
});
