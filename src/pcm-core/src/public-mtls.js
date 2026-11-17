'use strict';

/**
 * Central PCM public-transport identity boundary.
 *
 * The current local and AWS NLB topology uses TLS passthrough, so the only
 * trusted client-certificate signal is the authorized TLS socket itself.
 * Forwarded certificate/status headers are intentionally ignored. A future
 * terminating proxy must authenticate to a separately configured internal
 * listener before this module can gain a proxy identity provider.
 */

const crypto = require('crypto');
const { getEffectiveConformancePolicy } = require('./team-config');
const logger = require('./logger');

const SPOOFABLE_CERTIFICATE_HEADERS = Object.freeze([
    'x-client-cert',
    'x-forwarded-client-cert',
    'x-ssl-client-cert',
    'x-ssl-client-verify',
    'x-client-cert-thumbprint'
]);

function socketCertificateIdentity(req) {
    const socket = req?.socket;
    if (!socket?.encrypted || socket.authorized !== true || typeof socket.getPeerCertificate !== 'function') return null;
    const certificate = socket.getPeerCertificate(true);
    if (!certificate || !Object.keys(certificate).length || !certificate.raw) return null;
    return Object.freeze({
        source: 'direct-tls',
        thumbprint: crypto.createHash('sha256').update(certificate.raw).digest('base64url'),
        subject: certificate.subject || {},
        issuer: certificate.issuer || {},
        validFrom: certificate.valid_from || null,
        validTo: certificate.valid_to || null
    });
}

function hasSpoofedCertificateHeaders(req) {
    return SPOOFABLE_CERTIFICATE_HEADERS.some(name => req?.headers?.[name] !== undefined);
}

function rejectionBody(kind) {
    if (kind === 'fhir') {
        return {
            resourceType: 'OperationOutcome',
            issue: [{ severity: 'error', code: 'login', diagnostics: 'Valid client certificate required' }]
        };
    }
    return { error: 'access_denied', error_description: 'Valid client certificate required' };
}

function createPublicMtlsMiddleware(options = {}) {
    const kind = options.kind || 'oauth';
    return (req, res, next) => {
        const policy = getEffectiveConformancePolicy();
        const identity = socketCertificateIdentity(req);
        if (identity) req.mtls = identity;
        if (policy.transport.pcmPublic.clientAuth !== 'mtls') return next();
        if (!identity) {
            logger.warn('PCM public request rejected at application mTLS defense', {
                type: 'PUBLIC_MTLS_REJECTED',
                reason: req?.socket?.authorizationError || 'authorized direct TLS client certificate missing',
                spoofedCertificateHeadersIgnored: hasSpoofedCertificateHeaders(req)
            });
            return res.status(401).json(rejectionBody(kind));
        }
        return next();
    };
}

/**
 * Match exact certificate-free browser routes before backend dispatch.
 * @param {import("express").Request} req Observed method and original URL.
 * @returns {boolean} Whether the request belongs to the browser interaction.
 */
function isBrowserAuthorizationRequest(req) {
    const base = require('../../shared/pcm-environment').PCM_PATH;
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    const loginBase = '/sandbox/authentication';
    const loginActions = ['local-sso', 'fixture-start', 'start', 'verify', 'resend', 'cancel', 'local-code', 'discover', 'presence', 'presence-dependents', 'select'];
    return (req.method === 'GET' && pathname === loginBase)
        || (req.method === 'POST' && loginActions.some(action => pathname === `${loginBase}/${action}`))
        || ((req.method === 'GET' || req.method === 'POST') && pathname === `${base}/authorize`)
        || (req.method === 'POST' && pathname === `${base}/authorize/decision`)
        || (req.method === 'GET' && pathname === `${base}/authorize/resume`)
        || (req.method === 'GET' && ['/assets/connectathon.css', '/assets/help-copy.js', '/assets/help.js', '/assets/system-authentication.js', '/assets/smart-authorization.js'].includes(pathname));
}

/**
 * Build the effective-policy browser HTTPS/backend mTLS dispatch boundary.
 * @returns {import("express").RequestHandler} Middleware using direct TLS evidence.
 */
function createBrowserAwareMtlsMiddleware() {
    const backend = createPublicMtlsMiddleware({ kind: 'oauth' });
    return (req, res, next) => {
        if (!isBrowserAuthorizationRequest(req)) return backend(req, res, next);
        const policy = getEffectiveConformancePolicy();
        if (policy.transport.pcmPublic.browserHttpsRequired && req.socket?.encrypted !== true) {
            return res.status(401).json({ error: 'access_denied', error_description: 'Browser authorization requires HTTPS' });
        }
        return next();
    };
}

module.exports = {
    SPOOFABLE_CERTIFICATE_HEADERS,
    isBrowserAuthorizationRequest,
    createBrowserAwareMtlsMiddleware,
    createPublicMtlsMiddleware,
    hasSpoofedCertificateHeaders,
    rejectionBody,
    socketCertificateIdentity
};
