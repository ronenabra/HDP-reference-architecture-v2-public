'use strict';

/** Regressions for caller-relative authority and current-Endpoint source budgets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { grantHarness, patients, requested } = require('../../../test-support/pcm-042-grants');
const { NOW } = require('../../../test-support/data-grants');
const { replaceEndpoint } = require('../src/fhir/participant-lifecycle');
const { sourceLimits, sourceControls, registeredSourceId } = require('../src/source-policy');
const { presenceLimits } = require('../../shared/presence-limits');
const { buildEffectivePolicy } = require('../../shared/conformance-policy');
const { resolveGrant } = require('../src/data-grant');
const { parseAuthorizationDetails } = require('../src/rar-request');
const { newDataSourceConfig, syncDataSourcesToStore } = require('../src/data-sources');

/** Reclaim every disposable real-store harness even if a regression fails. */
function fixture(t, preset, options) { const f = grantHarness(preset, options); t.after(f.close); return f; }

/** Publish a supported fixture lifecycle/source replacement using the actual current optimistic version. */
function publish(f, value) {
    const current = f.store.get(value.resourceType, value.id);
    return f.store.update({ ...value, meta: { ...value.meta, versionId: current?.meta?.versionId } });
}

/** Apply the supported suspend/change-address/reactivate lifecycle without changing configuration. */
function moveEndpoint(f, source) {
    const owner = f.store.get('Organization', source.dataSourceOrganization.id);
    let endpoint = f.store.get('Endpoint', source.endpointId);
    const request = { status: 'suspended', address: endpoint.address, connectionType: endpoint.connectionType, payloadType: endpoint.payloadType };
    endpoint = replaceEndpoint({ store: f.store, callerOrganization: owner, existing: endpoint, request });
    return replaceEndpoint({ store: f.store, callerOrganization: owner, existing: endpoint,
        request: { ...request, status: 'active', address: endpoint.address + '/moved' } });
}

for (const preset of ['strict', 'connectathon-balanced', 'connectathon-easy']) {
    for (const [audience, binding] of [[true, true], [false, true], [true, false], [false, false]]) {
        test(`${preset}: caller audience=${audience}/binding=${binding} cannot poison another source's Consent token`, t => {
            const f = fixture(t, preset), other = f.config.healthOrganizations[1];
            if (preset !== 'strict') {
                f.config.securitySimulation.perSource[other.id] = { tokenAudience: audience, tokenResourceBinding: binding };
                assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
                delete f.config.securitySimulation.perSource[other.id];
            }
            const issued = f.issue(); assert.equal(issued.status, 200);
            const token = issued.body.access_token;
            assert.equal(f.inspect(token).body.active, true, 'initial complete-actor authority must actually be active');
            const relaxed = false;
            assert.equal(f.inspect(token, other.clientId).body.active, relaxed, 'only the paired disabled checks permit this cross-source request');
            assert.equal(f.tokenStore.get(token).revoked, undefined);
            assert.equal(f.inspect(token).body.active, true);

            // A second independently authorized token proves A's loss does not revoke B's authority.
            const otherConsent = f.newDecision({ sources: [other.dataSourceOrganization.id] });
            const otherIssued = f.service({ body: { ...f.body, resource: other.endpoint,
                authorization_details: requested('Consent', otherConsent.identifier[0].value) } });
            assert.equal(otherIssued.status, 200);
            assert.equal(f.inspect(otherIssued.body.access_token, other.clientId).body.active, true);
            const original = f.store.get('Consent', f.consent.id);
            publish(f, { ...original, status: 'inactive' });
            if (relaxed) assert.deepEqual(f.inspect(token, other.clientId).body, { active: false });
            else assert.deepEqual(f.inspect(token).body, { active: false });
            assert.equal(f.tokenStore.get(token).revoked, true, 'genuine original authority loss remains terminal');
            publish(f, original);
            assert.deepEqual(f.inspect(token).body, { active: false });
            assert.equal(f.inspect(otherIssued.body.access_token, other.clientId).body.active, true);
            assert.equal(f.inspect(f.issue().body.access_token).body.active, true, 'fresh issuance can use restored authority');
        });
    }
}

