'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { PcmIntrospectionClient } = require('../src/pcm-introspection-client');
const { AUDIENCE, ISSUER, NOW, dataSourceResponse } = require('../test-support/introspection-fixture');

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function makeClient(http, overrides = {}) {
    return new PcmIntrospectionClient({
        http,
        httpsAgent: new (require('node:https').Agent)({ cert: require('node:fs').readFileSync(require('node:path').join(require('../../../test-support/certificates').certificates(), 'ho-a-gateway-mtls.crt')) }),
        clientId: 'pcm-ds-client-0001',
        privateKey,
        tokenEndpoint: `${ISSUER}/token`,
        introspectionEndpoint: `${ISSUER}/introspect`,
        expectedIssuer: ISSUER,
        expectedAudience: AUDIENCE,
        hoId: 'ho-a',
        authMode: 'direct',
        timeout: 100,
        secondsClock: () => NOW,
        millisClock: () => NOW * 1000,
        ...overrides
    });
}

test('direct assertion mode posts a fresh assertion to exact introspection audience', async () => {
    const bodies = [];
    const client = makeClient({ post: async (_url, body) => { bodies.push(Object.fromEntries(new URLSearchParams(body))); return { data: dataSourceResponse() }; } });
    const decision = await client.introspect('opaque-subject');
    assert.equal(decision.kind, 'data-source-access');
    const decoded = jwt.decode(bodies[0].client_assertion);
    assert.equal(decoded.aud, `${ISSUER}/introspect`);
    assert.deepEqual(decoded.cnf, require('../../shared/assertion-keys').certificateConfirmation(client.httpsAgent.options.cert));
    assert.equal(bodies[0].token_type_hint, 'access_token');
});

test('bearer mode refreshes one rejected credential and uses exact token request', async () => {
    const calls = [];
    const http = { post: async (url, body, config) => {
        calls.push({ url, body: Object.fromEntries(new URLSearchParams(body)), headers: config.headers });
        if (url.endsWith('/token')) return { data: { access_token: `credential-${calls.length}`, token_type: 'Bearer', expires_in: 30, scope: 'system/*.crus' } };
        if (calls.filter(call => call.url.endsWith('/introspect')).length === 1) {
            const error = new Error('rejected'); error.response = { status: 401 }; throw error;
        }
        return { data: dataSourceResponse() };
    } };
    const client = makeClient(http, { authMode: 'bearer' });
    assert.equal((await client.introspect('opaque')).active, true);
    const tokenCalls = calls.filter(call => call.url.endsWith('/token'));
    assert.equal(tokenCalls.length, 2);
    for (const call of tokenCalls) assert.deepEqual(jwt.decode(call.body.client_assertion).cnf, require('../../shared/assertion-keys').certificateConfirmation(client.httpsAgent.options.cert));
    assert.notEqual(jwt.decode(tokenCalls[0].body.client_assertion).jti, jwt.decode(tokenCalls[1].body.client_assertion).jti);
    assert.equal(tokenCalls[0].body.scope, 'system/*.crus');
    assert.equal(tokenCalls[0].body.resource, `${ISSUER}/introspect`);
    assert.match(calls.at(-1).headers.Authorization, /^Bearer credential-/);
});

test('cached active state expires and a later inactive result invalidates state', async () => {
    let seconds = NOW;
    let milliseconds = NOW * 1000;
    let calls = 0;
    const http = { post: async () => ({ data: calls++ === 0 ? dataSourceResponse() : { active: false } }) };
    const client = makeClient(http, { secondsClock: () => seconds, millisClock: () => milliseconds });
    assert.equal((await client.introspect('opaque')).active, true);
    assert.equal((await client.introspect('opaque')).active, true);
    assert.equal(calls, 1);
    seconds += 31; milliseconds += 31000;
    assert.deepEqual(await client.introspect('opaque'), { active: false });
    assert.equal(calls, 2);
});

test('unreachable PCM and malformed responses fail closed', async () => {
    const unreachable = makeClient({ post: async () => { throw new Error('network unavailable'); } });
    await assert.rejects(unreachable.introspect('opaque'), /network unavailable/);
    const malformed = makeClient({ post: async () => ({ data: { active: true } }) });
    await assert.rejects(malformed.introspect('opaque'), /Invalid PCM introspection response/);
});

