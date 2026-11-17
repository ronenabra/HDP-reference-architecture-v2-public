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

test('certToX5tS256 decodes PEM supplied as either text or a file buffer', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n';
    const expected = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0';

    assert.equal(certToX5tS256(pem), expected);
    assert.equal(certToX5tS256(Buffer.from(pem)), expected);
});
