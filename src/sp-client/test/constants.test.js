/**
 * Tests for SP client constants.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXT_PCM_SERVICE } = require('../src/constants');

test('EXT_PCM_SERVICE constant matches PCM extension URL', () => {
    assert.equal(EXT_PCM_SERVICE, 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service');
});