test('a relaxed caller-specific first-use denial does not revoke the original source token', t => {
    const f = fixture(t, 'connectathon-balanced'), other = f.config.healthOrganizations[1];
    f.config.securitySimulation.perSource[other.id] = { tokenAudience: false, tokenResourceBinding: false };
    assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
    delete f.config.securitySimulation.perSource[other.id];
    const consent = f.newDecision({ mode: 'one-time' });
    f.body.authorization_details = requested('Consent', consent.identifier[0].value);
    const token = f.issue().body.access_token;
    assert.equal(f.inspect(token).body.active, true);
    f.windows.set(`${consent.id}\u0000${other.dataSourceOrganization.id}`, { ok: true, expiresAt: NOW - 1 });
    assert.deepEqual(f.inspect(token, other.clientId).body, { active: false });
    assert.equal(f.tokenStore.get(token).revoked, undefined);
    assert.equal(f.inspect(token).body.active, true);
});

test('exact-source simulation provenance still forbids paired disabled controls without revoking legitimate authority', t => {
    const f = fixture(t, 'connectathon-balanced'), other = f.config.healthOrganizations[1];
    f.config.securitySimulation.perSource[other.id] = { tokenAudience: false, tokenResourceBinding: false };
    assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
    delete f.config.securitySimulation.perSource[other.id];
    const consent = f.store.get('Consent', f.consent.id);
    assert.throws(() => publish(f, { ...consent, meta: { ...consent.meta, tag: [{ system: 'urn:pcm:sandbox:source-change', code: 'source-set-v1' }] } }), /Private PCM metadata/);
    require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config, consentId: consent.id, expectedVersion: consent.meta.versionId, sourceOrganizationIds: [], actor: 'test-operator', sessionId: 'test-session', audit() {}, clock: () => new Date(require('../../../test-support/data-grants').NOW * 1000) });
    const current = f.store.get('Consent', consent.id);
    require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config, consentId: consent.id, expectedVersion: current.meta.versionId, sourceOrganizationIds: [f.source.dataSourceOrganization.id], actor: 'test-operator', sessionId: 'test-session', audit() {}, clock: () => new Date(require('../../../test-support/data-grants').NOW * 1000) });
    const token = f.issue().body.access_token;
    assert.equal(f.inspect(token).body.active, true);
    assert.deepEqual(f.inspect(token, other.clientId).body, { active: false });
    assert.equal(f.tokenStore.get(token).revoked, undefined);
    assert.equal(f.inspect(token).body.active, true);
});

/** Register a custom source in the real FHIR graph and existing presence Contract. */
function budgetSource(f, kind) {
    if (kind === 'managed') return f.source;
    const custom = newDataSourceConfig('Moved budgets', 'https://custom.example.invalid/fhir', { pcmClientAuthCertThumbprint: 'A'.repeat(43) });
    f.config.organizations.dataSources ||= []; f.config.organizations.dataSources.push(custom);
    syncDataSourcesToStore(f.store, f.config, 'A'.repeat(43));
    const contract = f.store.get('Contract', 'policy-presence');
    contract.term[0].asset.push({ context: [{ reference: { reference: `Organization/${custom.id}` } }] }); publish(f, contract);
    f.clients.push({ clientId: custom.clientId, organizationId: custom.id, role: 'data-source', scopes: ['introspection'] });
    return { ...custom, dataSourceOrganization: { id: custom.id } };
}

/** Supply the parser's real UTF-8 encoded and decoded byte metadata. */
function formBytes(body) {
    return { encoded: Buffer.byteLength(new URLSearchParams(body).toString()),
        decoded: Object.entries(body).reduce((total, [name, value], index) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 1 + (index ? 1 : 0), 0) };
}

