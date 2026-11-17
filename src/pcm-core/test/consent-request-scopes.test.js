'use strict';

/** Advisory request semantics retain exact private authority and independent denials. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { consentRequestFixture, NOW, EXACT, V, REQUESTS, PRESETS } = require('../../../test-support/consent-request-fixture');
const { rar } = require('../../../test-support/data-grants');
const { createTokenService } = require('../src/token-service');
const { evaluateSubjectToken } = require('../src/introspection-service');
const { resolveGrant } = require('../src/data-grant');
const { buildEffectivePolicy } = require('../../shared/conformance-policy');

/** Inject only authentication and opaque storage; exercise production issuance/reevaluation. */
function harness(options = {}) {
    const f = consentRequestFixture(options), records = [];
    let now = NOW, client = f.client;
    const policy = buildEffectivePolicy(f.config, {});
    const service = createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore,
        tokenStore: { issue(kind, claims, lifetime) {
            const record = structuredClone({ ...claims, kind, iat: now, exp: now + lifetime }); records.push(record);
            return { token: `opaque-${records.length}`, record };
        } }, authenticate: req => {
            req.mtls = { thumbprint: client.mtlsThumbprint };
            return { client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: client.assertionThumbprint };
        }, getIssuer: () => f.config.contract.operational.oauthBase, getConfig: () => f.config, getPolicy: () => policy,
        getLifetime: () => 300, clock: () => now, logger: { warn() {}, info() {} } });
    const issue = (changes = {}) => service({ body: { grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'owned-unit-double',
        resource: f.source.endpoint, scope: REQUESTS.equal,
        authorization_details: JSON.stringify(f.request.requested.details), ...changes } });
    const evaluate = (token = records.at(-1), source = f.source) => evaluateSubjectToken({ token,
        caller: { clientId: source.clientId, organizationId: source.dataSourceOrganization.id },
        store: f.store, config: f.config, firstUseStore: f.firstUseStore, now,
        controls: policy.simulation.controls,
        findClient: id => id === f.client.clientId ? f.client : { role: 'data-source', clientId: source.clientId, organizationId: source.dataSourceOrganization.id } });
    return { ...f, issue, issueRaw: service, evaluate, records, time: value => { now = value; }, useClient: value => { client = value; } };
}

for (const preset of PRESETS) test(`${preset}: four request variants retain exact grant, context, authority, deadlines and first-use bytes`, t => {
    const f = harness({ preset, mode: 'one-time' });
    const compiler = require('../src/grant-compiler'), original = compiler.compileConsentScope;
    compiler.compileConsentScope = () => { throw new Error('Issuance must never compile'); };
    t.after(() => { compiler.compileConsentScope = original; });
    let expected, firstWindow;
    const issued = [];
    const privateBytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(f.consent.id));
    for (const [variant, scope] of Object.entries(REQUESTS)) {
        const response = f.issue({ scope }); assert.equal(response.status, 200, JSON.stringify(response));
        assert.equal(response.body.scope, EXACT, variant); assert.match(response.body.access_token, /^opaque-/);
        const record = f.records.at(-1), grant = structuredClone(record.authorization);
        assert.equal(grant.requestedScope, scope); delete grant.requestedScope;
        const effective = { grant, expiresIn: response.body.expires_in, context: response.body.authorization_details };
        if (!expected) expected = effective;
        assert.deepEqual(effective, expected, variant);
        issued.push({ record, response });
    }
    assert.equal(f.windows.size, 0, 'issuance does not start usage');
    for (const { record, response } of issued) {
        const before = structuredClone(record), active = f.evaluate(record);
        assert.equal(active.scope, EXACT); assert.deepEqual(active.authorization_details, response.body.authorization_details);
        assert.equal(active.iat, NOW); assert.equal(active.exp, NOW + 30);
        assert.deepEqual(record, before, 'reevaluation must not rewrite original receipt/deadline');
        firstWindow ||= JSON.stringify([...f.windows]);
        assert.equal(JSON.stringify([...f.windows]), firstWindow);
        assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(f.consent.id)), privateBytes);
    }
    f.time(NOW + 5); assert.equal(f.evaluate().exp, NOW + 35);
    assert.equal(JSON.stringify([...f.windows]), firstWindow, 'retry retains original start/deadline');
});

test('malformed forms/scopes/RAR fail atomically while syntactically valid unknown requests are advisory', () => {
    const f = harness({ mode: 'one-time' });
    for (const patch of [{ scope: [] }, { scope: '' }, { scope: 'patient/Observation.w' }, { scope: 'patient/Observation.s?status=final' },
        { scope: 'patient/Observation.s patient/Observation.r' }, { scope: 'patient/Observation.s system/Patient.s' },
        { scope: 'system/Patient.rs' }, { authorization_details: '{}' }, { authorization_details: '[{"type":"wrong"}]' },
        { resource: [f.source.endpoint] }, { ignored: 'field' }]) {
        assert.ok(f.issue(patch).status >= 400, JSON.stringify(patch));
    }
    assert.equal(f.records.length, 0); assert.equal(f.windows.size, 0);
    assert.equal(f.issue({ scope: REQUESTS.different }).body.scope, EXACT);
});

