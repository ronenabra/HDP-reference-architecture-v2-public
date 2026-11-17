'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { approveResources, SCOPE, CEILING, V } = require('../../../test-support/approved-resource-fixture');
const { resolveGrant } = require('../src/data-grant');
const { rar, dataGrantFixture, NOW } = require('../../../test-support/data-grants');

const {
    ACTIVE_CACHE_CEILING_SECONDS,
    CONTEXT_ROLES,
    classifyIntrospectionRequest,
    createIntrospectionService,
    evaluateSubjectToken
} = require('../src/introspection-service');
const { setApprovedTokenScope } = require('../src/data-sources');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS, PROFILES } = require('../../shared/pcm-contract');

class TestStore extends require('../src/fhir/store').FHIRStore {
    constructor(resources) {
        super();
        require('../../../test-support/approved-resource-fixture').installApprovedResources(this, resources);
    }
}

class TestFirstUseStore {
    constructor() { this.windows = new Map(); this.calls = 0; }
    get(key) { return this.windows.get(key) ? { ok: true, ...this.windows.get(key) } : null; }
    getOrStart(key, lifetime, now) {
        this.calls += 1;
        if (!this.windows.has(key)) this.windows.set(key, { startedAt: now, expiresAt: now + lifetime });
        return { ok: true, started: this.windows.get(key).startedAt === now, ...this.windows.get(key) };
    }
}

const endpointAddress = 'https://source-a.example/r4';
const authenticationContext = {
    token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) },
    client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) },
    correlation_verified: true
};

function activeStatus() {
    return {
        url: EXTENSIONS.serviceBusinessStatus,
        valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'active' }
    };
}