test('test-environment maximum credential authorizes a subject without extending its decision cache', async () => {
    let milliseconds = NOW * 1000, calls = [];
    const client = makeClient({ post: async url => {
        calls.push(url);
        return { data: url.endsWith('/token')
            ? { access_token: 'test-credential', token_type: 'Bearer', expires_in: 86400, scope: 'system/*.crus' }
            : { ...dataSourceResponse(), exp: NOW + 120 } };
    } }, { authMode: 'bearer', millisClock: () => milliseconds, secondsClock: () => Math.floor(milliseconds / 1000) });
    assert.equal((await client.introspect('subject')).active, true);
    milliseconds += 30000;
    assert.equal((await client.introspect('subject')).active, true);
    assert.equal(calls.filter(url => url.endsWith('/token')).length, 1, 'valid caller credential is reused');
    assert.equal(calls.filter(url => url.endsWith('/introspect')).length, 2, 'subject authority still refreshes after 30 seconds');
    milliseconds = (NOW + 86400) * 1000;
    assert.equal(client.credentialCache.get(), null, 'returned credential expiry is absolute');
});

test('malformed credential response reports contract failure before any subject attempt', async () => {
    const observations = [], calls = [];
    const client = makeClient({ post: async url => {
        calls.push(url);
        return { data: { access_token: 'owned-credential', token_type: 'Bearer', expires_in: 86401, scope: 'system/*.crus' } };
    } }, { authMode: 'bearer', observer: value => observations.push(value) });
    await assert.rejects(client.introspect('opaque'), error =>
        error.message === 'Invalid closed introspection bearer token response' && error.reasonCode === 'MALFORMED_PCM_RESPONSE');
    assert.deepEqual(calls, [`${ISSUER}/token`]);
    assert.ok(observations.some(value => value.stage === 'credential' && value.outcome === 'failed' && value.reasonCode === 'MALFORMED_PCM_RESPONSE'));
    assert.equal(observations.some(value => value.stage === 'subject'), false);
    assert.equal(client.credentialCache.get(), null);
});

test('all presets accept configured environment lifetimes and production cannot borrow a test alias or transport', async () => {
    const { ENVIRONMENTS } = require('../../shared/pcm-environment');
    const { PRESETS, presetSimulationDefaults } = require('../../shared/conformance-policy');
    for (const preset of PRESETS) for (const environment of Object.values(ENVIRONMENTS)) {
        for (const lifetime of [1, 17, environment.tokenMaximumSeconds, environment.tokenMaximumSeconds + 1]) {
            const calls = [];
            const client = makeClient({ post: async url => {
                calls.push(url);
                return { data: url.endsWith('/token')
                    ? { access_token: 'credential', token_type: 'Bearer', expires_in: lifetime, scope: 'system/*.crus' }
                    : { ...dataSourceResponse(), iss: environment.base } };
            } }, { authMode: 'bearer', controls: presetSimulationDefaults(preset), expectedIssuer: environment.base,
                tokenEndpoint: `${environment.base}/token`, introspectionEndpoint: `${environment.base}/introspect`,
                acceptedIssuers: [environment.base, ENVIRONMENTS.test.base], tokenRequestEndpoint: `${ENVIRONMENTS.test.base}/token` });
            if (lifetime > environment.tokenMaximumSeconds) {
                await assert.rejects(client.introspect('subject'), /Invalid closed/);
                assert.equal(calls.length, 1, 'malformed credentials never dispatch subject or retry');
            } else assert.equal((await client.introspect('subject')).active, true, `${preset}/${environment.base}/${lifetime}`);
        }
    }
});

test('pairwise audience and HO bindings reject another source decision', async () => {
    const wrongAudience = makeClient({ post: async () => ({ data: dataSourceResponse() }) }, { expectedAudience: 'https://ho-b.example.test/fhir' });
    await assert.rejects(wrongAudience.introspect('opaque'), /audience/);
    const wrongHoResponse = { ...dataSourceResponse(), aud: 'https://ho-b.example.test/fhir' };
    const hoB = makeClient({ post: async () => ({ data: wrongHoResponse }) }, { hoId: 'ho-b', expectedAudience: 'https://ho-b.example.test/fhir' });
    const context = await hoB.introspect('opaque');
    assert.equal(context.hoId, 'ho-b');
});

