'use strict';
/** Public service history is descriptive; actual token restrictions stay literal and separate. */
const test = require('node:test'), assert = require('node:assert/strict');
const { doctorPublicFixture } = require('../../../test-support/doctor-public-fixture');
const { servicePermissions, permissionSummary } = require('../src/permission-plan');
test('public two-year service history never generates a rolling or approval-time cutoff', () => {
    const f = doctorPublicFixture(), service = servicePermissions(f.canonical);
    assert.deepEqual(service.historyInputs, ['laboratoryTests: 2 years', 'medications: 1 years']);
    assert.doesNotMatch(service.scope, /date=|202[0-9]|compiler|pcm-service/);
    const grant = permissionSummary('patient/Observation.s?date=ge2001-03-04&date=lt2005-06-07 patient/Observation.r?date=gt2012-01-02 patient/Observation.s?status=final');
    assert.equal(grant.usable, true);
    assert.deepEqual(grant.clauses.map(value => value.filters), [['date=ge2001-03-04', 'date=lt2005-06-07'], ['date=gt2012-01-02'], ['status=final']]);
    assert.equal(permissionSummary('patient/Observation.r').usable, true);
    assert.equal(permissionSummary('patient/Observation.s?_filter=foo').history.available, false);
});
