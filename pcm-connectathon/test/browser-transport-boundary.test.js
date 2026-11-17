'use strict';

/** Real status/transport distinctions for the browser's negative certificate fixture. */
const test = require('node:test'), assert = require('node:assert/strict');
const { isBackendCertificateDenial, isCertificateGuardBody } = require('../ui/tests/backend-client-denial');

test('backend certificate denial accepts authentication responses and genuine TLS failure only', () => {
    for (const status of [401, 403]) assert.equal(isBackendCertificateDenial({ details: { status } }), true);
    for (const status of [200, 302, 400, 404, 405, 500, 503]) assert.equal(isBackendCertificateDenial({ details: { status }, message: 'TLS listener' }), false);
    assert.equal(isBackendCertificateDenial({ details: { message: 'TLS certificate rejected' } }), true);
    assert.equal(isBackendCertificateDenial({ message: 'socket hang up' }), true);
    for (const failure of [undefined, {}, { details: {} }, { message: 'DNS unavailable' }, { details: { status: null }, message: 'TLS failure' }]) assert.equal(isBackendCertificateDenial(failure), false);
});

test('certificate guard body cannot be confused with assertion denial or another access denial', () => {
    assert.equal(isCertificateGuardBody({ error: 'access_denied', error_description: 'Valid client certificate required' }), true);
    for (const body of [undefined, {}, { error: 'invalid_client', error_description: 'Valid client certificate required' },
        { error: 'access_denied', error_description: 'Browser authorization requires HTTPS' }, { error: 'access_denied' }]) {
        assert.equal(isCertificateGuardBody(body), false);
    }
});