for (const kind of ['managed', 'custom']) {
    test(`${kind}: current moved Endpoint preserves exact/one-over patient budgets, larger overrides, isolation and compiler enforcement`, t => {
        const f = fixture(t), source = budgetSource(f, kind), other = f.config.healthOrganizations[1];
        const endpoint = moveEndpoint(f, source);
        f.config.presence.sources = { [source.id]: { maxPatients: 2 }, [other.id]: { maxPatients: 3 } };
        f.config.systemAuthorization.presenceEligiblePatients = patients(106);
        const bodyFor = (count, resource = endpoint.address) => ({ ...f.body, resource, scope: 'system/Patient.s',
            authorization_details: requested('Contract', 'PCM-POLICY-PRESENCE-001', patients(count)) });
        const issue = count => f.service({ clientId: f.config.oauthClients.presenceOrchestrator.clientId, body: bodyFor(count) });
        assert.equal(registeredSourceId(f.store, f.config, { resource: endpoint.address }), source.id);
        assert.equal(sourceLimits(f.store, f.config, { resource: endpoint.address }).maxPatients, 2);
        const exact = issue(2); assert.equal(exact.status, 200); assert.equal(f.inspect(exact.body.access_token, source.clientId).body.active, true);
        let before = f.counters(); assert.equal(issue(3).body.error, 'invalid_authorization_details'); assert.deepEqual(f.counters(), before);
        assert.throws(() => resolveGrant({ ...f.request, client: f.findClient(f.config.oauthClients.presenceOrchestrator.clientId),
            requested: parseAuthorizationDetails(bodyFor(3).authorization_details), scope: 'system/Patient.s', resource: endpoint.address }), /Authorization basis/);
        assert.equal(f.service({ clientId: f.config.oauthClients.presenceOrchestrator.clientId, body: bodyFor(3, other.endpoint) }).status, 200);
        assert.equal(f.service({ clientId: f.config.oauthClients.presenceOrchestrator.clientId, body: bodyFor(2, source.endpoint) }).body.error, 'invalid_target');
        f.config.presence.sources[source.id] = { maxPatients: 105, maxRarBytes: 262144, maxFormBytes: 524288, maxEncodedFormBytes: 1572864 };
        const larger = issue(105); assert.equal(larger.status, 200); assert.equal(f.inspect(larger.body.access_token, source.clientId).body.active, true);
        before = f.counters(); assert.equal(issue(106).body.error, 'invalid_authorization_details'); assert.deepEqual(f.counters(), before);
        assert.equal(sourceLimits(f.store, f.config, { clientId: other.clientId }).maxPatients, 3);
    });

    for (const field of ['maxRarBytes', 'maxFormBytes', 'maxEncodedFormBytes', 'maxResponseBytes']) {
        test(`${kind}: moved Endpoint applies ${field} at exact/one-over UTF-8 boundaries before replay/persistence`, t => {
            const f = fixture(t), source = budgetSource(f, kind), other = f.config.healthOrganizations[1];
            const endpoint = moveEndpoint(f, source);
            f.config.systemAuthorization.presenceEligiblePatients = patients(2);
            const body = { ...f.body, client_assertion: f.body.client_assertion + 'é', resource: endpoint.address, scope: 'system/Patient.s',
                authorization_details: requested('Contract', 'PCM-POLICY-PRESENCE-001', patients(2)) + ' \n' };
            const req = { clientId: f.config.oauthClients.presenceOrchestrator.clientId, body, oauthFormBytes: formBytes(body) };
            const baseline = f.service(req); assert.equal(baseline.status, 200);
            const exact = field === 'maxRarBytes' ? Buffer.byteLength(body.authorization_details)
                : field === 'maxFormBytes' ? req.oauthFormBytes.decoded : field === 'maxEncodedFormBytes' ? req.oauthFormBytes.encoded
                    : Buffer.byteLength(JSON.stringify(baseline.body));
            f.config.presence.sources = { [source.id]: { [field]: exact }, [other.id]: { [field]: exact + 1 } };
            assert.equal(sourceLimits(f.store, f.config, { resource: endpoint.address })[field], exact);
            assert.equal(f.service(req).status, 200, 'exact source boundary succeeds');
            const otherBody = { ...body, resource: other.endpoint };
            assert.equal(f.service({ ...req, body: otherBody, oauthFormBytes: formBytes(otherBody) }).status, 200, 'other source retains its independent byte budget');
            const before = f.counters(), records = f.tokenStore.size;
            f.config.presence.sources[source.id][field]--;
            const denied = f.service(req);
            assert.equal(denied.body.error, field === 'maxResponseBytes' ? 'invalid_authorization_details' : 'invalid_request');
            assert.equal(f.counters().replays, before.replays);
            if (field !== 'maxResponseBytes') assert.equal(f.counters().authentications, before.authentications);
            assert.equal(f.tokenStore.size, records);
            assert.equal(sourceLimits(f.store, f.config, { clientId: other.clientId })[field], exact + 1);
            f.config.presence.sources[source.id][field] = 1;
            assert.notEqual(f.service(req).status, 200, 'original low-budget counterexample is denied');
        });
    }
}

