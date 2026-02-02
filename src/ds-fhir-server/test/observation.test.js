/**
 * Tests for DS observation bundle generation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildObservationBundle } = require('../src/observation');

test('buildObservationBundle uses patient reference', () => {
    const bundle = buildObservationBundle('Patient/abc');
    assert.equal(bundle.entry[0].resource.subject.reference, 'Patient/abc');
});
