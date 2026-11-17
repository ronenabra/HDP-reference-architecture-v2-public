'use strict';
/** Browser result isolation, finite retention and authored recovery without untrusted callback prose. */
const test = require('node:test'), assert = require('node:assert/strict');
const { createSmartFeedback, smartFailure } = require('../src/smart-feedback');
test('SMART feedback is private, bounded, expires and is read once', () => {
    let now = 1; const store = createSmartFeedback({ clock: () => now, limit: 2 });
    store.put('one', { message: 'success' }); assert.equal(store.take('another'), undefined);
    store.put('two', { message: 'denied' }); assert.deepEqual(store.take('one'), { message: 'success' }); assert.equal(store.take('one'), undefined);
    store.put('three', {}); store.put('four', {}); assert.equal(store.take('two'), undefined);
    now += 300001; assert.equal(store.take('four'), undefined);
});
test('denial, cancellation, identity, scope, expiry and exchange failure have distinct actionable results', () => {
    assert.equal(smartFailure({ oauthError: 'access_denied', message: 'The test launch was cancelled.' }).message, 'SMART test cancelled.');
    assert.equal(smartFailure({ oauthError: 'access_denied', message: 'The test launch was denied.' }).message, 'SMART test denied.');
    assert.match(smartFailure({ oauthError: 'access_denied', message: 'https://evil.test' }).message, /identity/);
    assert.match(smartFailure({ oauthError: 'invalid_scope' }).explanation, /at least one/);
    assert.match(smartFailure({}, 'state').explanation, /another browser/);
    assert.match(smartFailure({ canonicalBase: 'https://doctor.test' }, 'start').explanation, /registered SMART callback/);
    assert.equal(JSON.stringify(smartFailure({ message: 'private-key-secret' })).includes('private-key-secret'), false);
});