for (const kind of ['managed', 'custom']) {
    test(`${kind}: moved Endpoint introspection retains exact form/encoded/response budgets and nonrevoking denial`, t => {
        const f = fixture(t), source = budgetSource(f, kind);
        const endpoint = moveEndpoint(f, source);
        const issued = f.service({ clientId: f.config.oauthClients.presenceOrchestrator.clientId,
            body: { ...f.body, resource: endpoint.address, scope: 'system/Patient.s',
                authorization_details: requested('Contract', 'PCM-POLICY-PRESENCE-001', [f.patient]) } });
        assert.equal(issued.status, 200);
        const token = issued.body.access_token;
        const body = { token, client_assertion_type: f.body.client_assertion_type, client_assertion: f.body.client_assertion };
        const bytes = formBytes(body), active = f.inspect(token, source.clientId).body;
        assert.equal(active.active, true);
        for (const [field, exact] of [['maxFormBytes', bytes.decoded], ['maxEncodedFormBytes', bytes.encoded],
            ['maxResponseBytes', Buffer.byteLength(JSON.stringify(active))]]) {
            f.config.presence.sources = { [source.id]: { [field]: exact } };
            assert.equal(f.inspect(token, source.clientId, { oauthFormBytes: bytes }).body.active, true, `${field} exact boundary`);
            const before = f.introspectionReplays();
            f.config.presence.sources[source.id][field]--;
            const denied = f.inspect(token, source.clientId, { oauthFormBytes: bytes });
            if (field === 'maxResponseBytes') assert.deepEqual(denied.body, { active: false });
            else {
                assert.equal(denied.body.error, 'invalid_request');
                assert.equal(f.introspectionReplays(), before, 'form denial precedes replay');
            }
            assert.equal(f.tokenStore.get(token).revoked, undefined);
        }
        delete f.config.presence.sources;
        assert.equal(f.inspect(token, source.clientId).body.active, true);
    });
}

test('current Endpoint source resolution preserves per-source simulations without rewriting configuration', t => {
    const f = fixture(t, 'connectathon-balanced');
    const endpoint = moveEndpoint(f, f.source);
    f.config.securitySimulation.perSource[f.source.id] = { clientAssertionReplay: false };
    const consent = f.store.get('Consent', f.consent.id); publish(f, { ...consent, status: 'inactive' });
    const controls = sourceControls(f.store, buildEffectivePolicy(f.config), f.config, { resource: endpoint.address });
    assert.equal(controls.clientAssertionReplay, false);
    assert.equal(controls.consentState, true);
    const result = f.service({ body: { ...f.body, resource: endpoint.address } });
    assert.equal(result.status, 400); assert.equal(result.body.error, 'invalid_authorization_details');
    assert.equal(f.source.endpoint.includes('/moved'), false, 'static config remains untouched');
    assert.equal(presenceLimits(f.config, { id: f.source.id }).maxPatients, sourceLimits(f.store, f.config, { resource: endpoint.address }).maxPatients);
});