test('ordinary cache retains its ceiling while fresh same-token operation checks observe revocation', async () => {
    let milliseconds = NOW * 1000;
    let revoked = false;
    let calls = 0;
    const http = { post: async () => {
        calls++;
        return { data: revoked ? { active: false } : { ...dataSourceResponse(), exp: NOW + 120 } };
    } };
    const client = makeClient(http, {
        controls: { tokenAudience: true, tokenExpiry: true },
        secondsClock: () => Math.floor(milliseconds / 1000),
        millisClock: () => milliseconds
    });
    assert.equal((await client.introspect('prior-opaque')).active, true);
    revoked = true;
    assert.deepEqual(await client.introspect('fresh-opaque'), { active: false });
    assert.equal((await client.introspect('prior-opaque')).active, true, 'existing cache contract is not immediate revocation');
    assert.equal(calls, 2);
    assert.deepEqual(await client.introspect('prior-opaque', { fresh: true }), { active: false });
    assert.equal(calls, 3, 'fresh same-token authorization contacts PCM inside the ordinary cache window');
    assert.deepEqual(await client.introspect('prior-opaque'), { active: false });
    milliseconds += 30000;
    assert.deepEqual(await client.introspect('prior-opaque'), { active: false });
    assert.equal(calls, 5, 'inactive decisions are never cached');
});

test('fresh introspection independently evaluates authority while an older ordinary request is in flight', async () => {
    let releaseOrdinary;
    let calls = 0;
    const client = makeClient({ post: async () => {
        calls++;
        if (calls === 1) return new Promise(resolve => { releaseOrdinary = resolve; });
        return { data: { active: false } };
    } });
    const ordinary = client.introspect('same-token');
    assert.equal(calls, 1);
    assert.deepEqual(await client.introspect('same-token', { fresh: true }), { active: false });
    assert.equal(calls, 2, 'fresh request must not join the earlier request');
    releaseOrdinary({ data: dataSourceResponse() });
    assert.deepEqual(await ordinary, { active: false }, 'an older active response cannot outlive an actual refreshed inactive decision');
    assert.deepEqual(await client.introspect('same-token', { fresh: true }), { active: false });
    assert.equal(calls, 3, 'even a subsequently published ordinary result cannot authorize a fresh request');
});

test('fresh positive, inactive, malformed and unreachable results never fall back to or populate ordinary cache', async () => {
    let calls = 0;
    let behavior = 'active';
    const client = makeClient({ post: async () => {
        calls++;
        if (behavior === 'unreachable') throw new Error('network unavailable');
        return { data: behavior === 'active' ? dataSourceResponse() : behavior === 'inactive' ? { active: false } : { active: true } };
    } });
    assert.equal((await client.introspect('token')).active, true);
    assert.equal((await client.introspect('token')).active, true);
    assert.equal(calls, 1, 'ordinary positive decisions still cache');
    for (const behaviorValue of ['active', 'inactive', 'malformed', 'unreachable']) {
        behavior = behaviorValue;
        if (behavior === 'active') assert.equal((await client.introspect('token', { fresh: true })).active, true);
        else if (behavior === 'inactive') assert.deepEqual(await client.introspect('token', { fresh: true }), { active: false });
        else await assert.rejects(client.introspect('token', { fresh: true }), /network unavailable|Invalid PCM/);
        assert.equal(client.cache.get('token', client.binding), null);
    }
    assert.equal(calls, 5);
    behavior = 'active';
    assert.equal((await client.introspect('token')).active, true);
    assert.equal((await client.introspect('token')).active, true);
    assert.equal(calls, 6, 'ordinary caching recovers after fresh errors');
});

test('fixture enrollment removal partitions even a shared positive cache without a runtime revision', async () => {
    const { ActiveIntrospectionCache } = require('../src/authorization-cache');
    const { presenceResponse } = require('../test-support/introspection-fixture');
    const identity = { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' };
    const raw = presenceResponse([identity]);
    raw.scope = 'patient/Patient.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics';
    raw.authorization_details[0].purposeOfUse[0].code = 'patient-authentication';
    raw.authorization_details[0].fhirContext[0].identifier.value = 'PCM-POLICY-PATIENT-AUTHENTICATION-001';
    let calls = 0;
    const http = { post: async () => { calls++; return { data: raw }; } };
    const cache = new ActiveIntrospectionCache({ clock: () => NOW * 1000 });
    const enrolled = makeClient(http, { cache, syntheticWorkflowFixtures: [identity] });
    assert.equal((await enrolled.introspect('same-opaque')).kind, 'patient-authentication');
    await enrolled.introspect('same-opaque'); assert.equal(calls, 1, 'positive is actually cached');
    const removed = makeClient(http, { cache, syntheticWorkflowFixtures: [] });
    await assert.rejects(removed.introspect('same-opaque'), /Invalid PCM/);
    assert.equal(calls, 2, 'removed fixture cannot reuse previously normalized authority');
    const sandbox = makeClient(http, { cache, syntheticWorkflowFixtures: [identity], allowSandboxGuid: true });
    assert.notEqual(sandbox.binding.normalizationStamp, enrolled.binding.normalizationStamp);
});
