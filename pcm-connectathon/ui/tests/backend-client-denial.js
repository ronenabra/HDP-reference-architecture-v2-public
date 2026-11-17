'use strict';

/** Classify actual backend certificate denials without mistaking availability errors for authorization. */
function isBackendCertificateDenial(failure) {
    if (!failure) return false;
    const status = failure.details?.status;
    if (status !== undefined) return status === 401 || status === 403;
    return /TLS|SSL|CERT|unknown.ca|handshake|socket hang up|ECONNRESET|EPIPE/i.test(`${failure.details?.message || ''} ${failure.message || ''}`);
}
/** Identify the application certificate guard separately from JWT assertion denials. */
function isCertificateGuardBody(body) {
    return body?.error === 'access_denied' && body?.error_description === 'Valid client certificate required';
}
module.exports = { isBackendCertificateDenial, isCertificateGuardBody };
