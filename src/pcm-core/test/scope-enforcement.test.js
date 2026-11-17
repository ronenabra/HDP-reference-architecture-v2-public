'use strict';

/** Preset-independent permission and configuration boundaries for ENFORCE-04. */
const test = require('node:test'), assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { PRESETS, REQUIRED_AUTHORIZATION_CONTROLS, SIMULATION_CONTROLS, buildEffectivePolicy, simulationPolicyStamp } = require('../../shared/conformance-policy');
const { assertValidTeamConfig, CONFIG_VERSION } = require('../../shared/team-config-validator');
const { planReconfiguration } = require('../../../pcm-connectathon/scripts/reconfigure-local-team');
const { migrate } = require('../../../pcm-connectathon/scripts/migrate-team-config');
const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
const { resolveGrant } = require('../src/data-grant');

for (const preset of PRESETS) {
    test(`${preset}: defaults and every transport/authentication combination preserve mandatory authorization`, () => {
        const config = buildTeamConfig({}, preset);
        assert.equal(assertValidTeamConfig(config, { env: {} }), config);
        for (let mask = 0; mask < (1 << SIMULATION_CONTROLS.length); mask++) {
            if (preset === 'strict' && mask !== (1 << SIMULATION_CONTROLS.length) - 1) continue;
            const candidate = structuredClone(config);
            candidate.securitySimulation.global = Object.fromEntries(SIMULATION_CONTROLS.map((key, i) => [key, Boolean(mask & (1 << i))]));
            const policy = buildEffectivePolicy(candidate, {});
            assert.ok(REQUIRED_AUTHORIZATION_CONTROLS.every(key => policy.simulation.controls[key] === true));
            assert.equal(policy.authorizationCeiling.patientIsolation, 'required');
            assert.equal(policy.grantPolicy.grantFullClinicalAccess, false);
        }
    });
    test(`${preset}: all retired global/source controls and full-access values reject without mutation`, () => {
        for (const key of REQUIRED_AUTHORIZATION_CONTROLS) for (const value of [true, false]) for (const source of [null, 'ho-a']) {
            const config = buildTeamConfig({}, preset), before = JSON.stringify(config);
            const forged = structuredClone(config);
            if (source) forged.securitySimulation.perSource[source] = { [key]: value };
            else forged.securitySimulation.global[key] = value;
            assert.throws(() => assertValidTeamConfig(forged, { env: {} }), /not allowed|unknown|invalid per-source/);
            assert.equal(JSON.stringify(config), before);
        }
        for (const value of [true, false, 'true', null]) {
            const config = buildTeamConfig({ sandbox: { grantFullClinicalAccess: value } }, preset);
            assert.throws(() => assertValidTeamConfig(config, { env: {} }), /retired/);
            assert.throws(() => buildEffectivePolicy(config, {}), /retired/);
        }
        assert.throws(() => assertValidTeamConfig(buildTeamConfig({ security: { dsFhirServer: { enforceMappedPatients: false } } }, preset), { env: {} }), /enforceMappedPatients/);
    });
}

test('preset restoration preserves exact grant bytes, data authority and selected environment', () => {
    const f = clinicalTokenFixture();
    const original = JSON.stringify(f.consent), scope = resolveGrant(f.request).scope;
    for (const preset of PRESETS) {
        const plan = planReconfiguration(f.config, 'TEAM_ADMIN_PASSWORD=owned-fixture\n', preset);
        assert.equal(plan.config.configVersion, CONFIG_VERSION);
        assert.deepEqual(plan.config.contract, f.config.contract);
        assert.equal(plan.config.security.pcmApi.accessTokenExpiresInSeconds, f.config.security.pcmApi.accessTokenExpiresInSeconds);
        assert.equal(resolveGrant({ ...f.request, config: plan.config }).scope, scope);
        assert.equal(JSON.stringify(f.store.get('Consent', f.consent.id)), original);
    }
});

test('legacy config cannot be restored/reconfigured or auto-migrated into a permissive grant', () => {
    const legacy = buildTeamConfig(); legacy.configVersion = 'pcm-team-config/4'; legacy.conformance.policyVersion = 'pcm-sandbox-policy/3';
    const before = JSON.stringify(legacy);
    assert.throws(() => assertValidTeamConfig(legacy, { env: {} }), /coordinated scope migration/);
    assert.throws(() => planReconfiguration(legacy, '', 'connectathon-easy'), /coordinated scope migration/);
    assert.throws(() => migrate(legacy), /Coordinated scope migration/);
    assert.equal(JSON.stringify(legacy), before);
    const current = buildTeamConfig(); assert.deepEqual(migrate(current), current);
});