test('missing, invalid and unsupported approved authority cannot authorize or survive active reevaluation', () => {
    for (const damage of ['missing', 'invalid', 'unsupported', 'binding']) {
        const f = harness(); assert.equal(f.issue({ scope: REQUESTS.narrower }).status, 200);
        const key = `Consent/${f.consent.id}`;
        if (damage === 'missing') delete f.store.privateState.approvals[key];
        if (damage === 'invalid') f.store.privateState.approvals[key].snapshot.scope = 'forged';
        if (damage === 'unsupported') {
            const bad = f.approve(`patient/DocumentReference.s?${V}`);
            assert.equal(f.issue({ authorization_details: JSON.stringify(rar('Consent', bad.identifier[0].value).details) }).body.error, 'invalid_scope');
            f.store.privateState.approvals[key].snapshot = f.store.privateRecords.approvals.getDecision(bad.id).snapshot;
        }
        if (damage === 'binding') {
            const changed = f.store.get('Consent', f.consent.id); changed.patient.identifier.value = '000000026';
            assert.throws(() => f.store.update(changed), /read-only/);
            // Simulate corrupted persisted input after verifying the normal guard.
            f.store.data.Consent.set(changed.id, changed);
        }
        assert.equal(f.issue().body.error, 'invalid_scope', damage); assert.equal(f.evaluate(), null, damage);
    }
});

test('client, service, source, audience, expiry and revocation remain independent of requested operations', () => {
    for (const damage of ['client', 'service', 'source', 'audience', 'expiry', 'revoked']) {
        const f = harness(); assert.equal(f.issue({ scope: REQUESTS.broader }).status, 200);
        if (damage === 'client') f.useClient({ ...f.client, organizationId: f.config.organizations.hospitalBServiceProvider.id });
        if (damage === 'service') {
            const service = f.store.get('HealthcareService', f.service.id); service.active = false; f.store.update(service);
        }
        if (damage === 'source') {
            const consent = f.store.get('Consent', f.consent.id);
            consent.provision.actor = consent.provision.actor.filter(actor => !actor.role?.coding?.some(item => item.code === 'CST'));
            f.store.update(consent);
        }
        if (damage === 'expiry') f.time(Date.parse(f.consent.provision.period.end) / 1000);
        if (damage === 'revoked') {
            const consent = f.store.get('Consent', f.consent.id); consent.status = 'inactive'; f.store.update(consent);
        }
        const changes = damage === 'audience' ? { resource: f.config.healthOrganizations[1].endpoint } : {};
        assert.ok(f.issue(changes).status >= 400, damage);
        if (damage === 'client') f.client.organizationId = f.config.organizations.hospitalBServiceProvider.id;
        assert.equal(f.evaluate(undefined, damage === 'audience' ? f.config.healthOrganizations[1] : f.source), null, damage);
    }
});

test('an ignored retained request never disables binding or grant-integrity checks', () => {
    const f = harness({ preset: 'connectathon-balanced' }); assert.equal(f.issue().status, 200);
    const record = f.records[0];
    record.authorization.requestedScope = REQUESTS.different;
    assert.equal(f.evaluate(record).scope, EXACT);
    record.authorization_details[0].fhirContext.find(item => item.type === 'Patient').identifier.value = '000000026';
    assert.equal(f.evaluate(record), null);
    assert.throws(() => resolveGrant({ ...f.request, resource: f.config.legacyDataSource.internalFhirBaseUrl }), /Legacy Node/);
});

test('management and custom Contract sampling keep their separate exact scope behavior', () => {
    const f = harness({ preset: 'connectathon-balanced' });
    const { SCOPES } = require('../../shared/pcm-contract');
    const management = f.issue({ scope: SCOPES.management, resource: f.config.contract.operational.oauthBase, authorization_details: undefined });
    assert.equal(management.body.error, 'invalid_request', 'management retains its closed form without RAR');
    const basic = f.issueRaw({ body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'owned-unit-double', scope: SCOPES.management, resource: f.config.contract.operational.oauthBase } });
    assert.equal(basic.status, 200); assert.equal(basic.body.scope, SCOPES.management);
    assert.equal(basic.body.authorization_details, undefined);
    f.config.sandboxSampling = { sourceIds: [f.source.id] };
    f.config.systemAuthorization.clientEntitlements[f.client.clientId] = ['sandbox-patient-sample'];
    const sampling = require('../src/fhir/sampling-policy');
    for (const draft of sampling.samplingResourceDrafts(f.config, NOW)) require('../src/public-fhir').publishNewResource(f.store, draft);
    const contract = f.store.getAll('Contract').find(sampling.isSamplingPolicy);
    const request = { ...f.request, requested: rar('Contract', contract.identifier[0].value), scope: 'system/Patient.s' };
    const grant = resolveGrant(request);
    assert.equal(grant.scope, 'system/Patient.s'); assert.equal(grant.scenario, 'sandbox-patient-sample');
    for (const scope of [REQUESTS.narrower, 'system/Observation.rs', 'system/Patient.rs']) {
        assert.throws(() => resolveGrant({ ...request, scope }), /Sampling permits only Patient search/);
    }
    f.config.conformance.preset = 'strict'; f.config.conformance.mode = 'strict';
    assert.throws(() => resolveGrant(request), /unavailable/);
});