function fixtures(mode = 'continuous', scope = SCOPE, end = 10800) {
    const organization = (id, role, parent = null) => ({
        resourceType: 'Organization', id, active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-${id}` }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: role }] }],
        ...(parent ? { partOf: { reference: `Organization/${parent}` } } : {})
    });
    return approveResources([
        organization('parent-sp', 'parent-org'),
        {
            ...organization('org-sp', 'service-provider', 'parent-sp'),
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'SP-1' }]
        },
        organization('parent-ds-a', 'parent-org'),
        {
            ...organization('org-ds-a', 'source', 'parent-ds-a'),
            endpoint: [{ reference: 'Endpoint/endpoint-a' }]
        },
        {
            resourceType: 'Endpoint', id: 'endpoint-a', status: 'active', address: endpointAddress,
            managingOrganization: { reference: 'Organization/org-ds-a' }
        },
        organization('parent-ds-b', 'parent-org'),
        {
            ...organization('org-ds-b', 'source', 'parent-ds-b'),
            endpoint: [{ reference: 'Endpoint/endpoint-b' }]
        },
        {
            resourceType: 'Endpoint', id: 'endpoint-b', status: 'active', address: 'https://source-b.example/r4',
            managingOrganization: { reference: 'Organization/org-ds-b' }
        },
        {
            resourceType: 'HealthcareService', id: 'catalog', active: true,
            meta: { profile: [PROFILES.healthcareServiceCanonical], tag: [{ system: CODE_SYSTEMS.metaTag, code: 'catalog' }] },
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.healthcareServiceCatalog, value: 'CATALOG-1' }],
            extension: [activeStatus(), { url: EXTENSIONS.informationBucket, extension: [
                { url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code: 'laboratoryTests' }] } },
                { url: 'historyDepth', valueDuration: { value: 1, system: 'http://unitsofmeasure.org', code: 'a' } }
            ] }]
        },
        {
            resourceType: 'HealthcareService', id: 'instance', active: true,
            meta: { profile: [PROFILES.healthcareServiceInstance], tag: [{ system: CODE_SYSTEMS.metaTag, code: 'instance' }] },
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.healthcareServiceInstance, value: 'SERVICE-1' }],
            providedBy: { reference: 'Organization/org-sp' },
            extension: [activeStatus(), {
                url: EXTENSIONS.basedOnCanonicalHealthcareService,
                valueReference: { reference: 'HealthcareService/catalog' }
            }]
        },
        {
            resourceType: 'Consent', id: 'consent-1', status: 'active',
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.consent, value: 'PCM-CONSENT-UNIT' }],
            patient: { identifier: { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' } },
            category: [{ coding: [{ system: CODE_SYSTEMS.consentAccessMode, code: mode }] }],
            extension: [
                { url: EXTENSIONS.consentBusinessStatus, valueCoding: { system: CODE_SYSTEMS.consentBusinessStatus, code: 'active' } },
                { url: EXTENSIONS.pcmService, valueReference: { reference: 'HealthcareService/instance' } }
            ],
            provision: { period: { start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T03:00:00.000Z' }, actor: [
                { role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] }, reference: { reference: 'Organization/org-sp' } },
                { role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: 'Organization/org-ds-a' } },
                { role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: 'Organization/org-ds-b' } }
            ] }
        }
    ], { mode, scope, end });
}

function clients() {
    return [
        { clientId: 'sp-client', role: 'service-provider', organizationId: 'org-sp', mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) },
        { clientId: 'ds-a-client', role: 'data-source', organizationId: 'org-ds-a', scopes: ['introspection'] },
        { clientId: 'ds-b-client', role: 'data-source', organizationId: 'org-ds-b', scopes: ['introspection'] },
        { clientId: 'pcm-presence-orchestrator', role: 'presence-orchestrator', organizationId: 'org-sp', mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) }
    ];
}

function sourceToken(overrides = {}, resourceFixtures = fixtures(), scope = CEILING, resource = endpointAddress) {
    const grant = resolveGrant({ store: new TestStore(resourceFixtures), config: {}, firstUseStore: new TestFirstUseStore(),
        client: clients()[0], requested: rar('Consent', 'PCM-CONSENT-UNIT'), scope, resource, now: 1000 });
    return {
        kind: 'data_source_access', active: true,
        sub: 'sp-client', client_id: 'sp-client', organization_id: 'org-sp',
        scope: grant.scope, authorization_details: grant.authorization_details, iss: 'https://pcm.example', aud: endpointAddress,
        iat: 1000, exp: 10_000,
        pcm_authentication_context: authenticationContext,
        authorization: grant,
        ...overrides
    };
}

function evaluate(token = sourceToken(), options = {}) {
    const resourceFixtures = options.fixtures || fixtures(options.mode);
    const registered = options.clients || clients();
    const firstUseStore = options.firstUseStore || new TestFirstUseStore();
    return evaluateSubjectToken({
        token,
        caller: options.caller || { clientId: 'ds-a-client', organizationId: 'org-ds-a' },
        store: new TestStore(resourceFixtures),
        findClient: id => registered.find(client => client.clientId === id),
        firstUseStore,
        now: options.now || 1100,
        audit: options.audit,
        controls: options.controls
    });
}

test('Data Source active response is closed, cache-bounded, and has exactly three typed contexts', () => {
    const body = evaluate();
    assert.deepEqual(Object.keys(body).sort(), [
        'active', 'aud', 'authorization_details', 'client_id', 'exp', 'iat', 'iss',
        'organization_id', 'pcm_authentication_context', 'scope', 'sub'
    ]);
    assert.equal(body.exp, 1100 + ACTIVE_CACHE_CEILING_SECONDS);
    assert.equal(body.organization_id, `${IDENTIFIER_SYSTEMS.organization}#SP-1`);
    assert.deepEqual(body.authorization_details[0].fhirContext.map(item => item.type), ['Consent', 'HealthcareService', 'Patient']);
    for (const item of body.authorization_details[0].fhirContext) assert.equal(item.role, CONTEXT_ROLES[item.type]);
    assert.deepEqual(body.authorization_details[0].fhirContext.map(item => item.identifier.system), [
        IDENTIFIER_SYSTEMS.consent,
        IDENTIFIER_SYSTEMS.healthcareServiceInstance,
        IDENTIFIER_SYSTEMS.syntheticTest
    ]);
    assert.equal(Object.hasOwn(body, 'patient'), false);
    assert.equal(Object.hasOwn(body, 'cnf'), false);
    assert.equal(Object.hasOwn(body, 'kind'), false);
});

test('introspection preserves exact approved union and rejects a narrowed retained token', () => {
    const exact = `patient/Patient.rs?${V} patient/Observation.s?status=final&${V} patient/Observation.s?status=preliminary&${V}`;
    const resourceFixtures = fixtures('continuous', exact);
    const token = sourceToken({}, resourceFixtures, 'patient/Patient.rs patient/Observation.s');
    assert.equal(token.scope, exact); assert.ok(evaluate(token, { fixtures: resourceFixtures }));
    const subset = structuredClone(token);
    subset.scope = subset.scope.split(' ').slice(0, 2).join(' '); subset.authorization.scope = subset.scope;
    assert.equal(evaluate(subset, { fixtures: resourceFixtures }), null);
    assert.equal(evaluate({ ...token, scope: 'patient/Condition.rs' }, { fixtures: resourceFixtures }), null);
});

test('introspection audits allow and denial reasons without subject identifiers', () => {
    const decisions = [];
    assert.ok(evaluate(sourceToken(), { audit: decision => decisions.push(decision) }));
    assert.equal(evaluate(sourceToken({ aud: 'https://wrong.example/r4' }), {
        audit: decision => decisions.push(decision)
    }), null);

    assert.deepEqual(decisions, [
        { active: true, reason: 'authorized', kind: 'data_source_access' },
        { active: false, reason: 'caller-endpoint-audience', kind: 'data_source_access' }
    ]);
    assert.doesNotMatch(JSON.stringify(decisions), /patient|consent-1|source-a/);
});

test('online and batch presence responses carry only the self-contained Contract and explicit Patient contexts', () => {
    for (const size of [1, 2]) {
        const f = dataGrantFixture();
        const patients = Array.from({ length: size }, (_, i) => ({ system: IDENTIFIER_SYSTEMS.syntheticTest, value: String(i + 1) }));
        f.config.systemAuthorization.presenceEligiblePatients = patients;
        const client = { clientId: f.config.oauthClients.presenceOrchestrator.clientId,
            mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) };
        const grant = resolveGrant({ ...f.request, client, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', patients), scope: 'system/Patient.s' });
        const caller = { clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id };
        const token = { kind: size === 1 ? 'presence_online' : 'presence_batch', client_id: client.clientId, sub: client.clientId,
            iat: NOW, exp: NOW + 30, aud: f.source.endpoint, iss: f.config.contract.operational.fhirBase,
            scope: grant.scope, authorization: grant, authorization_details: grant.authorization_details, pcm_authentication_context: authenticationContext };
        const body = evaluateSubjectToken({ token, caller, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now: NOW,
            findClient: id => id === client.clientId ? client : { ...caller, role: 'data-source' } });
        assert.equal(body.authorization_details[0].fhirContext.length, size + 1);
        assert.equal(Object.hasOwn(body, 'organization_id'), false);
        assert.equal(Object.hasOwn(body, 'fhirContext'), false);
    }
});

test('every subject or caller lifecycle loss produces only the inactive decision', () => {
    const mutations = [
        resources => { resources.find(item => item.id === 'org-sp').active = false; },
        resources => { resources.find(item => item.id === 'parent-sp').active = false; },
        resources => { resources.find(item => item.id === 'org-ds-a').active = false; },
        resources => { resources.find(item => item.id === 'endpoint-a').status = 'off'; },
        resources => { resources.find(item => item.id === 'endpoint-a').address = `${endpointAddress}/changed`; },
        resources => { resources.find(item => item.id === 'consent-1').status = 'inactive'; },
        resources => { resources.find(item => item.id === 'consent-1').provision.period.end = '1970-01-01T00:18:20Z'; },
        resources => { resources.find(item => item.id === 'consent-1').patient.identifier.value = '2'; },
        resources => { resources.find(item => item.id === 'consent-1').extension
            .find(extension => extension.url === EXTENSIONS.pcmService).valueReference.reference = 'HealthcareService/other'; },
        resources => { resources.find(item => item.id === 'instance').active = false; },
        resources => { resources.find(item => item.id === 'catalog').active = false; }
    ];
    for (const mutate of mutations) {
        const resourceFixtures = fixtures();
        mutate(resourceFixtures);
        assert.equal(evaluate(sourceToken(), { fixtures: resourceFixtures }), null);
    }
    assert.equal(evaluate(sourceToken({ exp: 1100 })), null);
    assert.equal(evaluate(sourceToken(), { clients: clients().filter(client => client.clientId !== 'sp-client') }), null);
    assert.equal(evaluate(sourceToken(), { clients: clients().map(client => client.clientId === 'sp-client' ? { ...client, role: 'data-source' } : client) }), null);
    assert.equal(evaluate(sourceToken(), { caller: { clientId: 'ds-b-client', organizationId: 'org-ds-b' } }), null);
});

test('one-time windows begin at first active introspection and remain source-specific for one hour', () => {
    const firstUseStore = new TestFirstUseStore();
    assert.ok(evaluate(sourceToken({}, fixtures('one-time')), { mode: 'one-time', firstUseStore, now: 2000 }));
    assert.ok(evaluate(sourceToken({}, fixtures('one-time')), { mode: 'one-time', firstUseStore, now: 5599 }));
    assert.equal(evaluate(sourceToken({}, fixtures('one-time')), { mode: 'one-time', firstUseStore, now: 5600 }), null);

    const sourceB = sourceToken({ aud: 'https://source-b.example/r4' }, fixtures('one-time'), CEILING, 'https://source-b.example/r4');
    assert.ok(evaluate(sourceB, {
        mode: 'one-time', firstUseStore, now: 5600,
        caller: { clientId: 'ds-b-client', organizationId: 'org-ds-b' }
    }));
    assert.equal(firstUseStore.windows.size, 2);
});

test('introspection request discriminator rejects mixed, missing, unknown, and extra fields', () => {
    const req = (body, authorization) => ({ body, headers: authorization ? { authorization } : {}, get: name => name === 'authorization' ? authorization : undefined });
    assert.equal(classifyIntrospectionRequest(req({ token: 'subject' }, 'Bearer caller')).mode, 'bearer');
    assert.equal(classifyIntrospectionRequest(req({
        token: 'subject', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'jwt'
    })).mode, 'assertion');
    for (const request of [
        req({ token: 'subject', client_assertion_type: ASSERTION_TYPE, client_assertion: 'jwt' }, 'Bearer caller'),
        req({ token: 'subject', extra: 'value' }, 'Bearer caller'),
        req({ token: 'subject', token_type_hint: 'refresh_token' }, 'Bearer caller'),
        req({ token: 'subject' }),
        req({ token: ['subject'] }, 'Bearer caller')
    ]) assert.equal(classifyIntrospectionRequest(request).ok, false);
});

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

test('one evaluation path serves direct and bearer callers and never leaks inactive claims', () => {
    const records = new Map([
        ['caller-bearer', {
            kind: 'introspection', sub: 'ds-a-client', client_id: 'ds-a-client', organization_id: 'org-ds-a',
            scope: 'system/*.crus', aud: 'https://pcm.example/introspect', iat: 1000, exp: 2000
        }],
        ['subject', sourceToken()]
    ]);
    const service = createIntrospectionService({
        tokenStore: { get: token => records.get(token) },
        store: new TestStore(fixtures()),
        findClient: id => clients().find(client => client.clientId === id),
        authenticateAssertion: () => ({ client: clients().find(client => client.clientId === 'ds-a-client') }),
        getAudience: () => 'https://pcm.example/introspect',
        firstUseStore: new TestFirstUseStore(),
        clock: () => 1100
    });
    const request = (body, authorization) => ({
        body, headers: authorization ? { authorization } : {},
        get: name => name === 'authorization' ? authorization : undefined
    });
    const bearer = service(request({ token: 'subject', token_type_hint: 'access_token' }, 'Bearer caller-bearer'));
    const direct = service(request({ token: 'subject', token_type_hint: 'access_token', client_assertion_type: ASSERTION_TYPE, client_assertion: 'jwt' }));
    assert.deepEqual(direct.body, bearer.body);
    records.delete('subject');
    assert.deepEqual(service(request({ token: 'subject' }, 'Bearer caller-bearer')).body, { active: false });
    assert.equal(service(request({ token: 'subject' }, 'Bearer wrong')).status, 401);

    records.set('wrong-audience', {
        kind: 'introspection', sub: 'ds-a-client', client_id: 'ds-a-client', organization_id: 'org-ds-a',
        scope: 'system/*.crus', aud: 'https://pcm.example/token', iat: 1000, exp: 2000
    });
    assert.equal(service(request({ token: 'subject' }, 'Bearer wrong-audience')).status, 401);

    const wrongRoleService = createIntrospectionService({
        tokenStore: { get: token => records.get(token) },
        store: new TestStore(fixtures()),
        findClient: id => clients().map(client => client.clientId === 'ds-a-client'
            ? { ...client, role: 'service-provider' } : client).find(client => client.clientId === id),
        authenticateAssertion: () => ({ client: { ...clients()[1], role: 'service-provider' } }),
        firstUseStore: new TestFirstUseStore(),
        clock: () => 1100
    });
    assert.equal(wrongRoleService(request({
        token: 'subject', client_assertion_type: ASSERTION_TYPE, client_assertion: 'jwt'
    })).status, 401);
});


test('obsolete lifecycle and token controls cannot omit any required decision', () => {
    for (const control of ['tokenExpiry', 'tokenAudience', 'tokenResourceBinding', 'consentState', 'serviceState']) {
        const token = sourceToken();
        const resources = fixtures();
        if (control === 'tokenExpiry') token.exp = 1099;
        if (control === 'tokenAudience') token.aud = 'https://other.example/fhir';
        if (control === 'tokenResourceBinding') token.authorization.endpointId = 'other-endpoint';
        if (control === 'consentState') resources.find(item => item.resourceType === 'Consent').status = 'inactive';
        if (control === 'serviceState') resources.find(item => item.resourceType === 'HealthcareService' && item.id === 'instance').active = false;
        assert.equal(evaluate(token, { fixtures: resources }), null, control);
        const controls = { [control]: false };
        assert.equal(evaluate(token, { fixtures: resources, controls }), null, control);
        assert.equal(evaluate({ ...token, pcm_authentication_context: {} }, { fixtures: resources, controls }), null, 'authentication binding remains active');
        assert.equal(evaluate({ ...token, client_id: 'unregistered' }, { fixtures: resources, controls }), null, 'registered identity remains active');
    }
});

test('known Consent and first-use deadlines cap active projections independently of token expiry', () => {
    const resourceFixtures = fixtures('continuous', SCOPE, 10800);
    // A corrupted period cannot be made authoritative by disabling lifecycle checks.
    resourceFixtures.find(resource => resource.resourceType === 'Consent').provision.period.end = new Date(1101_000).toISOString();
    assert.equal(evaluate(sourceToken(), { fixtures: resourceFixtures, now: 1100 }), null);
    assert.equal(evaluate(sourceToken(), { fixtures: resourceFixtures, now: 1101 }), null);
    assert.equal(evaluate(sourceToken(), { fixtures: resourceFixtures, now: 1101, controls: { consentState: false } }), null);

    const firstUseStore = new TestFirstUseStore();
    evaluate(sourceToken({}, fixtures('one-time')), { mode: 'one-time', firstUseStore, now: 2000 });
    assert.equal(evaluate(sourceToken({}, fixtures('one-time')), { mode: 'one-time', firstUseStore, now: 5599 }).exp, 5600);
    assert.equal(evaluate(sourceToken({}, fixtures('one-time')), { mode: 'one-time', firstUseStore, now: 5600 }), null);
    assert.equal(firstUseStore.windows.size, 1);
});

test('retained expired token files never gain active authority under obsolete expiry controls', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pcm-expiry-simulation-'));
    const { FileTokenStore, EXPIRED_TOKEN_RETENTION_SECONDS } = require('../src/token-store');
    let now = 1100;
    const tokens = new FileTokenStore(directory, { clock: () => now });
    t.after(() => { tokens.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    tokens.set('subject', { ...sourceToken(), exp: now - 1 });
    assert.equal(evaluate(tokens.get('subject')), null);
    assert.equal(evaluate(tokens.get('subject'), { controls: { tokenExpiry: false } }), null);
    now = 1099 + EXPIRED_TOKEN_RETENTION_SECONDS;
    assert.equal(evaluate(tokens.get('subject') || null, { now, controls: { tokenExpiry: false } }), null);
    assert.equal(tokens.size, 0);
});

// Fresh introspection rechecks registration; the documented 30-second source
// cache may retain an earlier response, but refresh cannot restore removed roles.
test('retained issuance evidence cannot acquire a removed transport or signing registration', () => {
    const registered = clients();
    assert.equal(evaluate(sourceToken(), { clients: registered }).active, true);
    for (const field of ['mtlsThumbprint', 'assertionThumbprint']) {
        const changed = structuredClone(registered);
        changed[0][field] = 'C'.repeat(43);
        assert.equal(evaluate(sourceToken(), { clients: changed }), null, field);
    }
});

/** Exercise real authority reevaluation with an SP caller and immutable usage/token owners. */
function ownInspectionFixture(preset = 'connectathon-balanced') {
    const resources = fixtures('one-time');
    const store = new TestStore(resources), registered = clients(), windows = new TestFirstUseStore();
    const token = sourceToken({}, resources), before = JSON.stringify(token);
    let configuration = { conformance: { preset }, security: { pcmApi: {} } };
    let authentication = { client: registered[0], transportVerified: true, signatureVerified: true };
    let now = 1100;
    const decisions = [];
    const service = createIntrospectionService({
        store, findClient: id => registered.find(client => client.clientId === id),
        tokenStore: { get: value => value === 'subject' ? token : null,
            revoke: () => assert.fail('SP diagnostics must not revoke a token') },
        firstUseStore: windows, clock: () => now,
        getConfig: () => configuration,
        getAudience: () => 'https://pcm.example/introspect',
        authenticateAssertion: () => authentication,
        logger: { info: (_message, details) => decisions.push(details) }
    });
    return { token, before, store, registered, windows, decisions,
        configure(value) { configuration = value; }, authenticate(value) { authentication = value; },
        at(value) { now = value; },
        check(value = 'subject') { return service({ body: { token: value, client_assertion_type: ASSERTION_TYPE, client_assertion: 'jwt' }, headers: {} }); }
    };
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
    test(`own-SP inspection ${preset} uses original authority without starting or mutating anything`, () => {
        const f = ownInspectionFixture(preset), result = f.check();
        if (preset === 'strict') assert.equal(result.status, 403);
        else {
            assert.equal(result.body.active, true);
            assert.equal(result.body.scope, f.token.scope);
            assert.deepEqual(result.body.authorization_details, f.token.authorization_details);
            assert.equal(result.body.aud, endpointAddress);
            assert.equal(result.body.exp, 1130);
            assert.equal(f.decisions.at(-1).visibility, 'diagnostic');
            assert.equal(f.decisions.at(-1).operation, 'service-provider-own-token-introspection');
        }
        assert.equal(f.windows.calls, 0); assert.equal(f.windows.windows.size, 0);
        assert.equal(JSON.stringify(f.token), f.before);
        assert.equal(f.store.get('Organization', 'org-sp').endpoint, undefined);
    });
}

test('own inspection disable/re-enable, authentication and foreign/unknown subject boundaries', () => {
    const f = ownInspectionFixture();
    f.configure({ security: { pcmApi: { allowServiceProviderOwnTokenIntrospection: false } } });
    assert.equal(f.check().status, 403);
    f.configure({ security: { pcmApi: { allowServiceProviderOwnTokenIntrospection: true } } });
    assert.equal(f.check().body.active, true);
    for (const field of ['transportVerified', 'signatureVerified']) {
        f.authenticate({ client: f.registered[0], transportVerified: true, signatureVerified: true, [field]: false });
        assert.equal(f.check().status, 401, field);
    }
    f.authenticate({ client: f.registered[0], transportVerified: true, signatureVerified: true });
    assert.deepEqual(f.check('unknown').body, { active: false });
    for (const [field, value] of [['client_id', 'another-sp'], ['sub', 'another-sp'], ['iss', 'https://other-issuer.example'],
        ['aud', 'https://other-source.example'], ['exp', 1100], ['revoked', true]]) {
        const old = f.token[field]; f.token[field] = value;
        assert.deepEqual(f.check().body, { active: false }, field);
        f.token[field] = old;
    }
    for (const role of ['mtlsThumbprint', 'assertionThumbprint']) {
        const old = f.registered[0][role]; f.registered[0][role] = 'C'.repeat(43);
        assert.deepEqual(f.check().body, { active: false }, role);
        f.registered[0][role] = old;
    }
    assert.equal(f.windows.calls, 0); assert.equal(JSON.stringify(f.token), f.before);
});

test('own inspection reads an existing source window and current authority without extending or revoking', () => {
    const f = ownInspectionFixture();
    const key = require('../src/clinical-first-use').firstUseKey('instance', 'consent-1', 'sp-client', 'org-ds-a');
    f.at(4590);
    f.windows.windows.set(key, { startedAt: 1000, expiresAt: 4600 });
    const before = JSON.stringify([...f.windows.windows]);
    assert.equal(f.check().body.exp, 4600);
    f.windows.windows.set(key, { startedAt: 990, expiresAt: 4590 });
    assert.deepEqual(f.check().body, { active: false });
    f.windows.windows.set(key, { startedAt: 1000, expiresAt: 4600 });
    const source = f.store.get('Endpoint', 'endpoint-a'); source.status = 'off'; f.store.add(source);
    assert.deepEqual(f.check().body, { active: false });
    assert.equal(JSON.stringify([...f.windows.windows]), before);
    assert.equal(f.windows.calls, 0); assert.equal(JSON.stringify(f.token), f.before);
});
