'use strict';
/** Required deterministic populations are explicit qualification artifacts, never bootstrap seeds. */
const test = require('node:test'), assert = require('node:assert/strict');
const { patientFixture } = require('./demo-patient-fixtures');
const { inspectTransactionBundle } = require('../transaction-bundle');
test('100/10000 GUID populations have stable hashes, HTEST and resolved positive clinical references', () => {
    for (const count of [100,10000]) {
        const fixture = patientFixture(count), checked = inspectTransactionBundle(fixture.bytes);
        assert.equal(checked.counts.Patient, count + 3); assert.equal(checked.counts.Observation, 5);
        assert.equal(fixture.sha256, patientFixture(count).sha256);
        const patients = fixture.bundle.entry.filter(entry => entry.resource.id.startsWith('sample-') && entry.resource.resourceType === 'Patient');
        assert.equal(patients.length, count); assert.ok(patients.every(entry => entry.resource.meta.security[0].code === 'HTEST'));
        assert.equal(patients[0].resource.identifier[0].value, fixture.firstIdentifier.value);
    }
    assert.throws(() => patientFixture(101));
});
