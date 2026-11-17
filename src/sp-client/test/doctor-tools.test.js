'use strict';
/** Confirmed reset discards this Doctor mount's drafts without crossing mounts. */
const test = require('node:test'), assert = require('node:assert/strict');
const { clearDoctorDrafts } = require('../../shared/ui/doctor-tools');
test('reset clears every application draft on the exact Doctor mount only', () => {
    const storage = { 'pcm-doctor-draft:/team/doctor:hospital-a': 'first', 'pcm-doctor-draft:/team/doctor:hospital-b': 'second',
        'pcm-doctor-draft:/other/doctor:hospital-a': 'other', 'pcm-doctor-draft:/team/doctor-extra:hospital-a': 'other mount',
        'pcm-explain': 'on', removeItem(key) { delete this[key]; } };
    clearDoctorDrafts(storage, '/team/doctor');
    assert.equal(storage['pcm-doctor-draft:/team/doctor:hospital-a'], undefined);
    assert.equal(storage['pcm-doctor-draft:/team/doctor:hospital-b'], undefined);
    assert.equal(storage['pcm-doctor-draft:/other/doctor:hospital-a'], 'other');
    assert.equal(storage['pcm-doctor-draft:/team/doctor-extra:hospital-a'], 'other mount');
    assert.equal(storage['pcm-explain'], 'on');
});
test('unprefixed Doctor drafts clear without matching another application mount', () => {
    const storage = { 'pcm-doctor-draft::hospital-a': 'first', 'pcm-doctor-draft:/doctor:hospital-a': 'other', removeItem(key) { delete this[key]; } };
    clearDoctorDrafts(storage, ''); clearDoctorDrafts(storage, '');
    assert.equal(storage['pcm-doctor-draft::hospital-a'], undefined);
    assert.equal(storage['pcm-doctor-draft:/doctor:hospital-a'], 'other');
});
