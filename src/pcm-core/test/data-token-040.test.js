'use strict';

/** Issuance/introspection agreement, replay ordering and lifetime boundaries. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { dataGrantFixture, rar, NOW } = require('../../../test-support/data-grants');
const { createTokenService, classifyTokenRequest } = require('../src/token-service');
const { evaluateSubjectToken } = require('../src/introspection-service');
const { INTERNAL_INVOCATION } = require('../src/data-grant');
const { CODE_SYSTEMS, SCOPES } = require('../../shared/pcm-contract');
const assertionFields = { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'test-assertion' };

/** Exercise the real services with isolated authority resources and token capture. */
function harness(options = {}) {
    const fixture = dataGrantFixture(options);
    let calls = 0;
    const records = [];
    const logs = [];
    const service = createTokenService({ fhirStore: fixture.store, firstUseStore: fixture.firstUseStore,
        tokenStore: { issue(kind, claims, lifetime) { records.push({ ...structuredClone(claims), kind, iat: NOW, exp: NOW + lifetime }); return { token: 'opaque', record: records.at(-1) }; } },
        authenticate: req => { calls++; req.mtls = { thumbprint: 'A'.repeat(43) }; return { transportVerified: true, signatureVerified: true, assertionSigningThumbprint: 'B'.repeat(43), client: { ...fixture.client, ...req.client, mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) } }; },
        getConfig: () => fixture.config, getIssuer: () => fixture.config.contract.operational.fhirBase,
        getPolicy: () => ({ compatibility: { enabledAdapters: [] } }), getLifetime: () => 86400,
        clock: () => NOW, logger: { info: (message, details) => logs.push({ message, ...details }), warn: (message, details) => logs.push({ message, ...details }) } });
    const body = { grant_type: 'client_credentials', ...assertionFields, resource: fixture.source.endpoint, scope: fixture.request.scope, authorization_details: JSON.stringify(fixture.request.requested.details) };
    const caller = { clientId: fixture.source.clientId || fixture.source.dataSourceOrganization.clientId, organizationId: fixture.source.dataSourceOrganization.id };
    const evaluate = (token, options = {}) => evaluateSubjectToken({ token, caller, store: fixture.store, firstUseStore: fixture.firstUseStore,
        config: fixture.config, now: NOW, findClient: id => id === caller.clientId
            ? { clientId: caller.clientId, organizationId: caller.organizationId, role: 'data-source' }
            : { ...fixture.client, clientId: id }, ...options });
    return { ...fixture, body, service, records, logs, evaluate, authenticationCalls: () => calls };
}

test('invalid RAR and wrong grant shapes are rejected before authentication', () => {
    const { service, body, authenticationCalls } = harness();
    for (const change of [{ authorization_details: '[]' }, { authorization_details: '[{"type":1,"type":2}]' }, { scope: 'patient/Observation.s?status=final' }, { extra: 'caller-context' }, { resource: ['a', 'b'] }]) {
        assert.equal(service({ body: { ...body, ...change } }).status, 400);
    }
    assert.equal(authenticationCalls(), 0);
    assert.equal(classifyTokenRequest({ ...body, scope: SCOPES.management }).body.error, 'invalid_request');
    const legacy = { ...body }; delete legacy.authorization_details;
    assert.equal(classifyTokenRequest(legacy).ok, false);
});

test('Consent issuance and active introspection expose exactly the same retained RAR and scopes', () => {
    const { service, body, records, evaluate, store, consent } = harness();
    const response = service({ body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.expires_in, 86400);
    assert.deepEqual(Object.keys(response.body).sort(), ['access_token', 'authorization_details', 'expires_in', 'scope', 'token_type']);
    const active = evaluate(records[0]);
    assert.ok(active);
    assert.deepEqual(active.authorization_details, response.body.authorization_details);
    assert.equal(active.scope, response.body.scope);
    assert.equal(active.iat, NOW);
    for (const prohibited of ['patient', 'fhirContext', 'cnf']) assert.equal(Object.hasOwn(active, prohibited), false);
    assert.equal(evaluate({ ...records[0], authorization: {} }), null);
    store.add({ ...consent, status: 'inactive' });
    assert.equal(evaluate(records[0]), null);
});

test('first-use introspection starts one source window once and later issuance is capped', () => {
    const { service, body, records, evaluate, windows } = harness({ mode: 'one-time' });
    assert.equal(service({ body }).status, 200);
    assert.equal(windows.size, 0);
    assert.ok(evaluate(records[0]));
    assert.equal(windows.size, 1);
    assert.ok(evaluate(records[0], { now: NOW + 1 }));
    assert.equal([...windows.values()][0].expiresAt, NOW + 3600);
    assert.equal(service({ body }).body.expires_in, 3600);
    assert.equal(evaluate(records[0], { now: NOW + 3600 }), null);
});

test('system tokens require current private flow evidence, omit organization identity and cap lifetime', () => {
    const { service, body, records, config, strongPatient, source } = harness();
    const client = { clientId: config.oauthClients.authenticationOrchestrator.clientId, role: 'authentication-orchestrator', organizationId: config.organizations.pcm.id };
    const input = { client, body: { ...body, scope: 'patient/Patient.s', authorization_details: JSON.stringify(rar('Contract', 'PCM-POLICY-PATIENT-AUTHENTICATION-001', [strongPatient]).details) } };
    assert.equal(service(input).status, 400);
    input[INTERNAL_INVOCATION] = { id: 'flow', clientId: client.clientId, identifier: strongPatient, homeHmoId: source.dataSourceOrganization.id, phase: 'authenticating', expiresAt: NOW + 7 };
    const response = service(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.expires_in, 7);
    assert.equal(records[0].kind, 'patient_authentication');
    assert.equal(Object.hasOwn(records[0], 'organization_id'), false);
});


test('denied data grants retain the authenticated caller, exact requested basis and stable reason', () => {
    const h = harness();
    h.store.add({ ...h.consent, status: 'inactive' });
    assert.equal(h.service({ body: h.body }).body.error, 'invalid_authorization_details');
    const denied = h.logs.find(log => log.type === 'TOKEN_AUTHORIZATION_DENIED');
    assert.equal(denied.decision, 'denied');
    assert.equal(denied.reason, 'invalid_authorization_details');
    assert.deepEqual(denied.basis, h.request.requested.basis);
    assert.equal(denied.client_id, h.client.clientId);
    assert.equal(denied.audience, h.body.resource);
    assert.equal(denied.requestedScope, h.body.scope);
    assert.equal(h.records.length, 0);
});

test('missing, inactive and inaccessible Consent bases produce the same privacy-safe RAR error', () => {
    const errors = [];
    for (const state of ['missing', 'inactive', 'foreign']) {
        const h = harness();
        if (state === 'missing') h.body.authorization_details = JSON.stringify(rar('Consent', 'UNKNOWN-BUSINESS-ID').details);
        if (state === 'inactive') h.store.add({ ...h.consent, status: 'inactive' });
        const result = h.service({ body: h.body, ...(state === 'foreign' ? { client: { organizationId: h.config.organizations.hospitalBServiceProvider.id } } : {}) });
        assert.equal(result.status, 400, state);
        assert.equal(h.records.length, 0, state);
        errors.push(result.body);
    }
    assert.ok(errors.every(error => error.error === 'invalid_authorization_details'));
    assert.deepEqual(errors[0], errors[1]);
    assert.deepEqual(errors[0], errors[2]);
});
