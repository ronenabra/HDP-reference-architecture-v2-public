'use strict';
/** Explicit broad approvals replace implicit preset/flag permissions and preserve lifecycle boundaries. */
const test = require('node:test'), assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
const { dataGrantFixture, rar } = require('../../../test-support/data-grants');
const { fullClinicalScope, FULL_SERVICE_TAG } = require('../../shared/sandbox-grant-policy');
const { resolveGrant, grantStillAllowed } = require('../src/data-grant');
const { buildEffectivePolicy } = require('../../shared/conformance-policy');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');
const broad = fullClinicalScope().split(' ').map(token => `${token}?${V}`).join(' ');

/** Switch a disposable candidate through the ordinary current config contracts. */
function preset(f, name) {
    const selected = buildTeamConfig({}, name);
    for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) f.config[key] = selected[key];
}

test('every preset fixes clinical permission checks and rejects either retired flag value', () => {
    for (const name of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        const config = buildTeamConfig({}, name), policy = buildEffectivePolicy(config, {});
        assert.equal(policy.grantPolicy.grantFullClinicalAccess, false); assert.equal(policy.grantPolicy.locked, true);
        assert.equal(policy.grantPolicy.cacheMaximumSeconds, 30);
        for (const value of [true, false, 'true']) assert.throws(() => assertValidTeamConfig({ ...config, sandbox: { grantFullClinicalAccess: value } }, { env: {} }), /retired/);
    }
});

test('deliberate broad approval retains exact text while broader ceilings cannot add permission', () => {
    const f = clinicalTokenFixture({ scope: broad });
    for (const name of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        preset(f, name); assert.equal(resolveGrant(f.request).scope, broad);
        for (const scope of ['patient/Binary.rs', 'patient/Medication.rs', 'patient/Observation.rs']) assert.equal(resolveGrant({ ...f.request, scope }).scope, broad);
        for (const denied of ['patient/Observation.c', 'system/Patient.rs', 'patient/*.rs', 'patient/Observation.rs?code=x']) assert.throws(() => resolveGrant({ ...f.request, scope: denied }));
    }
    const restricted = dataGrantFixture();
    assert.equal(resolveGrant({ ...restricted.request, scope: fullClinicalScope() }).scope, resolveGrant(restricted.request).scope);
});

test('template edits and old full-access tag cannot rewrite saved authority; dependency revisions revoke older tokens', () => {
    const f = clinicalTokenFixture({ scope: broad }), original = resolveGrant(f.request), frozen = structuredClone(original);
    const service = f.store.get('HealthcareService', f.service.id);
    assert.throws(() => f.store.update({ ...service, meta: { ...service.meta, tag: [...service.meta.tag, { system: FULL_SERVICE_TAG, code: 'true' }] } }), /Private PCM metadata/);
    assert.equal(resolveGrant(f.request).scope, broad); assert.deepEqual(original, frozen);
    const canonical = f.store.get('HealthcareService', f.config.service.catalogId || 'service-catalog-1');
    f.store.update({ ...canonical, name: 'New live label' });
    assert.equal(resolveGrant(f.request).scope, broad);
    assert.equal(grantStillAllowed(original, resolveGrant(f.request)), false);
});

test('Strict permits the exact selected broad grant and still denies missing authority despite obsolete options', () => {
    const f = clinicalTokenFixture({ scope: broad }); preset(f, 'strict');
    assert.equal(resolveGrant({ ...f.request, controls: { consentState: false, serviceState: false } }).scope, broad);
    f.store.update({ ...f.consent, status: 'inactive' });
    assert.throws(() => resolveGrant({ ...f.request, controls: { consentState: false, serviceState: false } }), /unavailable/);
});

test('general migration and preset selection preserve current environment/lifetime and do not restore bypass flags', () => {
    const { migrate } = require('../../../pcm-connectathon/scripts/migrate-team-config');
    const { planReconfiguration } = require('../../../pcm-connectathon/scripts/reconfigure-local-team');
    for (const environment of ['production', 'test']) {
        const current = buildTeamConfig({ contract: { environment } }), migrated = migrate(current);
        for (const name of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
            const plan = planReconfiguration(migrated, 'TEAM_ADMIN_PASSWORD=fixture\n', name);
            assert.equal(Object.hasOwn(plan.config.sandbox, 'grantFullClinicalAccess'), false);
            assert.equal(plan.config.contract.environment, environment);
            assert.equal(plan.config.security.pcmApi.accessTokenExpiresInSeconds, current.security.pcmApi.accessTokenExpiresInSeconds);
        }
        assert.throws(() => migrate({ ...current, configVersion: 'pcm-team-config/4' }), /Coordinated scope migration/);
    }
});

test('fresh introspection preserves broad authority and caps expiry, then denies source/cancellation loss', () => {
    const { evaluateSubjectToken } = require('../src/introspection-service');
    const { NOW } = require('../../../test-support/data-grants');
    const f = clinicalTokenFixture({ scope: broad }), grant = resolveGrant(f.request);
    const caller = { clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id };
    const token = { kind: 'data_source_access', client_id: f.client.clientId, sub: f.client.clientId, iat: NOW, exp: NOW + 86400,
        aud: f.source.endpoint, iss: f.config.contract.operational.fhirBase, scope: grant.scope, authorization: grant,
        authorization_details: grant.authorization_details,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true } };
    const evaluate = (target = caller) => evaluateSubjectToken({ token, caller: target, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now: NOW,
        findClient: id => id === f.client.clientId ? f.client : { ...target, role: 'data-source' } });
    assert.equal(evaluate().scope, broad); assert.equal(evaluate().exp, NOW + 30);
    const other = f.config.healthOrganizations[1];
    assert.equal(evaluate({ clientId: other.clientId, organizationId: other.dataSourceOrganization.id }), null);
    f.store.update({ ...f.consent, status: 'inactive' }); assert.equal(evaluate(), null); assert.equal(token.scope, broad);
});

test('explicit clinical breadth leaves distinct Contract ceilings and patient entitlement unchanged', () => {
    const f = dataGrantFixture();
    const input = { ...f.request, client: { clientId: f.config.oauthClients.presenceOrchestrator.clientId },
        requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [f.patient]), scope: 'system/Patient.s' };
    assert.match(resolveGrant(input).scope, /system\/Patient.s\?identifier=.*\|1&_security=.*patientDemographics/);
    assert.throws(() => resolveGrant({ ...input, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [{ ...f.patient, value: '2' }]) }), /unavailable/);
    assert.throws(() => resolveGrant({ ...input, scope: 'patient/Condition.rs' }));
});
