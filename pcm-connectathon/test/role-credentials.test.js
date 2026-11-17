'use strict';
/** Validate cryptographic roles and rollback without touching retained deployments. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { validatePair, generateLeaf, publishFiles, provisionLeaf } = require('../../src/shared/role-credentials');
const { certificates } = require('../../test-support/certificates');
const { prepareSourceCredentials } = require('../../src/pcm-core/src/source-credentials');
const { buildTeamConfig } = require('../../test-support/team-config');
const read = name => fs.readFileSync(path.join(certificates(), name));
const root = () => ({ ca: read('rootCA.crt'), caKey: read('rootCA.key') });

test('P-256/shared and P-384/separate assertions validate while TLS-only RSA remains allowed', () => {
    for (const algorithm of ['ES256', 'ES384']) {
        const pair = generateLeaf({ ...root(), commonName: 'owned-source', algorithm, assertion: true });
        const checked = validatePair({ ...pair, ca: root().ca, algorithm, assertion: true });
        assert.equal(checked.thumbprint, pair.thumbprint);
        assert.equal(new crypto.X509Certificate(pair.cert).checkPrivateKey(crypto.createPrivateKey(pair.key)), true);
    }
    assert.doesNotThrow(() => validatePair({ cert: read('hospital-b-sp.crt'), key: read('hospital-b-sp.key'), ca: root().ca }));
    assert.throws(() => validatePair({ cert: read('hospital-b-sp.crt'), key: read('hospital-b-sp.key'), ca: root().ca, assertion: true }), /Assertion/);
    assert.doesNotThrow(() => validatePair({ cert: read('hospital-b-sp.crt'), key: read('hospital-b-sp.key'), ca: root().ca, assertion: true, algorithm: 'RS256', legacyRs256: true }));
});
test('wrong curve, key, issuer, malformed material and wrong CA key fail before publication', () => {
    const pair = generateLeaf({ ...root(), commonName: 'source', algorithm: 'ES384', assertion: true });
    assert.throws(() => validatePair({ ...pair, ca: root().ca, algorithm: 'ES256', assertion: true }), /algorithm/);
    assert.throws(() => validatePair({ ...pair, key: read('sp-client-assertion.key'), ca: root().ca }), /do not match/);
    assert.throws(() => validatePair({ ...pair, ca: read('untrustedCA.crt') }), /chain/);
    assert.throws(() => validatePair({ cert: 'invalid', key: pair.key, ca: root().ca }), /PEM/);
    assert.throws(() => generateLeaf({ ...root(), caKey: read('untrustedCA.key'), commonName: 'source' }), /CA/);
    assert.throws(() => generateLeaf({ ...root(), commonName: 'source', algorithm: 'ES512' }), /Unsupported/);
});
test('ordinary provisioning preserves existing bytes and rejected publication restores only selected files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-role-provision-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'rootCA.crt'), root().ca); fs.writeFileSync(path.join(directory, 'rootCA.key'), root().caKey);
    const options = { directory, certName: 'source.crt', keyName: 'source.key', commonName: 'source', algorithm: 'ES256', assertion: true };
    const first = provisionLeaf(options), second = provisionLeaf(options);
    assert.deepEqual(first.cert, second.cert); assert.deepEqual(first.key, second.key);
    assert.throws(() => publishFiles(directory, { 'source.crt': 'bad', 'unused.key': 'temporary' }, () => { throw Error('config publication failed'); }), /config publication/);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'source.crt')), first.cert);
    assert.equal(fs.existsSync(path.join(directory, 'unused.key')), false);
    assert.throws(() => publishFiles(directory, { '../outside.key': 'bad' }), /directory/);
    fs.writeFileSync(path.join(directory,'owned-marker'),'original-marker');fs.linkSync(path.join(directory,'owned-marker'),path.join(directory,'hardlink.crt'));
    assert.throws(()=>publishFiles(directory,{'hardlink.crt':'replacement'}),/regular file/);assert.equal(fs.readFileSync(path.join(directory,'owned-marker'),'utf8'),'original-marker');
    fs.rmSync(path.join(directory, 'source.key'));
    assert.throws(() => provisionLeaf(options), /private key/);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'source.crt')), first.cert);
});
test('custom separate P-384 assertion and RSA transport survive preparation with distinct server trust', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-source-roles-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'rootCA.crt'), root().ca); fs.writeFileSync(path.join(directory, 'rootCA.key'), root().caKey);
    const source = { id: 'custom-source', pcmClientAuth: { cert: 'assertion.crt', key: 'assertion.key', mtlsCert: 'transport.crt', mtlsKey: 'transport.key', assertionCertificates: { ES384: 'assertion.crt' } }, serverTrust: { mode: 'custom-ca', caCert: 'external-ca.crt' } };
    const config = buildTeamConfig(); const before = structuredClone(source.serverTrust);
    const prepared = prepareSourceCredentials({ directory, source, config, generate: true });
    assert.notEqual(prepared.thumbprint, prepared.assertionThumbprint);
    assert.equal(new crypto.X509Certificate(prepared.material['assertion.crt']).publicKey.asymmetricKeyDetails.namedCurve, 'secp384r1');
    assert.equal(new crypto.X509Certificate(prepared.material['transport.crt']).publicKey.asymmetricKeyType, 'rsa');
    assert.deepEqual(source.serverTrust, before);
    assert.equal(fs.existsSync(path.join(directory, 'assertion.crt')), false);
    const upload = { directory, source: structuredClone(source), config, certContent: prepared.material['assertion.crt'], keyContent: prepared.material['assertion.key'],
        transportCertContent: prepared.material['transport.crt'], transportKeyContent: prepared.material['transport.key'] };
    const uploaded = prepareSourceCredentials(upload); assert.deepEqual(uploaded.material, prepared.material);
    assert.throws(() => prepareSourceCredentials({ ...upload, transportKeyContent: null }), /together/);
    assert.throws(() => prepareSourceCredentials({ ...upload, transportCertContent: null, transportKeyContent: null }), /Separate transport/);
    assert.throws(() => prepareSourceCredentials({ ...upload, transportKeyContent: prepared.material['assertion.key'] }), /do not match/);
    assert.throws(() => prepareSourceCredentials({ ...upload, certContent: prepared.material['transport.crt'], keyContent: prepared.material['transport.key'] }), /Assertion/);
    assert.throws(() => prepareSourceCredentials({ ...upload, transportCertContent: prepared.material['assertion.crt'], transportKeyContent: prepared.material['assertion.key'] }), /different transport and assertion/);
    const shared = structuredClone(source); shared.pcmClientAuth.mtlsCert = null; shared.pcmClientAuth.mtlsKey = null;
    assert.throws(() => prepareSourceCredentials({ ...upload, source: shared }), /Shared credentials/);
});
