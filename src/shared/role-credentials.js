'use strict';

/** Small role-aware certificate provisioning helpers shared by CLI and Admin. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { signingAlgorithm } = require('./assertion-keys');

/** Parse and validate a pair for its actual role and configured issuer, without publishing it. */
function validatePair({ cert, key, ca, assertion = false, algorithm, legacyRs256 = false, clientAuth = false }) {
    let certificate, privateKey;
    try { certificate = new crypto.X509Certificate(cert); privateKey = crypto.createPrivateKey(key); }
    catch (_) { throw new Error('Credential certificate and private key must be valid PEM material'); }
    if (!certificate.checkPrivateKey(privateKey)) throw new Error('Credential certificate and private key do not match');
    if (certificate.ca) throw new Error('A CA certificate cannot serve as a client/server leaf credential');
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Credential certificate is not currently valid');
    if (clientAuth && certificate.keyUsage?.length && !certificate.keyUsage.includes('1.3.6.1.5.5.7.3.2')) throw new Error('Transport certificate must permit TLS client authentication');
    if (assertion) {
        let actual;
        try { actual = signingAlgorithm(certificate.publicKey); }
        catch (_) { if (legacyRs256 && certificate.publicKey.asymmetricKeyType === 'rsa') actual = 'RS256'; else throw new Error('Assertion credentials require P-256/ES256 or P-384/ES384; registered RS256 requires its non-strict adapter'); }
        if (algorithm && actual !== algorithm) throw new Error(`Assertion credential does not match requested ${algorithm} algorithm`);
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-credential-check-'));
    try {
        fs.writeFileSync(path.join(temporary, 'leaf.crt'), cert, { mode: 0o600 });
        fs.writeFileSync(path.join(temporary, 'ca.crt'), ca, { mode: 0o600 });
        const checked = spawnSync('openssl', ['verify', '-CAfile', 'ca.crt', '-untrusted', 'leaf.crt', 'leaf.crt'], { cwd: temporary, encoding: 'utf8' });
        if (checked.error || checked.status !== 0) throw new Error('Credential certificate does not chain to the configured PCM CA');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    return { cert: Buffer.from(cert), key: Buffer.from(key), thumbprint: crypto.createHash('sha256').update(certificate.raw).digest('base64url') };
}

/** Generate a validated leaf in private staging, optionally retaining an existing private key. */
function generateLeaf({ ca, caKey, commonName, sans = [], algorithm = 'ES256', assertion = false, legacyRs256 = false, clientAuth = false, key }) {
    if (![commonName, ...sans].every(name => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name))) throw new Error('Credential names must be DNS-safe');
    let issuer;
    try { issuer = new crypto.X509Certificate(ca); if (!issuer.ca || !issuer.checkPrivateKey(crypto.createPrivateKey(caKey))) throw new Error(); }
    catch (_) { throw new Error('Configured signing CA certificate/key is invalid or mismatched'); }
    if (!['ES256', 'ES384', 'RSA', 'RS256'].includes(algorithm)) throw new Error('Unsupported credential algorithm');
    if (!key) key = crypto.generateKeyPairSync(algorithm.startsWith('ES') ? 'ec' : 'rsa', algorithm.startsWith('ES')
        ? { namedCurve: algorithm === 'ES384' ? 'secp384r1' : 'prime256v1' } : { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-credential-stage-'));
    const run = args => { const result = spawnSync('openssl', args, { cwd: temporary, encoding: 'utf8' }); if (result.error || result.status !== 0) throw new Error('Credential generation failed before publication'); };
    try {
        fs.writeFileSync(path.join(temporary, 'leaf.key'), key, { mode: 0o600 });
        fs.writeFileSync(path.join(temporary, 'issuer.crt'), ca, { mode: 0o600 });
        fs.writeFileSync(path.join(temporary, 'issuer.key'), caKey, { mode: 0o600 });
        fs.writeFileSync(path.join(temporary, 'leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=${[...new Set([commonName, 'localhost', ...sans])].map(name => `${require('node:net').isIP(name) ? 'IP' : 'DNS'}:${name}`).join(',')},IP:127.0.0.1\n`);
        run(['req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', `/C=IL/O=HDP-PCM-Connectathon/CN=${commonName}`]);
        run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'issuer.crt', '-CAkey', 'issuer.key', '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`, '-out', 'leaf.crt', '-days', '500', '-sha256', '-extfile', 'leaf.ext']);
        return validatePair({ cert: fs.readFileSync(path.join(temporary, 'leaf.crt')), key, ca, assertion, algorithm, legacyRs256, clientAuth });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Publish only selected credential files, restoring their previous bytes if saving config fails. */
function publishFiles(directory, material, commit = () => {}) {
    const previous = new Map();
    try {
        for (const [name, bytes] of Object.entries(material)) {
            const target = path.resolve(directory, name);
            if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('Credential file path must remain in its certificate directory');
            if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).nlink !== 1)) throw new Error('Credential target must be a regular file');
            previous.set(target, fs.existsSync(target) ? { bytes: fs.readFileSync(target), mode: fs.statSync(target).mode & 0o777 } : null);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const parent = fs.realpathSync(path.dirname(target)), base = fs.realpathSync(directory);
            if (parent !== base && !parent.startsWith(base + path.sep)) throw new Error('Credential parent must remain in its certificate directory');
            const descriptor = fs.openSync(target, 'w', 0o600);
            try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
            const parentDescriptor = fs.openSync(parent, 'r');
            try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
        }
        return commit();
    } catch (error) {
        for (const [target, old] of previous) {
            if (old) { fs.writeFileSync(target, old.bytes); fs.chmodSync(target, old.mode); }
            else fs.rmSync(target, { force: true });
        }
        throw error;
    }
}

/** Idempotent CLI provisioning validates existing bytes and preserves participant-owned material. */
function provisionLeaf({ directory, certName, keyName, caName = 'rootCA.crt', caKeyName = 'rootCA.key', ...options }) {
    const certPath = path.join(directory, certName), keyPath = path.join(directory, keyName);
    const ca = fs.readFileSync(path.join(directory, caName));
    if (fs.existsSync(certPath)) {
        if (!fs.existsSync(keyPath)) throw new Error(`Existing ${certName} has no private key; explicit credential repair is required`);
        return validatePair({ ...options, cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), ca });
    }
    const result = generateLeaf({ ...options, ca, caKey: fs.readFileSync(path.join(directory, caKeyName)), key: fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : undefined });
    publishFiles(directory, { [certName]: result.cert, [keyName]: result.key });
    return result;
}
module.exports = { validatePair, generateLeaf, publishFiles, provisionLeaf };
