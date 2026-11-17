'use strict';

/** Existing source HTTPS trust modes shared by Doctor and PCM workflow calls. */
const fs = require('node:fs'), path = require('node:path'), tls = require('node:tls');
const { certificateConfirmation } = require('./assertion-keys');

/** Build server verification only; each caller supplies its own registered client credentials. */
function sourceServerTls({ trust = {}, certsDir, rootCaCert = 'rootCA.crt', verify = true }) {
    const mode = trust.mode || 'team-root-ca';
    if (!['team-root-ca', 'system-ca', 'custom-ca', 'pinned-thumbprint', 'insecure-skip-verify'].includes(mode)) throw new Error('Unsupported source HTTPS trust mode');
    const options = { rejectUnauthorized: verify && mode !== 'insecure-skip-verify' };
    if (options.rejectUnauthorized && mode !== 'system-ca') {
        const filename = mode === 'custom-ca' ? trust.caCert : rootCaCert;
        if (!filename) throw new Error('The source HTTPS CA is missing');
        options.ca = fs.readFileSync(path.join(certsDir, filename));
    }
    if (options.rejectUnauthorized && mode === 'pinned-thumbprint') {
        if (!/^[A-Za-z0-9_-]{43}$/.test(trust.certThumbprint || '')) throw new Error('The source HTTPS certificate pin is missing');
        options.checkServerIdentity = (host, certificate) => tls.checkServerIdentity(host, certificate)
            || (certificateConfirmation(certificate.raw)['x5t#S256'] !== trust.certThumbprint ? new Error('Data source certificate thumbprint mismatch') : undefined);
    }
    return options;
}
module.exports = { sourceServerTls };
