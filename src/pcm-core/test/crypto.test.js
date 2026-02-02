/**
 * Tests for PCM crypto helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { certToX5tS256 } = require('../src/crypto');

test('certToX5tS256 computes base64url SHA-256', () => {
    const result = certToX5tS256(Buffer.from('abc'));
    assert.equal(result, 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});
