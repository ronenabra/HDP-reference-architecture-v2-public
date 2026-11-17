'use strict';

/** Stage custom-source credentials while preserving separate server-trust configuration. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { generateLeaf, validatePair } = require('../../shared/role-credentials');
const { signingAlgorithm } = require('../../shared/assertion-keys');
const { buildEffectivePolicy, compatibilityAdapterEnabled } = require('../../shared/conformance-policy');

/** Prepare role material in memory; the Admin caller publishes it with its config mutation. */
function prepareSourceCredentials({ directory, config, source, certContent, keyContent, transportCertContent, transportKeyContent, generate = false }) {
    const auth = source.pcmClientAuth;
    if (!auth?.cert || !auth.key) throw new Error('Source certificate and key role paths are required');
    const read = name => fs.readFileSync(path.join(directory, name));
    const configured = Object.entries(auth.assertionCertificates || {}).find(([, names]) => (Array.isArray(names) ? names : [names]).includes(auth.cert))?.[0];
    const legacyRs256 = configured === 'RS256' && compatibilityAdapterEnabled(buildEffectivePolicy(config, {}), 'legacy-rs256-assertion');
    let algorithm = configured || 'ES256';
    if (!configured && fs.existsSync(path.join(directory, auth.cert))) {
        try { algorithm = signingAlgorithm(read(auth.cert)); } catch (_) { /* Explicit regeneration upgrades legacy unusable RSA assertions to EC. */ }
    }
    if (Boolean(certContent) !== Boolean(keyContent)) throw new Error('Upload the matching client certificate and private key together');
    const ca = read(config.certificates.rootCaCert || 'rootCA.crt');
    const options = { assertion: true, clientAuth: !auth.mtlsCert || auth.mtlsCert === auth.cert, algorithm: certContent && !configured ? undefined : algorithm, legacyRs256, ca };
    const pair = certContent ? validatePair({ ...options, cert: certContent, key: keyContent })
        : generate ? generateLeaf({ ...options, caKey: read('rootCA.key'), commonName: source.id })
            : validatePair({ ...options, cert: read(auth.cert), key: read(auth.key) });
    const material = certContent || generate ? { [auth.cert]: pair.cert, [auth.key]: pair.key } : {};
    let transport = pair;
    if (Boolean(auth.mtlsCert) !== Boolean(auth.mtlsKey)) throw new Error('Both separate transport certificate and key paths are required');
    if (auth.mtlsCert && (auth.mtlsCert !== auth.cert || auth.mtlsKey !== auth.key)) {
        if (auth.mtlsCert === auth.cert || auth.mtlsKey === auth.key) throw new Error('Shared roles must reference the same certificate and key pair');
        let transportAlgorithm = 'RSA';
        if (fs.existsSync(path.join(directory, auth.mtlsCert))) {
            const current = new crypto.X509Certificate(read(auth.mtlsCert));
            if (current.publicKey.asymmetricKeyType === 'ec') transportAlgorithm = signingAlgorithm(current.publicKey);
        }
        if (Boolean(transportCertContent) !== Boolean(transportKeyContent)) throw new Error('Upload the matching transport certificate and private key together');
        if (certContent && !transportCertContent) throw new Error('Separate transport credentials require their own certificate and private key files');
        transport = generate ? generateLeaf({ ca, caKey: read('rootCA.key'), commonName: `${source.id.slice(0, 54)}-mtls`, algorithm: transportAlgorithm, clientAuth: true })
            : validatePair({ ca, cert: transportCertContent || read(auth.mtlsCert), key: transportKeyContent || read(auth.mtlsKey), clientAuth: true });
        if (transport.thumbprint === pair.thumbprint) throw new Error('Separate credential profiles require different transport and assertion certificates');
        if (generate || transportCertContent) Object.assign(material, { [auth.mtlsCert]: transport.cert, [auth.mtlsKey]: transport.key });
    } else if (transportCertContent || transportKeyContent) {
        throw new Error('Shared credentials accept one certificate and private key pair');
    }
    if (certContent) auth.managedBy = 'participant';
    else if (generate) auth.managedBy = 'team';
    auth.certThumbprint = transport.thumbprint;
    return { material, thumbprint: transport.thumbprint, assertionThumbprint: pair.thumbprint };
}

/** Parse a separate server CA without confusing it with PCM client trust. */
function validateServerCa(content) {
    try { if (!new crypto.X509Certificate(content).ca) throw new Error(); }
    catch (_) { throw new Error('Server trust upload must contain a valid CA certificate'); }
    return content;
}
/** Read public certificate facts only; inventories never read private key files.
 * @param {string} directory Backend certificate directory.
 * @param {object} source Current source registration with approved role paths.
 * @returns {object[]} Detached role/fingerprint/validity facts, including explicit unavailable states.
 */
function credentialFacts(directory, source) {
    const auth = source.pcmClientAuth || {};
    return [['Assertion', auth.cert], ['PCM transport', auth.mtlsCert || auth.cert]].map(([role, name]) => {
        try {
            const certificate = new crypto.X509Certificate(fs.readFileSync(path.join(directory, name)));
            return { role, fingerprint: crypto.createHash('sha256').update(certificate.raw).digest('base64url'), validFrom: certificate.validFrom, validTo: certificate.validTo };
        } catch (_) { return { role, fingerprint: 'Unavailable', validFrom: 'Unknown', validTo: 'Unknown' }; }
    });
}
module.exports = { prepareSourceCredentials, validateServerCa, credentialFacts };
