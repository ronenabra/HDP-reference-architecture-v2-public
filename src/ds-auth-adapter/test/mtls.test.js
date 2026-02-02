/**
 * Tests for mTLS thumbprint helpers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { certToX5tS256, thumbprintFromEscapedPem } = require('../src/mtls');

test('thumbprintFromEscapedPem matches certToX5tS256 for PEM', () => {
    const der = Buffer.from('abc');
    const base64 = der.toString('base64');
    const pem = `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
    const escaped = encodeURIComponent(pem);

    const expected = certToX5tS256(der);
    const actual = thumbprintFromEscapedPem(escaped);

    assert.equal(actual, expected);
});
