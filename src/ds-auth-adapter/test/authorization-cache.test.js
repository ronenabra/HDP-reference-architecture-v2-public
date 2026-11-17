'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActiveIntrospectionCache } = require('../src/authorization-cache');
const { validateIntrospectionResponse } = require('../src/introspection-contract');
const { AUDIENCE, NOW, dataSourceResponse, options } = require('../test-support/introspection-fixture');

test('active cache expires at the lower of source exp and 30 seconds without extending on reads', () => {
    let milliseconds = NOW * 1000;
    const cache = new ActiveIntrospectionCache({ clock: () => milliseconds });
    const context = validateIntrospectionResponse({ ...dataSourceResponse(), exp: NOW + 10 }, options);
    const binding = { hoId: 'ho-a', expectedAudience: AUDIENCE };
    assert.equal(cache.put('opaque-token', binding, context), true);
    milliseconds += 9000;
    assert.equal(cache.get('opaque-token', binding), context);
    milliseconds += 1000;
    assert.equal(cache.get('opaque-token', binding), null);
});

test('cache keys and values are pairwise isolated by HO and exact audience', () => {
    const cache = new ActiveIntrospectionCache({ clock: () => NOW * 1000 });
    const context = validateIntrospectionResponse(dataSourceResponse(), options);
    const a = { hoId: 'ho-a', expectedAudience: AUDIENCE };
    cache.put('same-token', a, context);
    assert.equal(cache.get('same-token', { hoId: 'ho-b', expectedAudience: AUDIENCE }), null);
    assert.equal(cache.get('same-token', { hoId: 'ho-a', expectedAudience: 'https://ho-b.example.test/fhir' }), null);
    assert.equal(cache.put('same-token', { hoId: 'ho-b', expectedAudience: AUDIENCE }, context), false);
    cache.invalidate('same-token', a);
    assert.equal(cache.get('same-token', a), null);
});

test('inactive responses are never cached', () => {
    const cache = new ActiveIntrospectionCache({ clock: () => NOW * 1000 });
    assert.equal(cache.put('token', { hoId: 'ho-a', expectedAudience: AUDIENCE }, { active: false }), false);
});


test('ordinary cache reads reclaim unrelated expired keys in bounded batches', () => {
    let now = NOW * 1000;
    const cache = new ActiveIntrospectionCache({ clock: () => now });
    const binding = { hoId: 'ho-a', expectedAudience: AUDIENCE };
    const context = validateIntrospectionResponse(dataSourceResponse(), options);
    for (let index = 0; index < 65; index++) cache.put(`expired-${index}`, binding, context);
    now += 30_000;
    const active = validateIntrospectionResponse({ ...dataSourceResponse(), exp: NOW + 120 }, options);
    cache.put('active', binding, active);
    assert.ok(cache.entries.size >= 65 - 16 + 1, 'put must reclaim only one batch');
    for (let index = 0; index < 20; index++) {
        const before = cache.entries.size;
        assert.equal(cache.get('active', binding), active);
        assert.ok(before - cache.entries.size <= 16);
    }
    assert.equal(cache.entries.size, 1);
    cache.clear();
    assert.equal(cache.get('active', binding), null);
});

test('disabled public expiry simulation never caches beyond the actual returned exp', () => {
    let milliseconds = NOW * 1000;
    const cache = new ActiveIntrospectionCache({ clock: () => milliseconds });
    const simulated = validateIntrospectionResponse({ ...dataSourceResponse(), exp: NOW + 1 }, { ...options, controls: { tokenExpiry: false } });
    const binding = { hoId: 'ho-a', expectedAudience: AUDIENCE };
    assert.equal(simulated.token.expiresAt, NOW + 1);
    assert.equal(cache.put('short', binding, simulated), true);
    milliseconds += 1000;
    assert.equal(cache.get('short', binding), null);
    assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), exp: NOW - 1 }, { ...options, controls: { tokenExpiry: false } }), /future integer/i);
});

test('policy revisions and context schema version partition positive cache identities', () => {
    const cache = new ActiveIntrospectionCache({ clock: () => NOW * 1000 });
    const context = validateIntrospectionResponse(dataSourceResponse(), options);
    const binding = { hoId: 'ho-a', expectedAudience: AUDIENCE, policyStamp: 'source-policy-one' };
    assert.equal(cache.put('same', binding, context), true);
    assert.equal(cache.get('same', { ...binding, policyStamp: 'source-policy-two' }), null);
    assert.equal(cache.put('old', binding, { ...context, schema: 'pcm-ds-authorization-context/2' }), false);
});
