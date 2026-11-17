'use strict';
/** Injected-clock observations must preserve cache authority and concurrent network semantics. */
const test = require('node:test'), assert = require('node:assert/strict');
const { ActiveIntrospectionCache } = require('../src/authorization-cache');
const { IntrospectionCredentialCache } = require('../src/oauth-client');
const { validateIntrospectionResponse } = require('../src/introspection-contract');
const { NOW, AUDIENCE, dataSourceResponse, options } = require('../test-support/introspection-fixture');

test('subject observer distinguishes miss/hit/expired/invalidation without changing lifetime or binding', () => {
    let now = NOW * 1000; const cache = new ActiveIntrospectionCache({ clock: () => now }); const events = [];
    const binding = { hoId: 'ho-a', expectedAudience: AUDIENCE, policyStamp: 'actual-policy' }, observe = event => events.push(event);
    const context = validateIntrospectionResponse(dataSourceResponse(), options);
    assert.equal(cache.get('opaque', binding, observe), null); cache.put('opaque', binding, context);
    now += 1000; assert.equal(cache.get('opaque', binding, observe), context);
    assert.deepEqual(events.at(-1), { cache: 'subject-decision', outcome: 'hit', reasonCode: 'CACHE_HIT', ageMs: 1000, remainingMs: 29000,
        hoId: 'ho-a', audience: AUDIENCE, policyFingerprint: 'actual-policy', networkCall: false });
    now += 29000; assert.equal(cache.get('opaque', binding, observe), null); assert.equal(events.at(-1).outcome, 'expired');
    cache.invalidate('opaque', binding, observe); assert.equal(events.at(-1).outcome, 'invalidated');
    assert.deepEqual(events.map(event => event.outcome), ['miss', 'hit', 'expired', 'invalidated']);
});
test('credential cache has separate age/TTL and failed observer cannot authorize or extend it', () => {
    let now = 1000; const cache = new IntrospectionCredentialCache({ clock: () => now }); const events = [], observe = event => events.push(event);
    assert.equal(cache.get(observe), null);
    cache.put({ access_token: 'credential', token_type: 'Bearer', expires_in: 30, scope: 'system/*.crus' });
    now += 2000; assert.equal(cache.get(observe), 'credential'); assert.equal(events.at(-1).ageMs, 2000); assert.equal(events.at(-1).remainingMs, 28000);
    assert.equal(cache.get(() => { throw Error('observer failure'); }), 'credential');
    now += 28000; assert.equal(cache.get(observe), null); assert.equal(events.at(-1).outcome, 'expired');
    cache.clear(observe); assert.equal(events.at(-1).cache, 'introspection-credential');
});
test('closed validator reports actual issuer/audience/expiry failure without decoding subject tokens', () => {
    for (const [patch, code] of [[{ iss: 'https://other.example' }, 'INVALID_ISSUER'], [{ aud: 'https://other.example' }, 'INVALID_AUDIENCE'], [{ exp: NOW }, 'EXPIRED_TOKEN']]) {
        assert.throws(() => validateIntrospectionResponse({ ...dataSourceResponse(), ...patch }, options), error => error.reasonCode === code);
    }
});
test('Node observations share the exact native schema and versioned reason catalog', () => {
    const contract = require('../../ho-fhir-server/src/main/resources/pcm-observability-event-contract.json');
    assert.equal(contract.schemaVersion, '1.0');
    const events=[],cache=new ActiveIntrospectionCache({clock:()=>NOW*1000});
    cache.get('token',{hoId:'ho-a',expectedAudience:AUDIENCE},event=>events.push(event));
    for(const event of events)assert.ok(contract.reasonCodes.includes(event.reasonCode));
    assert.ok(contract.eventNames.includes('DS_CACHE_DECISION'));assert.ok(contract.eventNames.includes('DS_AUTHORIZATION_DECISION'));
    assert.equal(contract.limits.queueBytes,8*1024*1024);
});
