'use strict';
/** Cancellation ownership, optimistic concurrency, audit atomicity and fresh-token denial. */
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
installTestRuntime();
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), jwt = require('jsonwebtoken');
const { fixture } = require('../../../test-support/demo-sources');
const { NOW } = require('../../../test-support/data-grants');
const { businessStatusExtension, expireConsent, reconcileConsentsForService } = require('../src/fhir/consent-lifecycle');
const { EXTENSIONS, SCOPES } = require('../../shared/pcm-contract');
const { consentStatus } = require('../../shared/consent-status');
const { applyCancellation, cancellationView, csrf, handler, authorizeProvider } = require('../src/consent-cancellation');
const { resolveGrant } = require('../src/data-grant');
const { evaluateSubjectToken } = require('../src/introspection-service');
const statuses = { requested: 'proposed', active: 'active', rejected: 'rejected', 'temporarily-inactive': 'inactive', 'permanently-inactive': 'inactive', 'service-provider-cancelled': 'inactive' };
/** Make a detached lifecycle snapshot preserving all policy identity fields. */
function state(f, code) {
    const consent = f.store.get('Consent', f.consent.id);
    consent.status = statuses[code];
    consent.extension = consent.extension.map(item => item.url === EXTENSIONS.consentBusinessStatus ? businessStatusExtension(code) : item);
    return f.store.update(consent);
}
/** Apply a command with server-derived operator/provider and deterministic event time. */
function cancel(f, overrides = {}) {
    return applyCancellation({ store: f.store, consentId: f.consent.id, expectedVersion: f.store.get('Consent', f.consent.id).meta.versionId,
        provider: { organizationId: f.client.organizationId, clientId: f.client.clientId }, operator: 'unit-operator', audit: event => f.events.push(event), clock: () => new Date(NOW * 1000), ...overrides });
}
test('all business statuses explain restoration; absent/unknown causes and initiators are explicit', () => {
    const f = fixture();
    for (const code of Object.keys(statuses)) {
        const consent = state(f, code), view = consentStatus(consent, NOW * 1000);
        assert.equal(view.code, code); assert.equal(view.fhirStatus, statuses[code]);
        assert.match(view.changedAt, /Unrecorded/); assert.equal(view.initiator, 'Unknown / unrecorded');
        if (code === 'permanently-inactive') { assert.equal(view.cause, 'Cause unknown / unrecorded'); assert.doesNotMatch(view.restoration, /revocation|expiry/); }
    }
    const unknown = f.store.get('Consent', f.consent.id); unknown.extension = [];
    assert.equal(consentStatus(unknown).label, 'Unknown / unrecorded');
});
test('expiry and service suspension/cancellation show only actual lifecycle evidence', () => {
    const f = fixture(), consent = f.store.get('Consent', f.consent.id);
    const afterExpiry = new Date(Date.parse(consent.provision.period.end) + 1);
    const expired = expireConsent({ store: f.store, consent, now: afterExpiry });
    assert.match(consentStatus(expired, NOW * 1000, f.store.privateRecords.lifecycle.getEvents('Consent', expired.id)).cause, /recorded PCM expiry/);
    for (const serviceState of ['suspended', 'cancelled']) {
        const f = fixture();
        const [changed] = reconcileConsentsForService({ store: f.store, serviceId: f.service.id, serviceState, now: new Date(NOW * 1000) });
        assert.equal(consentStatus(changed, NOW * 1000, f.store.privateRecords.lifecycle.getEvents('Consent', changed.id)).cause, serviceState === 'suspended' ? 'Service suspension' : 'Service cancellation');
    }
});
test('requested/active cancellation preserves identity, period, sources and first-use history; retry is idempotent', () => {
    for (const code of ['requested', 'active']) {
        const f = fixture(), before = state(f, code);
        f.windows.set('retained-first-use', { expiresAt: NOW - 1 }); const windows = [...f.windows];
        const result = cancel(f);
        assert.equal(result.status, 'inactive'); assert.equal(consentStatus(result).code, 'service-provider-cancelled');
        for (const field of ['id', 'identifier', 'patient', 'provision', 'category', 'policy', 'dateTime']) assert.deepEqual(result[field], before[field], field);
        assert.deepEqual([...f.windows], windows); assert.equal(f.events.length, 1);
        assert.equal(consentStatus(result, NOW * 1000, f.store.privateRecords.lifecycle.getEvents('Consent', result.id)).initiator, `unit-operator acting as ${f.client.organizationId}`);
        assert.deepEqual(cancel(f), result); assert.equal(f.events.length, 1);
    }
});
test('wrong/unavailable provider, terminal states and stale version deny; diagnostic failure preserves cancellation', () => {
    for (const code of ['rejected', 'temporarily-inactive', 'permanently-inactive']) {
        const f = fixture(), before = state(f, code);
        assert.throws(() => cancel(f), error => error.status === 409); assert.deepEqual(f.store.get('Consent', before.id), before);
        assert.equal(cancellationView({ ...f, consent: before }).canCancel, false);
    }
    const f = fixture(), before = f.store.get('Consent', f.consent.id);
    assert.throws(() => cancel(f, { provider: { organizationId: f.config.organizations.hospitalBServiceProvider.id, clientId: 'other' } }), error => error.status === 403);
    assert.throws(() => cancel(f, { expectedVersion: '999' }), error => error.status === 409);
    const committed = cancel(f, { audit() { throw Error('audit unavailable'); } });
    assert.equal(committed.status, 'inactive');
    assert.match(f.store.lastDiagnosticError.message, /audit unavailable/);
    assert.equal(f.store.privateRecords.lifecycle.getEvents('Consent', before.id).at(-1).newState, 'service-provider-cancelled');
    const provider = f.store.get('Organization', f.client.organizationId); f.store.update({ ...provider, active: false });
    assert.throws(() => cancel(f), error => error.status === 403); assert.deepEqual(f.store.get('Consent', before.id), committed);
});
test('every preset denies new grants and fresh introspection after provider cancellation, including relaxed controls', () => {
    const { ExpiringTokenCache } = require('../../sp-client/src/oauth');
    for (const preset of ['strict', 'connectathon-mtls', 'connectathon-balanced', 'connectathon-easy']) {
        const f = fixture(); const effective = buildTeamConfig({}, preset);
        f.config = { ...f.config, conformance: effective.conformance, security: effective.security, securitySimulation: effective.securitySimulation, legacyDataSource: effective.legacyDataSource };
        const grant = resolveGrant({ ...f.request, config: f.config });
        const source = f.config.healthOrganizations[0];
        const ds = { clientId: source.clientId, organizationId: source.dataSourceOrganization.id, role: 'data-source' };
        const token = { kind: 'data_source_access', sub: f.client.clientId, client_id: f.client.clientId, aud: source.endpoint, iat: NOW, exp: NOW + 1000,
            scope: grant.scope, authorization: grant, authorization_details: grant.authorization_details,
            pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true } };
        const introspect = () => evaluateSubjectToken({ token, caller: ds, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now: NOW,
            findClient: id => id === f.client.clientId ? f.client : id === ds.clientId ? ds : null,
            controls: { consentState: false, tokenResourceBinding: false, tokenAudience: false, serviceState: false } });
        assert.ok(introspect(), preset);
        let clock = NOW * 1000; const cache = new ExpiringTokenCache({ clock: () => clock, skewMs: 0 });
        cache.put('source', { access_token: 'opaque', token_type: 'Bearer', scope: grant.scope, expires_in: 86400 });
        cancel(f); assert.equal(introspect(), null, preset);
        assert.throws(() => resolveGrant({ ...f.request, config: f.config, controls: { consentState: false, tokenResourceBinding: false, serviceState: false } }), /cancelled/);
        clock += 29999; assert.equal(cache.get('source'), 'opaque'); clock++; assert.equal(cache.get('source'), null);
    }
});
/** Model only request/response transport; lifecycle and private command are real. */
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } }; }
test('closed same-origin CSRF command authenticates the owning provider; unavailable auth and concurrent mutation deny', async () => {
    const f = fixture(), role = 'serviceProvider', current = f.store.get('Consent', f.consent.id);
    const body = { providerRole: role, expectedVersion: current.meta.versionId, csrf: csrf(current.id, current.meta.versionId, role) };
    const req = data => ({ body: data, params: { id: current.id }, protocol: 'http', get: name => ({ host: 'localhost:4100' })[name] });
    let calls = 0;
    const handle = handler({ store: f.store, getConfig: () => f.config, audit: event => f.events.push(event), authorize: async () => { calls++; return { organizationId: f.client.organizationId, clientId: f.client.clientId }; } });
    for (const data of [{ ...body, csrf: 'bad' }, { ...body, providerRole: 'hospitalBServiceProvider', csrf: csrf(current.id, current.meta.versionId, 'hospitalBServiceProvider') }, { ...body, operator: 'forged' }]) {
        const res = response(); await handle(req(data), res); assert.ok([400, 403].includes(res.statusCode)); assert.deepEqual(f.store.get('Consent', current.id), current);
    }
    assert.equal(calls, 0);
    const foreign = req(body); foreign.get = name => ({ host: 'localhost:4100', origin: 'https://foreign.test' })[name];
    const res = response(); await handle(foreign, res); assert.equal(res.statusCode, 403);
    const denied = handler({ store: f.store, getConfig: () => f.config, authorize: async () => { throw Object.assign(Error('Provider unavailable'), { status: 403 }); } });
    const authError = response(); await denied(req(body), authError); assert.equal(authError.statusCode, 403); assert.deepEqual(f.store.get('Consent', current.id), current);
    const race = handler({ store: f.store, getConfig: () => f.config, audit() {}, authorize: async () => { f.store.update(current); return { organizationId: f.client.organizationId, clientId: f.client.clientId }; } });
    const conflict = response(); await race(req(body), conflict); assert.equal(conflict.statusCode, 409); assert.equal(f.store.get('Consent', current.id).status, 'active');
    const success = response(); const fresh = f.store.get('Consent', current.id); await handle(req({ ...body, expectedVersion: fresh.meta.versionId, csrf: csrf(current.id, fresh.meta.versionId, role) }), success);
    assert.equal(success.statusCode, 200); assert.equal(success.body.status.code, 'service-provider-cancelled'); assert.equal(success.body.access_token, undefined);
});
test('provider authorization uses clean signed OAuth management request and validates actual retained issuance binding', async () => {
    const config = buildTeamConfig(), dir = process.env.CERTS_DIR;
    config.runtime.certsDir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const certs = require('../../../test-support/certificates').certificates();
    const role = config.certificateRoles.serviceProvider;
    for (const name of new Set([config.certificates.rootCaCert, role.assertion.key, role.mtls.key, role.mtls.cert])) fs.copyFileSync(path.join(certs, name), path.join(dir, name));
    const publicKey = new crypto.X509Certificate(fs.readFileSync(path.join(dir, role.mtls.cert))).publicKey;
    const provider = config.organizations.serviceProvider;
    const issued = { kind: 'management', exp: NOW + 30, client_id: provider.clientId, organization_id: provider.id, aud: config.contract.operational.fhirBase, scope: SCOPES.management };
    const options = { config, providerRole: 'serviceProvider', tokenStore: { get: value => value === 'opaque-test' ? issued : null }, clock: () => NOW * 1000,
        transport: async (url, request) => {
            assert.equal(url, `${config.internalBaseUrls.pcmAuth}/token`);
            const form = new URLSearchParams(request.body); assert.equal(form.get('scope'), SCOPES.management); assert.equal(form.has('authorization_details'), false);
            const claims = jwt.verify(form.get('client_assertion'), publicKey, { algorithms: ['ES256'], clockTimestamp: NOW });
            assert.deepEqual(claims.cnf, require('../../shared/assertion-keys').certificateConfirmation(request.tls.cert));
            assert.equal(claims.iss, provider.clientId); assert.equal(claims.aud, `${config.contract.operational.oauthBase}/token`);
            assert.deepEqual(Object.keys(claims).sort(), ['aud', 'cnf', 'exp', 'iat', 'iss', 'jti', 'sub']);
            return { access_token: 'opaque-test', token_type: 'Bearer' };
        } };
    assert.deepEqual(await authorizeProvider(options), { organizationId: provider.id, clientId: provider.clientId });
    issued.organization_id = 'wrong-provider'; await assert.rejects(authorizeProvider(options), /unavailable/);
});

test('actual private route requires Admin authentication and does not accept provider tokens from browser commands', async t => {
    const express = require('express'), app = express();
    const prior = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'cancel-test-only';
    t.after(() => { if (prior === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = prior; });
    app.use(require('../src/routes/ui'));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}/admin/consents/unknown/cancel`;
    const send = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify({ expectedVersion: '1', providerRole: 'serviceProvider', csrf: 'bad' }) });
    assert.equal((await send({})).status, 401);
    assert.equal((await send({ 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD })).status, 403);
});
