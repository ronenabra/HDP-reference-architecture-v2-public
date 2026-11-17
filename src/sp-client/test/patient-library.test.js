'use strict';
/** Offline standard choices and bounded replacement/generation behavior. */
const test = require('node:test'), assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { PatientLibrary } = require('../src/patient-library');
const { SYSTEM } = require('../../shared/sandbox-patients');
const config = () => buildTeamConfig({ sandboxSampling: { sourceIds: ['ho-a', 'ho-b'] } });
const result = sourceId => ({ sourceId, state: 'loaded', refreshedAt: '2026-10-06T10:00:00Z', patients: Array.from({ length: 11 }, (_, i) => ({ idSystem: SYSTEM, idValue: String(i) })) });
test('offline fixed choices, ten replacement candidates, and late source/team/environment responses', () => {
    const library = new PatientLibrary(), c = config(); assert.equal(library.choices('a', c).length, 3);
    const first = library.begin('a', c, 'ho-a'); library.complete('a', c, first, result('ho-a')); assert.equal(library.choices('a', c).length, 13);
    const next = library.begin('a', c, 'ho-b'); assert.equal(library.choices('a', c).length, 3); assert.throws(() => library.complete('a', c, first, result('ho-a')), /superseded/);
    library.invalidate('a', c, 'ho-a'); assert.throws(() => library.complete('a', c, next, result('ho-b')), /superseded/);
    const third = library.begin('a', c, 'ho-a'); c.contract.environment = 'production'; assert.throws(() => library.complete('a', c, third, result('ho-a')), /superseded/);
    const fourth = library.begin('a', c, 'ho-a'); c.teamId = 'another-team'; assert.throws(() => library.complete('a', c, fourth, result('ho-a')), /superseded/);
    const endpointChange = library.begin('a', c, 'ho-a'); c.healthOrganizations[0].endpoint = 'https://changed-source.example/fhir'; assert.throws(() => library.complete('a', c, endpointChange, result('ho-a')), /superseded/);
    c.conformance.mode = 'strict'; assert.throws(() => library.begin('a', c, 'ho-a'), /Unsupported/);
});


test('offline membership and exact-pair deduplication survive cached rendering without application leakage', () => {
    const library = new PatientLibrary(), c = config();
    const patients = [{ idSystem: SYSTEM, idValue: 'same', display: '<script>untrusted</script>' },
        { idSystem: SYSTEM, idValue: 'same' }, { idSystem: 'urn:other', idValue: 'same' },
        ...library.offline(), ...result('ho-a').patients];
    const pending = library.begin('a', c, 'ho-a');
    library.complete('a', c, pending, { ...result('ho-a'), patients });
    const current = library.get('a', c);
    assert.deepEqual(current.candidates.slice(0, 2).map(row => [row.idSystem, row.idValue]), [[SYSTEM, 'same'], ['urn:other', 'same']]);
    assert.equal(current.candidates[1].display, 'Name unknown');
    assert.ok(current.candidates.every(row => row.review === 'Consent review required'));
    assert.equal(library.offline().length, 3);
    assert.equal(library.get('b', c).candidates.length, 0);
    assert.equal(library.get('a', c), current);
    c.organizations.serviceProvider.clientId = 'replacement-application';
    assert.equal(library.get('a', c).candidates.length, 0);
    assert.throws(() => library.complete('a', c, pending, result('ho-a')), /superseded/);
});

test('failure and cancellation clear old candidates and cannot overwrite a newer generation', () => {
    const library = new PatientLibrary(), c = config(), pending = library.begin('a', c, 'ho-a');
    library.fail('a', c, pending, new Error('Source refused'));
    assert.equal(library.get('a', c).state, 'failed');
    assert.equal(library.get('a', c).error, 'Source refused');
    const next = library.begin('a', c, 'ho-b');
    library.fail('a', c, pending, new Error('Late failure'));
    assert.equal(library.get('a', c).state, 'loading');
    library.invalidate('a', c, 'ho-b', true);
    library.fail('a', c, next, new Error('Late failure'));
    assert.equal(library.get('a', c).state, 'cancelled');
    assert.equal(library.get('a', c).refreshedAt, null);
    assert.equal(library.get('a', c).error, '');
});
