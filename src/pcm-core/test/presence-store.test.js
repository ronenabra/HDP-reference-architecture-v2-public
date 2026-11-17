'use strict';

/** Persisted source knowledge survives restart and rejects fabricated absence on storage errors. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PresenceStore } = require('../src/presence-store');
const patient = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };

test('independent successful observations survive restart and unknown cannot erase them', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-presence-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new PresenceStore(directory);
    assert.equal(store.get(patient, 'ho-a'), null);
    store.record(patient, 'ho-a', 'present', 10);
    store.record(patient, 'ho-b', 'absent', 11);
    assert.throws(() => store.record(patient, 'ho-a', 'unknown', 12));
    const reopened = new PresenceStore(directory);
    assert.deepEqual(reopened.get(patient, 'ho-a'), { state: 'present', checkedAt: 10 });
    assert.deepEqual(reopened.get(patient, 'ho-b'), { state: 'absent', checkedAt: 11 });
    assert.equal(reopened.get({ ...patient, value: '000000026' }, 'ho-a'), null);
    fs.writeFileSync(store.file(patient), '{');
    assert.throws(() => reopened.get(patient, 'ho-a'), /unavailable/);
    assert.throws(() => reopened.record(patient, 'ho-a', 'absent', 12), /unavailable/);
});
