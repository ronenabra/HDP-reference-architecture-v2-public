/**
 * Cryptographic helpers used by PCM services.
 */
const crypto = require('crypto');

/**
 * Convert a PEM string or DER buffer to an x5t#S256 thumbprint (base64url).
 * @param {Buffer|string} certInput
 * @returns {string}
 */
function certToX5tS256(certInput) {
    let der = certInput;

    if (typeof certInput === 'string') {
        const lines = certInput.split('\n');
        let base64Body = '';
        for (const line of lines) {
            if (line.trim().startsWith('-----')) continue;
            base64Body += line.trim();
        }
        der = Buffer.from(base64Body, 'base64');
    }

    if (!Buffer.isBuffer(der)) {
        throw new Error('certToX5tS256 expects a Buffer or PEM string');
    }

    return crypto.createHash('sha256').update(der).digest('base64url');
}

module.exports = {
    certToX5tS256
};
