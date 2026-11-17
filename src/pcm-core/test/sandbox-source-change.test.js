'use strict';
/** Atomic source simulation and retained token authority, using complete lifecycle-created Consents. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { dataGrantFixture, NOW, rar } = require('../../../test-support/data-grants');
const { createConsent, approveConsent, sourceIds, cancelConsent } = require('../src/fhir/consent-lifecycle');
const changes = require('../src/fhir/sandbox-source-change');
const { resolveGrant } = require('../src/data-grant');
const { evaluateSubjectToken } = require('../src/introspection-service');
const { firstUseKey } = require('../src/clinical-first-use');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { fixture } = require('../../../test-support/demo-sources');
/** Drop only fields the simulation is explicitly authorized to modify. */
function invariant(consent) {
    const copy = structuredClone(consent);
    copy.provision.actor = copy.provision.actor.filter(actor => !actor.role.coding.some(code => code.code === 'CST'));
    delete copy.meta.versionId; delete copy.meta.lastUpdated;
    return copy;
}
test('A → A+B → B → empty preserves all non-source policy, reloads exact state, and audits each mutation', () => {
    const f = fixture(), before = invariant(f.consent);
    for (const ids of [[...f.ids.slice(0, 2)], [f.ids[1]], []]) {
        const result = f.change(ids), loaded = f.store.get('Consent', f.consent.id);
        assert.equal(result.state, 'applied'); assert.deepEqual(sourceIds(loaded), ids); assert.deepEqual(invariant(loaded), before);
        assert.equal(changes.sourceChangeView({ ...f, consent: loaded, now: NOW }).choices.filter(item => item.selected).length, ids.length);
        assert.equal(result.audit.version, loaded.meta.versionId);
    }
    assert.equal(f.events.length, 3); assert.deepEqual(f.events[2].after, []);
    const unchanged = f.store.get('Consent', f.consent.id);
    assert.equal(f.change([]).state, 'unchanged'); assert.deepEqual(f.store.get('Consent', f.consent.id), unchanged);
});
test('complete validation is atomic, conflicts do not overwrite, and unavailable current sources remain removable', () => {
    const f = fixture(), original = f.store.get('Consent', f.consent.id);
    for (const ids of [[f.ids[0], f.ids[0]], ['missing'], [f.client.organizationId], [7]]) {
        assert.throws(() => f.change(ids)); assert.deepEqual(f.store.get('Consent', f.consent.id), original);
    }
    f.change(f.ids.slice(0, 2));
    assert.throws(() => f.change([], original.meta.versionId), error => error.status === 409);
    f.store.update({ ...f.store.get('Organization', f.ids[1]), active: false });
    assert.equal(f.change([f.ids[1]]).state, 'applied'); // existing unavailable source can be retained
    f.change([]);
    assert.throws(() => f.change([f.ids[1]]), /unavailable/);
});
test('strict, terminal and expired states cannot change; diagnostic failure preserves authoritative commit', () => {
    for (const state of ['strict', 'cancelled', 'expired']) {
        const f = fixture();
        if (state === 'strict') f.config.conformance = { mode: 'strict', preset: 'strict' };
        if (state === 'cancelled') { const request = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/FHIR-examples/Parameters-parameters-consent-hosp-a-lifecycle.json'))).parameter.find(item => item.name === 'deactivationRequest').resource; cancelConsent({ store: f.store, consent: f.consent, request, callerOrganization: f.store.get('Organization', f.client.organizationId) }); }
        if (state === 'expired') f.now = Date.parse(f.consent.provision.period.end) / 1000 + 1;
        const before = f.store.get('Consent', f.consent.id); assert.throws(() => f.change([])); assert.deepEqual(f.store.get('Consent', f.consent.id), before);
    }
    const f = fixture(), before = f.store.get('Consent', f.consent.id);
    changes.simulateSourceChange({ store: f.store, config: f.config, consentId: f.consent.id, expectedVersion: before.meta.versionId,
        sourceOrganizationIds: [], actor: 'operator', sessionId: 'session', audit: () => { throw Error('audit failed'); }, clock: () => new Date(NOW * 1000) });
    assert.deepEqual(sourceIds(f.store.get('Consent', f.consent.id)), []);
    assert.equal(f.store.privateRecords.lifecycle.getEvents('Consent', f.consent.id).at(-1).previousVersion, before.meta.versionId);
    assert.match(f.store.lastDiagnosticError.message, /audit failed/);
});
/** Issue the real immutable grant projection and introspect it with a selected registered source. */
function token(f, index, now = NOW) {
    const grant = resolveGrant({ ...f.request, now, resource: f.config.healthOrganizations[index].endpoint });
    assert.equal(grant.error, undefined);
    return { kind: 'data_source_access', sub: f.client.clientId, client_id: f.client.clientId, aud: f.config.healthOrganizations[index].endpoint,
        iat: now, exp: now + 10000, scope: grant.scope, authorization: grant, authorization_details: grant.authorization_details,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true } };
}
function introspect(f, subject, index, now = NOW) {
    const source = f.config.healthOrganizations[index];
    const dsClient = { clientId: source.dataSourceOrganization.clientId, organizationId: f.ids[index], role: 'data-source' };
    return evaluateSubjectToken({ token: subject, caller: dsClient, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now,
        findClient: id => id === f.client.clientId ? f.client : id === dsClient.clientId ? dsClient : null,
        controls: { tokenResourceBinding: false, tokenAudience: false, consentState: false } });
}
test('addition needs a fresh exact-audience token; removal and empty reject issuance and fresh introspection even with relaxed checks', () => {
    const f = fixture(), a = token(f, 0);
    f.change(f.ids.slice(0, 2));
    assert.equal(introspect(f, a, 0).exp, NOW + 30); assert.equal(introspect(f, a, 1), null);
    const b = token(f, 1); assert.ok(introspect(f, b, 1));
    f.change([f.ids[1]]); assert.equal(introspect(f, a, 0), null); assert.ok(introspect(f, b, 1));
    f.change([]); assert.equal(introspect(f, b, 1), null);
    for (const source of f.config.healthOrganizations) assert.throws(() => resolveGrant({ ...f.request, resource: source.endpoint, controls: { tokenResourceBinding: false } }));
});
test('an already-empty active Consent denies relaxed grants without changing version or adding audit on no-op Apply', () => {
    const f = fixture(), issued = token(f, 0);
    const empty = f.store.get('Consent', f.consent.id);
    empty.provision.actor = empty.provision.actor.filter(actor => !actor.role.coding.some(code => code.code === 'CST'));
    f.store.update(empty);
    const before = f.store.get('Consent', f.consent.id);
    assert.equal(changes.hasSourceSimulation(before), false);
    assert.equal(f.change([]).state, 'unchanged');
    assert.deepEqual(f.store.get('Consent', f.consent.id), before);
    assert.equal(introspect(f, issued, 0), null);
    for (const source of f.config.healthOrganizations) assert.throws(() => resolveGrant({ ...f.request,
        resource: source.endpoint, controls: { consentState: false, tokenResourceBinding: false, serviceState: false } }));
});

