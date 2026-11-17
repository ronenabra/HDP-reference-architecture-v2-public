'use strict';

/** Candidate workflow grants, irreversible revocation and source-isolated operational budgets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { grantHarness, patients, requested } = require('../../../test-support/pcm-042-grants');
const { NOW, rar } = require('../../../test-support/data-grants');
const { resolveGrant, grantStillAllowed } = require('../src/data-grant');
const { evaluatePolicy } = require('../src/fhir/system-policy');
const { validateDataAuthorizationDetails } = require('../../shared/data-authorization-details');
const { presenceLimits, transportLimits, MAXIMA } = require('../../shared/presence-limits');
const { parseForm, parseAuthorizationDetails } = require('../src/rar-request');
const { FileTokenStore, EXPIRED_TOKEN_RETENTION_SECONDS } = require('../src/token-store');
const { FHIRStore } = require('../src/fhir/store');
const { setApprovedTokenScope } = require('../src/data-sources');
const { buildEffectivePolicy } = require('../../shared/conformance-policy');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');

/** Ensure every real file-backed harness is reclaimed, including failed assertions. */
function fixture(t, preset, options) { const f = grantHarness(preset, options); t.after(f.close); return f; }

/** Publish a supported fixture lifecycle/source replacement using the actual current optimistic version. */
function publish(f, value) {
    const current = f.store.get(value.resourceType, value.id);
    return f.store.update({ ...value, meta: { ...value.meta, versionId: current?.meta?.versionId } });
}

