'use strict';

/** Saved private policy preview cannot apply to another team or changed config/policy revision. */
const test = require('node:test'), assert = require('node:assert/strict');
const { sourceServerTls } = require('../../src/shared/source-server-trust');
const { certificates } = require('../../test-support/certificates');
const fs = require('node:fs'), path = require('node:path');

test('source trust modes keep server CA/pin separate from workflow client credentials', () => {
    const certsDir = certificates(), cert = fs.readFileSync(path.join(certsDir, 'pcm-core.crt'));
    const pin = require('../../src/shared/assertion-keys').certificateConfirmation(cert)['x5t#S256'];
    const { raw } = new (require('node:crypto').X509Certificate)(cert);
    assert.equal(sourceServerTls({ trust: { mode: 'system-ca' }, certsDir }).ca, undefined);
    assert.equal(sourceServerTls({ trust: { mode: 'insecure-skip-verify' }, certsDir }).rejectUnauthorized, false);
    assert.throws(() => sourceServerTls({ trust: { mode: 'custom-ca' }, certsDir }), /CA is missing/);
    assert.throws(() => sourceServerTls({ trust: { mode: 'unknown' }, certsDir }), /Unsupported/);
    const tls = sourceServerTls({ trust: { mode: 'pinned-thumbprint', certThumbprint: pin }, certsDir });
    const peer = { raw, subject: { CN: 'localhost' }, subjectaltname: 'DNS:localhost' };
    assert.equal(tls.checkServerIdentity('localhost', peer), undefined);
    assert.ok(tls.checkServerIdentity('foreign.example', peer));
    assert.ok(sourceServerTls({ trust: { mode: 'pinned-thumbprint', certThumbprint: 'A'.repeat(43) }, certsDir }).checkServerIdentity('localhost', peer));
    assert.throws(() => sourceServerTls({ trust: { mode: 'pinned-thumbprint' }, certsDir }), /pin is missing/);
});
