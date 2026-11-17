'use strict';

/** Browser navigation is independent of configured OAuth and FHIR identities. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Return an origin using only proxy information trusted by Express. */
function browserOrigin(req) {
    if (!req || typeof req.get !== 'function') return '';
    const trust = req.app?.get('trust proxy fn');
    const trusted = typeof trust === 'function' && trust(req.socket?.remoteAddress, 0);
    const forwarded = trusted && req.get('x-forwarded-host');
    const host = String(forwarded ? forwarded.split(',')[0] : req.get('host') || '').trim();
    // Host is an authority, never a URL or userinfo. Reject malformed header syntax.
    if (!host || /[\\/?#@,\s]/.test(host)) return '';
    try {
        const url = new URL(`${req.protocol || 'http'}://${host}`);
        return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
    } catch { return ''; }
}

/** Resolve one configured browser destination without changing its listener, path or logical identity. */
function browserDestination(value, req) {
    const origin = browserOrigin(req);
    if (!origin) return value;
    try {
        const destination = new URL(value);
        if (LOOPBACK.has(destination.hostname)) destination.hostname = new URL(origin).hostname;
        return destination.toString().replace(/\/+$/, '');
    } catch { return value; }
}

/** Use the existing HTTPS browser/API listener for the local test workflow, preserving a declared proxy prefix. */
function pcmWorkflowUrl(config, req) {
    const destination = new URL(browserDestination(config.publicBaseUrls.pcmApi, req));
    const path = require('./pcm-environment').PCM_PATH;
    const prefix = destination.pathname.endsWith(path) ? destination.pathname.slice(0, -path.length) : destination.pathname.replace(/\/+$/, '');
    destination.pathname = `${prefix}/sandbox/authentication`;
    destination.search = ''; destination.hash = '';
    return destination.toString();
}

/** Resolve UI bases, preserving explicit remote destinations and proxy path prefixes.
 * @param {object} urls Configured public bases (never mutated).
 * @param {object} req Express request with its configured proxy trust policy.
 * @param {string} ownKey Key of the current application, whose links stay relative.
 * @returns {object} Copy with browser-only spClient/pcmUi bases.
 */
function browserNavigation(urls, req, ownKey) {
    const result = { ...urls };
    const origin = browserOrigin(req);
    if (!origin) return result;
    for (const key of ['spClient', 'pcmUi']) {
        if (!urls[key]) continue;
        try {
            const destination = new URL(urls[key]);
            if (key === ownKey) {
                result[key] = destination.pathname.replace(/\/+$/, '');
            } else if (LOOPBACK.has(destination.hostname)) {
                destination.hostname = new URL(origin).hostname;
                result[key] = destination.toString().replace(/\/+$/, '');
            }
        } catch { /* Leave invalid configuration to the canonical validator. */ }
    }
    return result;
}

/** Join a known local browser route to an explicitly configured application mount.
 * This never changes a protocol URL, callback registration or backend address.
 */
function applicationPath(base, route = '/', { fhirBase = false } = {}) {
    if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) throw new TypeError('Browser route must be a local absolute path');
    const url = new URL(base);
    const fhir = require('./pcm-environment').PCM_PATH;
    const prefix = fhirBase && url.pathname.endsWith(fhir) ? url.pathname.slice(0, -fhir.length) : url.pathname.replace(/\/+$/, '');
    return `${prefix}${route}`;
}

module.exports = { browserNavigation, browserOrigin, browserDestination, pcmWorkflowUrl, applicationPath };