for (const scenario of ['consent-access', 'presence-check', 'patient-authentication', 'dependent-discovery']) {
    test(`0.4.2 ${scenario}: frozen public context and exact effective predicates`, t => {
        const f = fixture(t);
        const response = f.issue(scenario);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const active = f.inspect(response.body.access_token);
        assert.equal(active.body.active, true, JSON.stringify(active.body));
        assert.equal(active.body.scope, response.body.scope);
        assert.deepEqual(active.body.authorization_details, response.body.authorization_details);
        const details = validateDataAuthorizationDetails(active.body.authorization_details);
        assert.equal(details.scenario, scenario);
        assert.equal(Boolean(details.service), scenario === 'consent-access');
        assert.equal(Object.hasOwn(active.body, 'organization_id'), scenario === 'consent-access');
        for (const field of ['patient', 'fhirContext', 'cnf']) assert.equal(Object.hasOwn(active.body, field), false);
        assert.ok(active.body.exp > NOW && active.body.exp <= NOW + 30);
        if (scenario !== 'consent-access') {
            for (const scope of active.body.scope.split(' ')) assert.match(scope, /_security=http:\/\/fhir.health.gov.il\/cs\/il-hdp-information-buckets\|patientDemographics/);
            const invalid = structuredClone(active.body.authorization_details);
            invalid[0].fhirContext.push({ type: 'HealthcareService', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/healthcare-service',
                identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-system-healthcareservice-id', value: 'old-service' } });
            assert.throws(() => validateDataAuthorizationDetails(invalid));
        }
        if (scenario === 'patient-authentication') assert.equal(active.body.scope, 'patient/Patient.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics');
        if (scenario === 'dependent-discovery') {
            assert.match(active.body.scope, /^system\/Patient.s\?_has:RelatedPerson:patient:identifier=/);
            assert.match(active.body.scope, /system\/RelatedPerson.s\?identifier=.*&_tag=http:\/\/fhir.health.gov.il\/cs\/il-hdp-resource-tags\|hmo-dependent-discovery$/);
        }
    });
}

test('Contract source removal/readdition without intermediate introspection cannot resurrect a token; additions retain its ceiling', t => {
    const f = fixture(t);
    const old = f.issue('presence-check').body.access_token;
    const contract = f.store.get('Contract', 'policy-presence');
    const added = structuredClone(contract);
    // A duplicate is deliberately not used as an addition: the existing source graph is already complete.
    const withoutOther = structuredClone(contract);
    withoutOther.term[0].asset = withoutOther.term[0].asset.slice(0, 1);
    publish(f, withoutOther);
    assert.equal(f.inspect(old).body.active, true, 'removing a different target cannot revoke this source');
    publish(f, added);
    assert.equal(f.inspect(old).body.active, true, 'adding other targets never widens this grant');
    const removed = structuredClone(contract); removed.term[0].asset = [];
    publish(f, removed); publish(f, contract);
    assert.deepEqual(f.inspect(old).body, { active: false });
    assert.equal(f.tokenStore.get(old).revoked, true);
    assert.equal(f.inspect(f.issue('presence-check').body.access_token).body.active, true);
});

for (const dependency of ['parent', 'endpoint-status', 'endpoint-address', 'entitlement', 'eligibility', 'contract-period', 'approval']) {
    test(`0.4.2 ${dependency} restoration does not restore issued authority`, t => {
        const f = fixture(t);
        const scenario = dependency === 'approval' ? 'consent-access' : 'presence-check';
        const old = f.issue(scenario).body.access_token;
        let restore;
        if (dependency === 'parent' || dependency.startsWith('endpoint')) {
            const type = dependency === 'parent' ? 'Organization' : 'Endpoint';
            const id = dependency === 'parent' ? f.source.parentOrganization.id : f.source.endpointId;
            const previous = f.store.get(type, id), changed = structuredClone(previous);
            if (dependency === 'parent') changed.active = false;
            else if (dependency === 'endpoint-status') changed.status = 'off';
            else changed.address += '/changed';
            publish(f, changed); restore = () => publish(f, previous);
        } else if (dependency === 'entitlement') {
            const id = f.config.oauthClients.presenceOrchestrator.clientId;
            f.config.systemAuthorization.clientEntitlements[id] = [];
            f.store.authorityState.observeConfig(f.config);
            restore = () => { f.config.systemAuthorization.clientEntitlements[id] = ['presence-check']; };
        } else if (dependency === 'eligibility') {
            f.config.systemAuthorization.presenceEligiblePatients = [];
            f.store.authorityState.observeConfig(f.config);
            restore = () => { f.config.systemAuthorization.presenceEligiblePatients = [f.patient]; };
        } else if (dependency === 'contract-period') {
            const contract = f.store.get('Contract', 'policy-presence');
            publish(f, { ...contract, applies: { ...contract.applies, end: new Date((NOW + 5) * 1000).toISOString() } });
            restore = () => publish(f, contract);
        } else {
            const consent = f.store.get('Consent', f.consent.id), changed = structuredClone(consent);
            assert.throws(() => setApprovedTokenScope(changed, 'patient/Observation.s'), /read-only/);
            publish(f, { ...changed, status: 'inactive' });
            restore = () => publish(f, consent);
        }
        restore();
        assert.deepEqual(f.inspect(old).body, { active: false });
        assert.equal(f.tokenStore.get(old).revoked, true);
        assert.equal(f.inspect(f.issue(scenario).body.access_token).body.active, true);
    });
}

test('wrong caller and audience probing cannot revoke a valid token; revoked markers survive repository reconstruction and are reclaimed', t => {
    const f = fixture(t);
    const token = f.issue('presence-check').body.access_token;
    assert.deepEqual(f.inspect(token, f.config.healthOrganizations[1].clientId).body, { active: false });
    assert.equal(f.tokenStore.get(token).revoked, undefined);
    assert.equal(f.inspect(token).body.active, true);
    f.tokenStore.revoke(token);
    const rebuilt = new FileTokenStore(f.directory, { clock: () => NOW }); t.after(() => rebuilt.close());
    assert.equal(rebuilt.get(token).revoked, true);
    const record = rebuilt.get(token);
    f.setNow(record.exp + EXPIRED_TOKEN_RETENTION_SECONDS - 1);
    assert.equal(f.tokenStore.get(token).revoked, true);
    f.setNow(record.exp + EXPIRED_TOKEN_RETENTION_SECONDS);
    for (let i = 0; i < 4; i++) f.tokenStore.reclaimExpired();
    assert.equal(f.tokenStore.get(token), undefined);
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a fresh authority-store epoch fails closed for a persisted old token', t => {
    const f = fixture(t);
    const token = f.issue('presence-check').body.access_token;
    const old = f.tokenStore.get(token).authorization;
    const rebuilt = new FHIRStore();
    for (const type of ['Organization', 'Endpoint', 'Contract', 'Consent', 'HealthcareService']) for (const resource of f.store.getAll(type)) rebuilt.add(resource);
    const current = resolveGrant({ ...f.request, store: rebuilt, client: f.findClient(f.config.oauthClients.presenceOrchestrator.clientId),
        requested: old.requested, scope: old.requestedScope, resource: f.source.endpoint, now: NOW });
    assert.equal(grantStillAllowed(old, current), false);
});

test('optional/inclusive/fractional Contract deadlines never create zero or rounded-up OAuth lifetimes', t => {
    const f = fixture(t);
    const contract = f.store.get('Contract', 'policy-presence');
    contract.applies.start = new Date((NOW - 1) * 1000).toISOString();
    contract.issued = contract.applies.start;
    const currentPolicy = () => evaluatePolicy({ store: f.store, config: f.config, identifier: contract.identifier[0], clientId: f.config.oauthClients.presenceOrchestrator.clientId,
        targetOrganizationId: f.source.dataSourceOrganization.id, now: NOW });
    for (const [offset, expected] of [[0, 400], [0.999, 400], [1.001, 200]]) {
        publish(f, { ...contract, applies: { ...contract.applies, end: new Date((NOW + offset) * 1000).toISOString() } });
        assert.ok(currentPolicy(), 'Contract applies inclusively at its exact end');
        const response = f.issue('presence-check'); assert.equal(response.status, expected);
        if (expected === 200) { assert.equal(response.body.expires_in, 1); assert.ok(f.tokenStore.get(response.body.access_token).exp <= NOW + offset); }
    }
    const ongoing = structuredClone(contract); delete ongoing.applies.end; publish(f, ongoing);
    for (const [environment, maximum, shorter] of [['production', 30, 7], ['test', 86400, 73]]) {
        f.config.contract.environment = environment;
        for (const lifetime of [maximum, shorter]) {
            f.config.security.pcmApi.accessTokenExpiresInSeconds = lifetime;
            assert.equal(f.issue('presence-check').body.expires_in, lifetime);
        }
    }
});

for (const maximum of [3, 100, 105]) {
    test(`presence permits exactly ${maximum} distinct supported identities and rejects one over before authentication`, t => {
        const f = fixture(t);
        f.config.presence.sources = { 'ho-a': { maxPatients: maximum, maxRarBytes: 262144, maxFormBytes: 524288, maxEncodedFormBytes: 1572864 }, 'ho-b': { maxPatients: 2 } };
        f.config.systemAuthorization.presenceEligiblePatients = patients(maximum + 1);
        const exact = f.issue('presence-check', patients(maximum)); assert.equal(exact.status, 200, JSON.stringify(exact.body));
        assert.equal(f.inspect(exact.body.access_token).body.active, true);
        const counters = f.counters();
        assert.equal(f.issue('presence-check', patients(maximum + 1)).body.error, 'invalid_authorization_details');
        assert.deepEqual(f.counters(), counters);
        assert.equal(f.issue('presence-check', patients(3), f.config.healthOrganizations[1]).body.error, 'invalid_authorization_details');
        assert.equal(presenceLimits(f.config, { id: 'ho-c' }).maxPatients, f.config.presence.batch.maxPatients);
        const duplicate = patients(1); duplicate.push(duplicate[0]);
        assert.equal(f.issue('presence-check', duplicate).body.error, 'invalid_authorization_details');
    });
}

test('UTF-8 RAR/form/encoded/response byte boundaries are source-isolated and do not consume assertion replay', t => {
    const f = fixture(t);
    const body = { ...f.body, authorization_details: f.body.authorization_details + ' ' };
    const rarBytes = Buffer.byteLength(body.authorization_details);
    f.config.presence.sources = { 'ho-a': { maxRarBytes: rarBytes }, 'ho-b': { maxRarBytes: rarBytes - 1 } };
    assert.equal(f.service({ body }).status, 200);
    let before = f.counters();
    assert.equal(f.service({ body: { ...body, authorization_details: body.authorization_details + ' ' } }).body.error, 'invalid_request');
    assert.deepEqual(f.counters(), before);
    const limits = { ...presenceLimits(f.config), maxFormBytes: 5, maxEncodedFormBytes: 11 };
    assert.equal(parseForm('x=%C3%A9a', limits).x, 'éa'); // decoded x=éa is exactly five UTF-8 bytes
    assert.throws(() => parseForm('x=%C3%A9aa', limits), error => error.code === 'invalid_request');
    assert.equal(parseForm('x=%C3%A9%61', limits).x, 'éa');
    assert.throws(() => parseForm('x=%C3%A9%61a', limits), error => error.code === 'invalid_request');
    assert.throws(() => parseForm('x=a&x=b', presenceLimits(f.config)), error => error.code === 'invalid_request');
    assert.throws(() => parseForm('resource=a&res%6furce=b', presenceLimits(f.config)), error => error.code === 'invalid_target');
    assert.throws(() => parseAuthorizationDetails('[{"type":1,"type":2}]'), error => error.code === 'invalid_authorization_details');
    delete f.config.presence.sources;
    const response = f.issue('presence-check');
    const responseBytes = Buffer.byteLength(JSON.stringify(response.body));
    f.config.presence.sources = { 'ho-a': { maxResponseBytes: responseBytes } };
    assert.equal(f.issue('presence-check').status, 200);
    f.config.presence.sources['ho-a'].maxResponseBytes--;
    before = f.counters().replays;
    assert.equal(f.issue('presence-check').body.error, 'invalid_authorization_details');
    assert.equal(f.counters().replays, before);
    assert.equal(transportLimits(f.config).maxResponseBytes >= responseBytes, true);
});

test('all configurable budgets reject nonfinite/unsafe values; accepted config preserves source overrides', t => {
    const f = fixture(t);
    f.config.presence.sources = { 'ho-a': { maxPatients: 105, maxFormBytes: 131072 }, 'ho-b': { maxPatients: 2 } };
    assert.doesNotThrow(() => assertValidTeamConfig(f.config, { env: {} }));
    const typo = structuredClone(f.config); typo.presence.sources['ho-typo'] = { maxPatients: 200 };
    assert.throws(() => presenceLimits(typo), /Unknown presence source/);
    assert.throws(() => assertValidTeamConfig(typo, { env: {} }));
    for (const [key, maximum] of Object.entries(MAXIMA)) for (const value of [Infinity, 0, maximum + 1]) {
        const copy = structuredClone(f.config); copy.presence.sources['ho-a'][key] = value;
        assert.throws(() => presenceLimits(copy, { id: 'ho-a' }));
        assert.throws(() => assertValidTeamConfig(copy, { env: {} }));
    }
});

test('accepted save/reload preserves source budgets and mandatory token expiry with an isolated second source', t => {
    const f = fixture(t, 'connectathon-balanced');
    const previous = process.env.TEAM_CONFIG_PATH;
    process.env.TEAM_CONFIG_PATH = path.join(f.directory, 'team-config.json');
    t.after(() => { if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous; });
    const config = require('../src/team-config');
    // Publication validates irreversible history against the existing selected file.
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(f.config));
    f.config.presence.sources = { 'ho-a': { maxPatients: 105 }, 'ho-b': { maxPatients: 2 } };
    f.config.security.pcmApi.accessTokenExpiresInSeconds = 30;
    f.config.securitySimulation.perSource['ho-a'] = { clientAssertionReplay: false };
    config.saveTeamConfig(config.markRuntimeChange(f.config, '04105-source-budget-proof'));
    Object.assign(f.config, config.reloadTeamConfig());
    assert.equal(presenceLimits(f.config, { id: 'ho-a' }).maxPatients, 105);
    assert.equal(presenceLimits(f.config, { id: 'ho-b' }).maxPatients, 2);
    const sourceA = f.issue('presence-check').body.access_token;
    const sourceB = f.issue('presence-check', [f.patient], f.config.healthOrganizations[1]).body.access_token;
    f.setNow(NOW + 31);
    assert.deepEqual(f.inspect(sourceA).body, { active: false });
    assert.deepEqual(f.inspect(sourceB, f.config.healthOrganizations[1].clientId).body, { active: false });
    f.config.securitySimulation.perSource['ho-a'] = { clientAssertionReplay: true };
    config.saveTeamConfig(config.markRuntimeChange(f.config, '04105-source-expiry-on'));
    Object.assign(f.config, config.reloadTeamConfig());
    assert.deepEqual(f.inspect(sourceA).body, { active: false });
    const strict = structuredClone(f.config); strict.conformance = { ...strict.conformance, mode: 'strict', preset: 'strict' };
    assert.throws(() => config.saveTeamConfig(strict), /strict|Strict/);
});

test('trusted invocation loss revokes permanently, while HMO reclassification cannot revive prior authentication tokens', t => {
    const f = fixture(t);
    let token = f.issue('patient-authentication').body.access_token;
    const invocation = f.tokenStore.get(token).authorization.invocationId;
    assert.ok(invocation);
    f.setInvocation(null);
    assert.deepEqual(f.inspect(token).body, { active: false });
    // New invocation-backed tokens work; the old record's explicit marker remains terminal.
    const replacement = f.issue('patient-authentication').body.access_token;
    assert.equal(f.inspect(replacement).body.active, true);
    assert.deepEqual(f.inspect(token).body, { active: false });
    token = replacement;
    f.config.systemAuthorization.memberships = []; f.config.systemAuthorization.participatingHmos = [];
    f.store.authorityState.observeConfig(f.config);
    assert.equal(f.inspect(token).body.active, true, 'obsolete enrollment lists do not restrict ordinary national-ID tests');
    f.config.healthOrganizations[0].institutionType = 'hospital'; f.store.authorityState.observeConfig(f.config);
    f.config.healthOrganizations[0].institutionType = 'hmo';
    assert.deepEqual(f.inspect(token).body, { active: false });
    assert.equal(f.inspect(f.issue('patient-authentication').body.access_token).body.active, true);
});

test('over-budget active introspection returns only inactive without starting a one-time Consent window', t => {
    const f = fixture(t);
    const response = f.issue();
    const active = f.inspect(response.body.access_token).body;
    const tokenBytes = Buffer.byteLength(JSON.stringify(response.body));
    assert.ok(Buffer.byteLength(JSON.stringify(active)) > tokenBytes);
    const consent = f.newDecision({ mode: 'one-time' });
    f.body.authorization_details = requested('Consent', consent.identifier[0].value);
    const oneTime = f.issue(); assert.equal(oneTime.status, 200);
    const oneTimeBytes = Buffer.byteLength(JSON.stringify(oneTime.body));
    f.config.presence.sources = { 'ho-a': { maxResponseBytes: oneTimeBytes } };
    assert.equal(f.windows.size, 0);
    assert.deepEqual(f.inspect(oneTime.body.access_token).body, { active: false });
    assert.equal(f.windows.size, 0);
});

test('Consent source additions preserve frozen A authority; removing/readding A revokes only its old tokens', t => {
    const f = fixture(t);
    const tokenA = f.issue().body.access_token;
    const consent = f.store.get('Consent', f.consent.id);
    const sourceB = f.config.healthOrganizations[1];
    const addition = structuredClone(consent);
    addition.provision.actor.push({ reference: { reference: `Organization/${sourceB.dataSourceOrganization.id}` }, role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] } });
    publish(f, addition);
    assert.equal(f.inspect(tokenA).body.active, true);
    assert.deepEqual(f.inspect(tokenA, sourceB.clientId).body, { active: false });
    const tokenB = f.issue('consent-access', [], sourceB).body.access_token;
    assert.equal(f.inspect(tokenB, sourceB.clientId).body.active, true);
    const removed = structuredClone(addition);
    removed.provision.actor = removed.provision.actor.filter(actor => actor.reference.reference !== `Organization/${f.source.dataSourceOrganization.id}`);
    publish(f, removed); publish(f, addition);
    assert.deepEqual(f.inspect(tokenA).body, { active: false });
    assert.equal(f.inspect(tokenB, sourceB.clientId).body.active, true);
    assert.equal(f.inspect(f.issue().body.access_token).body.active, true);
});