test('explicit broad scope succeeds in Strict while attempted direct authority switches cannot broaden it', () => {
    const exact = `patient/Patient.rs?${V} patient/Observation.rs?${V}`;
    const f = clinicalTokenFixture({ scope: exact });
    const strict = planReconfiguration(f.config, 'TEAM_ADMIN_PASSWORD=owned\n', 'strict').config;
    assert.equal(resolveGrant({ ...f.request, config: strict }).scope, exact);
    const disabled = Object.fromEntries(REQUIRED_AUTHORIZATION_CONTROLS.map(key => [key, false]));
    const wrongSource = f.config.healthOrganizations[2];
    f.store.update({ ...f.store.get('Consent', f.consent.id), provision: { ...f.consent.provision, actor: f.consent.provision.actor.filter(actor => actor.reference?.reference !== `Organization/${wrongSource.dataSourceOrganization.id}`) } });
    assert.throws(() => resolveGrant({ ...f.request, controls: disabled, resource: wrongSource.endpoint }), /not authorized/);
    assert.throws(() => resolveGrant({ ...f.request, controls: disabled, now: f.request.now + 400000000 }), /unavailable/);
    assert.throws(() => resolveGrant({ ...f.request, controls: disabled, resource: f.config.legacyDataSource.internalFhirBaseUrl }), /Legacy Node source does not support clinical scope enforcement/);
});

test('policy version stamp and retired mapper fence old cached or bypass contexts', () => {
    const controls = buildEffectivePolicy(buildTeamConfig(), {}).simulation.controls;
    const stamp = simulationPolicyStamp(controls, 'ho-a', 0);
    const old = require('node:crypto').createHash('sha256').update(`ho-a:0:${Object.values(controls).map(Boolean).map(Number).join('')}`).digest('hex');
    assert.notEqual(stamp, old);
    assert.throws(() => require('../../../src/ds-auth-adapter/src/mapper').mapUnfilteredSimulation(), /retired/);
});

test('current authority and expiry cannot be bypassed by internal obsolete controls in any preset', () => {
    const { evaluateSubjectToken } = require('../src/introspection-service');
    const disabled = Object.fromEntries(REQUIRED_AUTHORIZATION_CONTROLS.map(key => [key, false]));
    for (const preset of PRESETS) {
        const f = clinicalTokenFixture();
        const config = planReconfiguration(f.config, 'TEAM_ADMIN_PASSWORD=owned\n', preset).config;
        const grant = resolveGrant({ ...f.request, config });
        const token = { kind: 'data_source_access', client_id: f.client.clientId, sub: f.client.clientId,
            iat: f.request.now, exp: f.request.now + 86400, aud: f.source.endpoint, scope: grant.scope,
            authorization: grant, authorization_details: grant.authorization_details,
            pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': f.client.mtlsThumbprint },
                client_assertion_signing: { 'x5t#S256': f.client.assertionThumbprint }, correlation_verified: true } };
        const evaluate = (record = token, source = f.source) => evaluateSubjectToken({ token: record, config,
            store: f.store, firstUseStore: f.firstUseStore, now: f.request.now, controls: disabled,
            getSourceControls: () => disabled,
            caller: { clientId: source.clientId, organizationId: source.dataSourceOrganization.id },
            findClient: id => id === f.client.clientId ? f.client : { clientId: source.clientId, organizationId: source.dataSourceOrganization.id, role: 'data-source' } });
        assert.equal(evaluate().scope, grant.scope);
        assert.equal(evaluate({ ...token, exp: f.request.now }), null);
        assert.equal(evaluate(token, config.healthOrganizations[1]), null);
        assert.equal(evaluate({ ...token, aud: config.healthOrganizations[1].endpoint }), null);
        require('../src/fhir/consent-lifecycle').cancelConsent({ store: f.store,
            consent: f.store.get('Consent', f.consent.id), callerOrganization: f.store.get('Organization', f.client.organizationId),
            request: require('../../sp-client/src/fhir-builders').buildConsentDeactivate(f.consent.id) });
        assert.equal(evaluate(), null);
        assert.throws(() => resolveGrant({ ...f.request, config, controls: disabled }), /cancelled|unavailable/);
    }
});

test('missing and unsupported exact approvals deny under every preset without inferring authority', () => {
    const { rar } = require('../../../test-support/data-grants');
    for (const preset of PRESETS) {
        const f = clinicalTokenFixture();
        const config = planReconfiguration(f.config, 'TEAM_ADMIN_PASSWORD=owned\n', preset).config;
        const unusable = f.approve(undefined, `patient/Patient.rs?${V} patient/DocumentReference.rs?${V}`);
        for (const consent of [f.store.get('Consent', 'consent-test'), unusable]) {
            assert.throws(() => resolveGrant({ ...f.request, config,
                requested: rar('Consent', consent.identifier[0].value) }), /missing or unusable/);
        }
    }
});

