'use strict';
/** Immutable pending SMART decisions bind private browser identity without extending expiry or approving a launch. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { FileAuthorizationRecordRepository, pkceS256 } = require('../src/authorization-store');
const { createAuthorizeService } = require('../src/authorize-service');
const { BrowserAuthenticatedIdentityProvider } = require('../src/sandbox-identity-provider');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-hmo-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let now = 1000, current = null, audience = 'https://pcm.test/r4';
    const store = new FileAuthorizationRecordRepository(directory, { clock: () => now });
    const browser = id => ({ headers: { cookie: `pcmSystemBrowser=${id.repeat(43)}; pcmSystemFlow=private-flow` } });
    const req = browser('A'), other = browser('B');
    const identity = new BrowserAuthenticatedIdentityProvider([{ idSystem: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', idValue: '1' }], {
        browserFlow(flow, binding) { if (!current || binding !== 'A'.repeat(43)) throw new Error('Not authenticated'); return current; }
    });
    const client = { clientId: 'app', role: 'service-provider', name: 'Test app', authorizationCodeGrant: true, redirectUris: ['https://app.test/callback'], smartScopes: ['patient/*.rs'] };
    const service = createAuthorizeService({ store, identityProvider: identity, findClient: id => id === client.clientId ? client : null, getFhirAudience: () => audience });
    const start = () => service.start({ client_id: client.clientId, redirect_uri: client.redirectUris[0], scope: 'patient/Observation.rs', aud: 'https://pcm.test/r4', state: 'private-state', response_type: 'code', code_challenge: pkceS256('A'.repeat(43)), code_challenge_method: 'S256' }, req);
    const verify = (value = '000000018', syntheticFixture = false) => { current = { identifier: { system: 'national-test-system', value }, syntheticFixture, phase: 'authenticated', selectedPatient: { system: 'national-test-system', value: 'dependent' } }; };
    const decide = (id, request = req, values = {}) => service.decide({ transaction_id: id, decision: 'approve', patient: 'authenticated-self', approved_scope: 'patient/Observation.rs', ...values }, request);
    return { store, service, start, verify, decide, req, other, client, expire: () => { now += 301; }, clear: () => { current = null; }, changeAudience: () => { audience = 'https://different.test/r4'; } };
}
test('OTP return resumes the same request, pins self only and waits for an explicit decision', t => {
    const h = fixture(t), first = h.start(), original = h.store.peekAuthorization(first.transactionId);
    assert.deepEqual(first.patients.map(p => p.subject), ['configured-patient-1']);
    h.verify(); const resumed = h.service.resume(first.transactionId, h.req);
    assert.equal(resumed.transactionId, first.transactionId); assert.equal(resumed.patients.at(-1).subject, 'authenticated-self');
    assert.deepEqual(h.store.peekAuthorization(first.transactionId), original);
    assert.equal(fs.readdirSync(h.store.directory).some(name => name.startsWith('auth-code')), false);
    assert.equal(h.service.resume(first.transactionId, h.req).type, 'interaction');
    assert.equal(h.decide(first.transactionId, h.other).type, 'error'); assert.ok(h.store.peekAuthorization(first.transactionId));
    const decision = h.decide(first.transactionId); assert.equal(decision.type, 'redirect');
    const grant = h.store.read('auth-code', new URL(decision.location).searchParams.get('code'));
    assert.equal(grant.patient.value, '000000018'); assert.notEqual(grant.patient.value, 'dependent');
    assert.equal(h.service.resume(first.transactionId, h.req).type, 'error'); assert.equal(h.decide(first.transactionId).type, 'error');
});
test('forged, wrong-browser, expired and changed client/redirect/scope/audience continuations fail closed', t => {
    for (const mutation of [h => h.client.redirectUris = [], h => h.client.smartScopes = ['patient/Condition.rs'], h => h.client.role = 'data-source', h => h.client.clientId = 'replacement', h => h.expire(), h => h.changeAudience()]) {
        const h = fixture(t), request = h.start(); mutation(h); assert.equal(h.service.resume(request.transactionId, h.req).type, 'error');
    }
    const h = fixture(t), request = h.start();
    assert.equal(h.service.resume('forged', h.req).type, 'error'); assert.equal(h.service.resume(request.transactionId, h.other).type, 'error');
});
test('identity substitution, session expiry, HTEST and dependent choices cannot authorize self', t => {
    const h = fixture(t), first = h.start(); h.verify(); h.service.resume(first.transactionId, h.req);
    h.verify('different'); assert.equal(h.service.resume(first.transactionId, h.req).selfChanged, true);
    assert.equal(new URL(h.decide(first.transactionId).location).searchParams.get('error'), 'access_denied');
    const second = h.start(); h.clear(); assert.equal(new URL(h.decide(second.transactionId).location).searchParams.get('error'), 'access_denied');
    h.verify('fixture', true); assert.equal(h.start().patients.some(p => p.subject === 'authenticated-self'), false);
    const third = h.start(); assert.equal(new URL(h.decide(third.transactionId, h.req, { patient: 'dependent' }).location).searchParams.get('error'), 'access_denied');
});
test('cancel, refresh and concurrent tabs retain independent original deadlines and single-use decisions', t => {
    const h = fixture(t), one = h.start(), two = h.start();
    assert.equal(h.service.resume(one.transactionId, h.req).type, 'interaction');
    const cancel = h.decide(one.transactionId, h.req, { decision: 'cancel' }); assert.equal(new URL(cancel.location).searchParams.get('error'), 'access_denied');
    assert.ok(h.store.peekAuthorization(two.transactionId)); h.verify(); h.service.resume(two.transactionId, h.req);
    assert.ok(new URL(h.decide(two.transactionId).location).searchParams.get('code'));
});
