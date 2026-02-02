/**
 * mTLS certificate utilities for thumbprint comparison.
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

/**
 * Decode nginx $ssl_client_escaped_cert into PEM.
 * @param {string|undefined|null} escapedPem
 * @returns {string|null}
 */
function decodeEscapedPem(escapedPem) {
    if (!escapedPem) return null;
    // nginx $ssl_client_escaped_cert is URL-escaped PEM
    const decoded = decodeURIComponent(escapedPem.replace(/\+/g, '%20'));
    return decoded;
}

/**
 * Compute the x5t#S256 thumbprint from an escaped PEM header.
 * @param {string|undefined|null} escapedPem
 * @returns {string|null}
 */
function thumbprintFromEscapedPem(escapedPem) {
    const pem = decodeEscapedPem(escapedPem);
    if (!pem) return null;
    return certToX5tS256(pem);
}

module.exports = {
    certToX5tS256,
    decodeEscapedPem,
    thumbprintFromEscapedPem
};