test('actual fresh-team CLI writes only transport/assertion defaults in all four presets', t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-fresh-teams-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const preset of PRESETS) {
        const teamId = `enforce-${preset}`;
        const result = spawnSync(process.execPath, ['pcm-connectathon/scripts/create-team.js', '--team-id', teamId,
            '--teams-root', directory, '--preset', preset], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8',
            env: { ...process.env, TEAM_ADMIN_PASSWORD: 'owned-enforce-test-only' } });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const bytes = fs.readFileSync(path.join(directory, teamId, 'team-config.json'));
        const config = JSON.parse(bytes), policy = buildEffectivePolicy(config, {});
        assert.equal(config.configVersion, CONFIG_VERSION);
        assert.deepEqual(Object.keys(config.securitySimulation.global).sort(), [...SIMULATION_CONTROLS].sort());
        assert.deepEqual(config.securitySimulation.perSource, {});
        assert.equal(Object.hasOwn(config.sandbox, 'grantFullClinicalAccess'), false);
        assert.ok(REQUIRED_AUTHORIZATION_CONTROLS.every(key => policy.simulation.controls[key] === true));
        t.diagnostic(JSON.stringify({ preset, generatedConfigSha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }));
    }
});


test('ENFORCE browser approval/source/client/expiry eligibility stays invariant in every actual preset', () => {
    const { createConsent, approveConsent, rejectConsent } = require('../src/fhir/consent-lifecycle');
    const { rar } = require('../../../test-support/data-grants');
    const { evaluateSubjectToken } = require('../src/introspection-service');
    const scope = require('../../../config/demo-services.json').clinicalServices.find(service => service.key === 'lab-follow-up').serviceGrant.scope;
    for (const preset of PRESETS) {
        const f = clinicalTokenFixture({ scope, mode: 'one-time' });
        const config = planReconfiguration(f.config, 'TEAM_ADMIN_PASSWORD=owned\n', preset).config;
        const policy = buildEffectivePolicy(config, {}), controls = policy.simulation.controls;
        const request = structuredClone(require('../../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        request.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
        request.extension.find(row => row.url.endsWith('/ext-pcm-service')).valueReference.reference = `HealthcareService/${f.service.id}`;
        const ordinary = createConsent({ store: f.store, config, callerOrganization: f.store.get('Organization', f.client.organizationId), request, clock: f.clock });
        const approved = approveConsent({ store: f.store, consent: ordinary, scopeChoice: 'custom', customScope: scope,
            approvedAccessMode: 'one-time', sourceOrganizationIds: [f.source.dataSourceOrganization.id], clock: f.clock });
        const positive = { ...f.request, config, controls, requested: rar('Consent', approved.identifier[0].value) };
        const grant = resolveGrant(positive);
        assert.equal(grant.scope, scope);
        const savedBytes = JSON.stringify(f.store.get('Consent', approved.id));
        request.patient.identifier.value = '000000026';
        const pending = createConsent({ store: f.store, config, callerOrganization: f.store.get('Organization', f.client.organizationId), request, clock: f.clock });
        const requested = rar('Consent', pending.identifier[0].value);
        assert.equal(pending.status, 'proposed');
        assert.throws(() => resolveGrant({ ...f.request, config, controls, requested }), error => error.code === 'invalid_authorization_details');
        const rejected = rejectConsent({ store: f.store, consent: pending });
        assert.equal(rejected.status, 'rejected');
        assert.throws(() => resolveGrant({ ...f.request, config, controls, requested }), error => error.code === 'invalid_authorization_details');
        assert.throws(() => resolveGrant({ ...positive, client: { ...f.client, clientId: config.organizations.hospitalBServiceProvider.clientId, organizationId: config.organizations.hospitalBServiceProvider.id } }), error => error.code === 'invalid_authorization_details');
        assert.throws(() => resolveGrant({ ...positive, resource: config.healthOrganizations[1].endpoint }), error => error.code === 'invalid_target');
        const token = { kind: 'data_source_access', client_id: f.client.clientId, sub: f.client.clientId,
            iat: f.request.now, exp: f.request.now + 300, aud: f.source.endpoint, scope: grant.scope,
            authorization: grant, authorization_details: grant.authorization_details,
            pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': f.client.mtlsThumbprint },
                client_assertion_signing: { 'x5t#S256': f.client.assertionThumbprint }, correlation_verified: true } };
        const evaluate = (record = token, source = f.source) => evaluateSubjectToken({ token: record, config, store: f.store,
            firstUseStore: f.firstUseStore, now: f.request.now, controls, getSourceControls: () => controls,
            caller: { clientId: source.clientId, organizationId: source.dataSourceOrganization.id },
            findClient: id => id === f.client.clientId ? f.client : { clientId: source.clientId, organizationId: source.dataSourceOrganization.id, role: 'data-source' } });
        assert.equal(evaluate().scope, scope);
        const windows = JSON.stringify([...f.windows]);
        assert.equal(f.windows.size, 1, 'only this new approved client/source tuple starts a first-use window');
        assert.equal(evaluate().scope, scope, 'ordinary retries retain the exact approval');
        assert.equal(evaluate(token, config.healthOrganizations[1]), null);
        assert.equal(evaluate({ ...token, exp: f.request.now }), null);
        assert.equal(JSON.stringify([...f.windows]), windows, 'negative decisions preserve the first-use deadline');
        assert.equal(JSON.stringify(f.store.get('Consent', approved.id)), savedBytes, 'eligibility probes cannot modify saved approval');
        assert.equal(config.conformance.preset, preset, 'Easy never switches to balanced for clinical eligibility');
    }
});