for (const control of ['consentState', 'serviceState', 'tokenResourceBinding', 'tokenAudience']) {
    test(`retired ${control} overrides reject; real authority loss remains terminal after restoration`, t => {
        const f = fixture(t, 'connectathon-balanced'), issued = f.issue(); assert.equal(issued.status, 200);
        const token = issued.body.access_token;
        for (const value of [false, true]) {
            f.config.securitySimulation.perSource[f.source.id] = { [control]: value };
            assert.throws(() => buildEffectivePolicy(f.config), /invalid|unknown/);
        }
        delete f.config.securitySimulation.perSource[f.source.id];
        const original = f.store.get('Consent', f.consent.id);
        publish(f, { ...original, status: 'inactive' });
        assert.deepEqual(f.inspect(token).body, { active: false });
        publish(f, original); assert.deepEqual(f.inspect(token).body, { active: false });
        assert.equal(f.tokenStore.get(token).revoked, true);
        assert.equal(f.issue().status, 200);
    });
}

test('introspection source form budgets allow exact decoded bytes and reject one-over before replay', t => {
    const f = fixture(t);
    const token = f.issue('presence-check').body.access_token;
    const body = { token, client_assertion_type: f.body.client_assertion_type, client_assertion: f.body.client_assertion };
    const exact = Object.entries(body).reduce((bytes, [name, value], index) => bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 1 + (index ? 1 : 0), 0);
    f.config.presence.sources = { 'ho-a': { maxFormBytes: exact }, 'ho-b': { maxFormBytes: exact - 1 } };
    assert.equal(f.inspect(token).body.active, true);
    const commits = f.introspectionReplays();
    assert.equal(f.inspect(token + 'x').body.error, 'invalid_request');
    assert.equal(f.inspect(token, f.config.healthOrganizations[1].clientId).body.error, 'invalid_request');
    assert.equal(f.introspectionReplays(), commits);
    assert.equal(f.tokenStore.get(token).revoked, undefined);
});

