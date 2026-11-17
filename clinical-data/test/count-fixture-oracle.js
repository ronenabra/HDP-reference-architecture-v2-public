'use strict';
/** Closed four-record oracle binds actual fixture tags/dates to the exact saved Laboratory decision. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const shared = fs.existsSync(path.resolve(__dirname, '../../src/shared/conformance-policy.js')) ? '../../src/shared/' : '/shared/';
const { NATIVE_FILTER_CONTROLS } = require(`${shared}conformance-policy`);
const { inspectScope } = require(`${shared}service-grant`);
const BUCKET = 'http://fhir.health.gov.il/cs/il-hdp-information-buckets';
const CONFIDENTIALITY = 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality';

/** Assert the closed Laboratory fixture shape, then classify its real tags/dates; this is not an authorization engine. */
function laboratoryFixture(ho, approvedScope) {
    assert.ok(['ho-a', 'ho-b', 'ho-c'].includes(ho));
    const parsed = inspectScope(approvedScope);
    assert.deepEqual(parsed.diagnostics, { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] });
    const alternatives = parsed.clauses.filter(clause => clause.type === 'Observation');
    assert.equal(alternatives.length, 1, 'oracle requires the single frozen Laboratory alternative');
    const clause = alternatives[0];
    assert.equal(clause.context, 'patient'); assert.equal(clause.actions, 'rs');
    assert.ok(clause.filters.includes(`_security=${BUCKET}|laboratoryTests`));
    for (const label of ['R', 'V']) assert.ok(clause.filters.includes(`_security:not=${CONFIDENTIALITY}|${label}`));
    const dates = clause.filters.filter(filter => filter.startsWith('date=ge'));
    assert.equal(dates.length, 1, 'oracle requires one literal saved history cutoff');
    assert.ok(clause.filters.every(filter => filter === `_security=${BUCKET}|laboratoryTests`
        || filter.startsWith('_security:not=') || filter === dates[0]), 'unexpected Laboratory predicate needs its own oracle');
    const cutoff = Date.parse(dates[0].slice('date=ge'.length));
    assert.ok(Number.isFinite(cutoff));
    const bundle = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../ci/${ho}.source.transaction.json`)));
    const records = bundle.entry.map(entry => entry.resource).filter(resource => resource.resourceType === 'Observation');
    assert.equal(records.length, 4, 'the independently known four-record universe changed');
    const excluded = new Set(clause.filters.filter(filter => filter.startsWith('_security:not=')).map(filter => filter.slice('_security:not='.length)));
    for (const record of records) {
        assert.equal(record.subject.reference, `Patient/patient-${ho}-0001`);
        assert.ok(Number.isFinite(Date.parse(record.effectiveDateTime)));
    }
    const allowed = records.filter(record => record.meta.security.some(tag => tag.system === BUCKET && tag.code === 'laboratoryTests')
        && !record.meta.security.some(tag => excluded.has(`${tag.system}|${tag.code}`))
        && Date.parse(record.effectiveDateTime) >= cutoff);
    assert.equal(allowed.length, 2, 'the frozen scope no longer matches this positive two-record fixture');
    return { records, allowed, cutoff: dates[0], approvedScope };
}

/** Derive complete count/page IDs from the frozen scope and real records, never returned counters or preset names. */
function countFixtureCases(ho, controls, approvedScope) {
    assert.ok(['ho-a', 'ho-b', 'ho-c'].includes(ho));
    assert.ok(NATIVE_FILTER_CONTROLS.every(name => typeof controls[name] === 'boolean'), 'complete effective native policy required');
    assert.ok(NATIVE_FILTER_CONTROLS.every(name => controls[name] === true), 'native authorization controls are mandatory in every preset');
    const fixture = laboratoryFixture(ho, approvedScope), ids = values => values.map(record => record.id);
    const known = ids(fixture.allowed);
    return { nativeFiltering: true, mode: 'enforced-native-filtering', known, universe: ids(fixture.records), approvedScope,
        cases: [['', known], ['status=entered-in-error', []], [`_id=${known[0]}`, [known[0]]],
            ['status=preliminary', ids(fixture.allowed.filter(record => record.status === 'preliminary'))],
            ['status=final', ids(fixture.allowed.filter(record => record.status === 'final'))]] };
}
module.exports = { countFixtureCases, laboratoryFixture };