test('one-time remove/re-add retains expired A window; unused B starts only on its first qualifying introspection', () => {
    const f = fixture('one-time'); f.change(f.ids.slice(0, 2));
    const aKey = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.ids[0]);
    const bKey = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.ids[1]);
    const a = token(f, 0); assert.equal(f.windows.size, 0); assert.ok(introspect(f, a, 0));
    const started = structuredClone(f.windows.get(aKey));
    assert.deepEqual(started, { ok: true, startedAt: NOW, expiresAt: NOW + 3600 });
    assert.equal(f.windows.has(bKey), false);
    f.now = NOW + 3601;
    f.change([f.ids[1]]); f.change(f.ids.slice(0, 2));
    assert.deepEqual(f.windows.get(aKey), started);
    assert.equal(f.windows.size, 1, 'source edits do not start unused B or reset expired A');
    assert.equal(introspect(f, a, 0, NOW + 3601), null);
    assert.throws(() => resolveGrant({ ...f.request, now: NOW + 3601 }));
    assert.deepEqual(f.windows.get(aKey), started);
    const b = token(f, 1, NOW + 3601); assert.equal(f.windows.has(bKey), false);
    assert.ok(introspect(f, b, 1, NOW + 3601));
    assert.deepEqual(f.windows.get(bKey), { ok: true, startedAt: NOW + 3601, expiresAt: NOW + 7201 });
    assert.deepEqual(f.windows.get(aKey), started); assert.equal(f.windows.size, 2);
});

