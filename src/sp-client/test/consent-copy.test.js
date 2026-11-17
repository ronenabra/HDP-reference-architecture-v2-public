'use strict';
/** Exact clipboard payloads and honest HTTP/permission fallback, without requests or form submission. */
const test = require('node:test'), assert = require('node:assert/strict');
const { copyConsentId } = require('../../shared/ui/doctor-cards');
test('copy preserves UUID and maximum-length case/dot/hyphen logical IDs exactly', async () => {
    for (const value of ['123e4567-e89b-42d3-a456-426614174000', 'aB.cD-' + 'Z'.repeat(58)]) {
        let copied;
        assert.equal(await copyConsentId(value, { writeText: async text => { copied = text; } }), 'Consent ID copied.');
        assert.equal(copied, value);
        assert.match(await copyConsentId(value, null), /Clipboard unavailable.*manually/);
        assert.match(await copyConsentId(value, { writeText: async () => { throw Error('denied'); } }), /Clipboard denied.*manually/);
    }
});