test('registered custom and legacy source overlays resolve by exact ID, resource and client without crossing managed sources', t => {
    const f = fixture(t);
    const custom = require('../src/data-sources').newDataSourceConfig('Budget fixture', 'https://custom.example.invalid/fhir', { pcmClientAuthCertThumbprint: 'A'.repeat(43) });
    f.config.organizations.dataSources ||= []; f.config.organizations.dataSources.push(custom);
    f.config.presence.sources = { [custom.id]: { maxPatients: 107 }, legacy: { maxPatients: 4 }, 'ho-a': { maxPatients: 2 } };
    assert.doesNotThrow(() => assertValidTeamConfig(f.config, { env: {} }));
    for (const selector of [{ id: custom.id }, { resource: custom.endpoint }, { clientId: custom.clientId }]) assert.equal(presenceLimits(f.config, selector).maxPatients, 107);
    for (const selector of [{ id: 'legacy' }, { id: f.config.organizations.referenceDataSource.id }, { resource: f.config.legacyDataSource.internalFhirBaseUrl }]) assert.equal(presenceLimits(f.config, selector).maxPatients, 4);
    assert.equal(presenceLimits(f.config, { id: 'ho-a' }).maxPatients, 2);
    assert.equal(presenceLimits(f.config, { id: 'ho-b' }).maxPatients, f.config.presence.batch.maxPatients);
    assert.equal(transportLimits(f.config).maxPatients, 107);
});
