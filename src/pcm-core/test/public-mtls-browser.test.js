'use strict';
/** Only exact maintained browser pages and GET assets bypass backend client-certificate dispatch. */
const test = require('node:test'), assert = require('node:assert/strict');
const { isBrowserAuthorizationRequest } = require('../src/public-mtls');
const { PCM_PATH } = require('../../shared/pcm-environment');
test('SMART resume and advisory UI script are narrow browser exceptions', () => {
    for (const url of [`${PCM_PATH}/authorize/resume?transaction_id=opaque`, '/assets/smart-authorization.js']) {
        assert.equal(isBrowserAuthorizationRequest({ method: 'GET', originalUrl: url }), true);
        assert.equal(isBrowserAuthorizationRequest({ method: 'POST', originalUrl: url }), false);
    }
    for (const url of [`${PCM_PATH}/authorize/resume/other`, `${PCM_PATH}/token`, '/assets/smart-authorization.js/other', '/assets/smart-authorization.js.map']) assert.equal(isBrowserAuthorizationRequest({ method: 'GET', originalUrl: url }), false);
});
