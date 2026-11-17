'use strict';

/** Exact configured Doctor callback selection, independent of logical PCM transport identities. */
const { browserOrigin, applicationPath } = require('./browser-navigation');

/** Validate/normalize an explicitly configured application base; never accept credentials or request metadata. */
function doctorBrowserBase(value) {
    let url;
    try { if (typeof value !== 'string') throw new Error('missing'); url = new URL(value); }
    catch (_) { throw new TypeError('Enter an explicit HTTP(S) Doctor browser application address.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Doctor browser base must be an HTTP(S) application address without credentials, query or fragment');
    return url.toString().replace(/\/+$/, '');
}
/** Derive the single generated callback from the explicit browser base and its supported mount. */
function doctorCallback(base) { return `${doctorBrowserBase(base)}/callback`; }
/** Retain exact registered bytes rather than inferring a registration from a browser hostname. */
function registeredCallbacks(organization) {
    return Array.isArray(organization?.redirectUris) ? [...organization.redirectUris] : organization?.redirectUri ? [organization.redirectUri] : [];
}
/** Choose only a currently registered exact callback on the observed browser origin and configured mount. */
function selectDoctorCallback(config, organization, req) {
    const registered = registeredCallbacks(organization);
    const canonical = doctorCallback(config.publicBaseUrls.spClient);
    if (!req) {
        const selected = organization?.redirectUri || registered[0];
        if (selected && registered.includes(selected)) return selected;
        throw new Error('No exact registered SMART callback is configured for this application.');
    }
    const origin = browserOrigin(req);
    const expected = origin ? `${origin}${applicationPath(config.publicBaseUrls.spClient, '/callback')}` : null;
    if (expected && registered.includes(expected)) return expected;
    const error = new Error('This Doctor address has no matching registered SMART callback. Configure its exact browser address and callback, or restart at the configured address.');
    if (registered.includes(canonical)) error.canonicalBase = doctorBrowserBase(config.publicBaseUrls.spClient);
    throw error;
}
/** Explicit reviewed canonical migration for existing enabled Doctor registrations; never enables another client. */
function withDoctorBrowserAddress(config, base) {
    const next = structuredClone(config); next.publicBaseUrls.spClient = doctorBrowserBase(base);
    const callback = doctorCallback(base);
    for (const role of ['serviceProvider', 'hospitalBServiceProvider']) {
        const organization = next.organizations[role];
        if (role !== 'serviceProvider' && (!registeredCallbacks(organization).length || !organization?.smartScopes?.length)) continue;
        organization.redirectUri = callback; organization.redirectUris = [callback];
    }
    return next;
}
module.exports = { doctorBrowserBase, doctorCallback, registeredCallbacks, selectDoctorCallback, withDoctorBrowserAddress };
