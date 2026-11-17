'use strict';
/** Passive public card attribution and expiry; no network client is imported. */
const test = require('node:test'), assert = require('node:assert/strict');
const { doctorPublicFixture } = require('../../../test-support/doctor-public-fixture');
const { approvalPresentation } = require('../src/approval-presentation');
test('standard Consent with no private metadata renders intent and honest no-token states', () => {
    const f = doctorPublicFixture(), value = approvalPresentation(f.consent, { definition: f.canonical });
    assert.equal(value.available, true); assert.equal(value.usable, true);
    assert.match(value.message, /Intended retrieval selection/); assert.match(value.message, /Granted permissions not yet obtained/);
    assert.equal(value.tokenStatus.message, 'Token status not checked'); assert.equal(value.accessMode, 'continuous');
    assert.equal(value.snapshot, undefined);
});
test('cached original receipt and expiry survive passive projection; expired grant cannot appear current', () => {
    const f = doctorPublicFixture(), grant = { scope: f.scope, acquiredAt: 1000, expiresAt: 31000 };
    const record = { tokenGrant: grant, tokenStatus: { state: 'refused', message: 'Not independently checked' } };
    const first = approvalPresentation(f.consent, {}, record, 2000), second = approvalPresentation(f.consent, {}, record, 3000);
    assert.equal(first.grant.acquiredAt, second.grant.acquiredAt); assert.equal(second.grant.expiresAt, 31000);
    assert.match(first.message, /token-response grant/); assert.equal(first.tokenStatus.state, 'refused');
    assert.equal(approvalPresentation(f.consent, {}, record, 31000).grant, null);
    assert.equal(approvalPresentation(f.consent, {}, { authorityBlocked: true }).usable, false);
});