test('automatic approval provenance, approved scopes and unavailable endpoints survive exact source simulation', () => {
    const f = fixture('continuous', true);
    f.consent.meta.tag = [{ system: 'urn:operator:source-note', code: 'prior-note', display: 'Preserve independent metadata' }, { system: 'urn:operator:note', code: 'retained' }];
    const exactApprovedScope = require('../src/data-sources').getApprovedTokenScope(f.consent, f.store);
    f.store.update(f.consent);
    f.change([f.ids[0]]); const before = invariant(f.store.get('Consent', f.consent.id));
    f.store.update({ ...f.store.get('Endpoint', f.config.healthOrganizations[0].endpointId), status: 'off' });
    const view = changes.sourceChangeView({ ...f, consent: f.store.get('Consent', f.consent.id), now: NOW });
    assert.equal(view.choices.find(item => item.id === f.ids[0]).state, 'unavailable');
    f.change([]); const empty = f.store.get('Consent', f.consent.id);
    assert.deepEqual(invariant(empty), before);
    assert.equal(require('../../shared/consent-presentation').isTestAutoApproved(empty), true);
    assert.equal(require('../src/data-sources').getApprovedTokenScope(empty, f.store), exactApprovedScope);
    assert.throws(() => f.change([f.ids[0]]), /unavailable/);
});
test('every inactive/terminal business state and a suspended service remain uneditable', () => {
    const { businessStatusExtension } = require('../src/fhir/consent-lifecycle');
    const statuses = { requested: 'proposed', rejected: 'rejected', 'temporarily-inactive': 'inactive', 'permanently-inactive': 'inactive', 'service-provider-cancelled': 'inactive' };
    for (const [state, status] of Object.entries(statuses)) {
        const f = fixture();
        if (['requested', 'rejected'].includes(state)) f.consent = f.createPending();
        const consent = f.store.get('Consent', f.consent.id);
        consent.status = status; consent.extension = consent.extension.map(item => item.url === EXTENSIONS.consentBusinessStatus ? businessStatusExtension(state) : item);
        if (['requested', 'rejected'].includes(state)) { delete consent.provision.period; consent.provision.actor = consent.provision.actor.filter(item => item.role.coding[0].code !== 'CST'); }
        f.store.update(consent); const before = f.store.get('Consent', consent.id);
        assert.throws(() => f.change([])); assert.deepEqual(f.store.get('Consent', consent.id), before);
    }
    const f = fixture(); f.store.update({ ...f.service, active: false });
    assert.equal(changes.sourceChangeView({ ...f, now: NOW }).canEdit, false); assert.throws(() => f.change([]));
});

test('a previously positive Doctor cache expires at the same 30-second boundary as introspection', () => {
    const { ExpiringTokenCache } = require('../../sp-client/src/oauth');
    const f = fixture(); f.change(f.ids.slice(0, 2)); const issued = token(f, 0);
    const active = introspect(f, issued, 0); assert.equal(active.exp, NOW + 30);
    let clock = NOW * 1000;
    const cache = new ExpiringTokenCache({ clock: () => clock, skewMs: 0 });
    cache.put('source-A', { access_token: 'opaque-A', token_type: 'Bearer', scope: issued.scope, expires_in: 86400 });
    f.change([f.ids[1]]); assert.equal(introspect(f, issued, 0), null);
    clock += 29999; assert.equal(cache.get('source-A'), 'opaque-A'); clock++;
    assert.equal(cache.get('source-A'), null);
});
