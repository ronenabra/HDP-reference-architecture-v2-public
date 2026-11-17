"use strict";

/** Registered assertion key identity, distinct from TLS certificate identity. */
const crypto = require('crypto');

/**
 * Return the public key from PEM certificate/key material or an existing key.
 * @param {string|Buffer|import("crypto").KeyObject} material Registered key material.
 * @returns {import("crypto").KeyObject} The corresponding public key.
 */
function publicKey(material) {
    if (material?.type === 'public') return material;
    return crypto.createPublicKey(material);
}

/**
 * Calculate the unpadded RFC 7638 SHA-256 thumbprint of an approved JWK.
 * @param {string|Buffer|import("crypto").KeyObject} material Registered key material.
 * @returns {string} Canonical base64url SHA-256 JWK identity.
 */
function jwkThumbprint(material) {
    const jwk = publicKey(material).export({ format: 'jwk' });
    const members = jwk.kty === 'EC'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
        : { e: jwk.e, kty: jwk.kty, n: jwk.n };
    return crypto.createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

/**
 * Choose an approved signing algorithm from the actual key curve.
 * @param {string|Buffer|import("crypto").KeyObject} material Assertion key material.
 * @returns {string} ES256 for P-256 or ES384 for P-384.
 */
function signingAlgorithm(material) {
    const curve = publicKey(material).asymmetricKeyDetails?.namedCurve;
    if (curve === 'prime256v1') return 'ES256';
    if (curve === 'secp384r1') return 'ES384';
    throw new TypeError('Assertion signing key must use P-256 or P-384');
}

/** Derive certificate correlation from actual TLS PEM/DER material, independently of the signing key. */
function certificateConfirmation(certificate) {
    const parsed = new crypto.X509Certificate(certificate);
    return { 'x5t#S256': crypto.createHash('sha256').update(parsed.raw).digest('base64url') };
}

module.exports = { jwkThumbprint, publicKey, signingAlgorithm, certificateConfirmation };
