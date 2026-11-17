'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { approveResources, SCOPE, CEILING, V } = require('../../../test-support/approved-resource-fixture');

const { classifyTokenRequest, createTokenService } = require('../src/token-service');
const { setApprovedTokenScope } = require('../src/data-sources');
const { B2B, CODE_SYSTEMS, CONSENT_POLICY, EXTENSIONS, IDENTIFIER_SYSTEMS, PROFILES, SCOPES } = require('../../shared/pcm-contract');

const assertionFields = {
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: 'header.payload.signature'
};
const issuer = 'https://pcm2mtest.health.gov.il/api/fhir-service/r4';
const { rar, dataGrantFixture, NOW } = require('../../../test-support/data-grants');
const endpointAddress = 'https://source.example.test/r4';

class TestStore extends require('../src/fhir/store').FHIRStore {
    constructor(resources) {
        super();
        require('../../../test-support/approved-resource-fixture').installApprovedResources(this, resources);
    }
}

function statusExtension() {
    return {
        url: EXTENSIONS.serviceBusinessStatus,
        valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-service-business-status', code: 'active' }
    };
}

function resources(mode = 'continuous', scope = SCOPE) {
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
        organization('parent-ds', 'parent-org'),
        {
            ...organization('org-ds', 'source', 'parent-ds'),
            endpoint: [{ reference: 'Endpoint/endpoint-ds' }]
        },
        {
            resourceType: 'Endpoint', id: 'endpoint-ds', status: 'active', address: endpointAddress,
            managingOrganization: { reference: 'Organization/org-ds' }
        },
        {
            resourceType: 'HealthcareService', id: 'catalog', active: true,
            meta: { profile: [PROFILES.healthcareServiceCanonical], tag: [{ system: CODE_SYSTEMS.metaTag, code: 'catalog' }] },
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.healthcareServiceCatalog, value: 'CATALOG-1' }],
            extension: [statusExtension(), { url: EXTENSIONS.informationBucket, extension: [
                { url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code: 'laboratoryTests' }] } },
                { url: 'historyDepth', valueDuration: { value: 1, system: 'http://unitsofmeasure.org', code: 'a' } }
            ] }]
        },
        {
            resourceType: 'HealthcareService', id: 'instance', active: true,
            meta: { profile: [PROFILES.healthcareServiceInstance], tag: [{ system: CODE_SYSTEMS.metaTag, code: 'instance' }] },
            identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.healthcareServiceInstance, value: 'INSTANCE-1' }],
            providedBy: { reference: 'Organization/org-sp' },
            extension: [statusExtension(), {
                url: EXTENSIONS.basedOnCanonicalHealthcareService,
                valueReference: { reference: 'HealthcareService/catalog' }
            }]
        },
        {
            resourceType: 'Consent', id: 'consent-1', status: 'active',
            identifier: [{ system: IDENTIFIER_SYSTEMS.consent, value: 'PCM-CONSENT-UNIT' }],
            patient: { identifier: { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' } },
            extension: [
                { url: EXTENSIONS.consentBusinessStatus, valueCoding: { system: CODE_SYSTEMS.consentBusinessStatus, code: 'active' } },
                { url: EXTENSIONS.pcmService, valueReference: { reference: 'HealthcareService/instance' } }
            ],
            provision: { period: { start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T03:00:00.000Z' }, actor: [
                { role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] }, reference: { reference: 'Organization/org-sp' } },
                { role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: 'Organization/org-ds' } }
            ] }
        }
    ], { mode, scope });
}

function cleanClaims() {
    return { iss: 'sp-client', sub: 'sp-client', aud: `${issuer}/token`, jti: 'jti', iat: 970, exp: 1030 };
}

function clients() {
    const certificateRoles = { mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) };
    return {
        serviceProvider: {
            clientId: 'sp-client', role: 'service-provider', organizationId: 'org-sp',
            scopes: [SCOPES.management], authorizationCodeGrant: true, ...certificateRoles
        },
        dataSource: {
            clientId: 'ds-client', role: 'data-source', organizationId: 'org-ds', scopes: ['introspection', SCOPES.management], ...certificateRoles
        },
        presence: {
            clientId: 'pcm-presence-orchestrator', role: 'presence-orchestrator', organizationId: 'org-sp', scopes: [], ...certificateRoles
        }
    };
}

function harness(resourceFixtures = resources(), options = {}) {
    const issued = [];
    const tokenStore = {
        issue(kind, claims, lifetime) {
            const token = `opaque-${issued.length + 1}`;
            const record = { ...claims, kind, iat: 1000, exp: 1000 + lifetime };
            issued.push({ token, record, lifetime });
            return { token, record };
        },
        get size() { return issued.length; }
    };
    const authorizationStore = {
        consumeCode: request => request.code === 'good-code'
            ? { ok: true, grant: {
                scope: ['patient/Observation.rs'], audience: issuer,
                patient: { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' }
            } }
            : { ok: false, error: 'invalid_grant', description: 'invalid code' }
    };
    const service = createTokenService({
        tokenStore,
        firstUseStore: { get: () => null },
        fhirStore: new TestStore(resourceFixtures),
        authenticate: req => req.authentication,
        getIssuer: () => issuer,
        getPolicy: () => ({ compatibility: { enabledAdapters: [] } }),
        getConfig: () => ({}),
        getLifetime: () => 30,
        authorizationStore,
        clock: () => 1000,
        logger: { info() {}, warn() {} },
        ...options
    });
    return { service, issued };
}

function request(body, client, decodedAssertion = {}) {
    if (body.scope?.startsWith('patient/') && body.grant_type === 'client_credentials') body = { authorization_details: JSON.stringify(rar('Consent', 'PCM-CONSENT-UNIT').details), ...body };
    return { body, mtls: { thumbprint: client.mtlsThumbprint }, authentication: { client, decodedAssertion, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: client.assertionThumbprint } };
}

test('closed request discriminator accepts each OpenAPI form and rejects ambiguous form shapes', () => {
    const code = { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app/cb', code_verifier: 'A'.repeat(43), ...assertionFields };
    const clientCredentials = { grant_type: 'client_credentials', ...assertionFields, scope: SCOPES.management, resource: issuer };
    assert.equal(classifyTokenRequest(code).kind, 'authorization_code');
    assert.equal(classifyTokenRequest(clientCredentials).kind, 'management_or_introspection');
    assert.equal(classifyTokenRequest({ ...clientCredentials, scope: CEILING, authorization_details: JSON.stringify(rar('Consent', 'PCM-CONSENT-UNIT').details) }).kind, 'data_source_access');
    assert.equal(classifyTokenRequest({ ...clientCredentials, scope: 'system/Patient.s', authorization_details: JSON.stringify(rar('Contract', 'PCM-POLICY-PRESENCE-001', [{ system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' }]).details) }).kind, 'system_policy_access');
    for (const body of [
        { ...code, scope: CEILING },
        { ...clientCredentials, unknown: 'field' },
        { grant_type: 'password', ...assertionFields }
    ]) assert.equal(classifyTokenRequest(body).ok, false);
    const duplicateResource = classifyTokenRequest({
        ...clientCredentials,
        resource: [issuer, endpointAddress]
    });
    assert.equal(duplicateResource.status, 400);
    assert.equal(duplicateResource.body.error, 'invalid_target');
});

test('token service issues basic and Consent token outcomes with exact closed responses', () => {
    const { service, issued } = harness();
    const registered = clients();
    const cases = [
        ['authorization_code', request({
            grant_type: 'authorization_code', code: 'good-code', redirect_uri: 'https://app/cb',
            code_verifier: 'A'.repeat(43), ...assertionFields
        }, registered.serviceProvider)],
        ['management', request({ grant_type: 'client_credentials', ...assertionFields, scope: SCOPES.management, resource: issuer }, registered.serviceProvider)],
        ['introspection', request({ grant_type: 'client_credentials', ...assertionFields, scope: SCOPES.management, resource: `${issuer}/introspect` }, registered.dataSource)],
        ['data_source_access', request({ grant_type: 'client_credentials', ...assertionFields, scope: CEILING, resource: endpointAddress }, registered.serviceProvider, cleanClaims())],

    ];
    for (const [kind, input] of cases) {
        const result = service(input);
        assert.equal(result.status, 200);
        assert.deepEqual(Object.keys(result.body).sort(), ['access_token', ...(kind === 'data_source_access' ? ['authorization_details'] : []), 'expires_in', 'scope', 'token_type']);
        assert.equal(result.body.token_type, 'Bearer');
        assert.equal(result.body.expires_in, 30);
        assert.equal(issued.at(-1).record.kind, kind);
        assert.equal(Object.hasOwn(result.body, 'refresh_token'), false);
        assert.equal(Object.hasOwn(result.body, 'patient'), false);
        assert.equal(Object.hasOwn(result.body, 'cnf'), false);
    }
    assert.equal(issued.some(item => Object.hasOwn(item.record, 'firstUse')), false);
});

test('Consent request actions are advisory while caller filters remain syntactically invalid', () => {
    const exact = `patient/Patient.rs?${V} patient/Observation.s?status=final&${V} patient/Observation.s?status=preliminary&${V}`;
    const { service, issued } = harness(resources('continuous', exact));
    const form = { grant_type: 'client_credentials', ...assertionFields, resource: endpointAddress, scope: 'patient/Patient.rs patient/Observation.s' };
    const result = service(request(form, clients().serviceProvider, cleanClaims()));
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.scope, exact);
    assert.equal(service(request({ ...form, scope: 'patient/Patient.rs patient/Observation.r' }, clients().serviceProvider, cleanClaims())).body.scope, exact);
    assert.equal(service(request({ ...form, scope: 'patient/Observation.s' }, clients().serviceProvider, cleanClaims())).body.scope, exact);
    assert.equal(service(request({ ...form, scope: 'patient/Observation.s?status=final' }, clients().serviceProvider, cleanClaims())).body.error, 'invalid_scope');
    assert.equal(issued.length, 3);
});

test('registered Data Source can obtain the management ceiling for its own FHIR lifecycle', () => {
    const { service, issued } = harness();
    const dataSource = clients().dataSource;
    const result = service(request({
        grant_type: 'client_credentials', ...assertionFields,
        scope: SCOPES.management, resource: issuer
    }, dataSource));

    assert.equal(result.status, 200);
    assert.equal(issued[0].record.kind, 'management');
    assert.equal(issued[0].record.organization_id, 'org-ds');
});

test('token service rejects exact-target, role, RAR, lifecycle, and replay-adjacent failures without issuance', () => {
    const { service, issued } = harness();
    const registered = clients();
    const base = { grant_type: 'client_credentials', ...assertionFields, scope: SCOPES.management };
    assert.equal(service(request({ ...base, resource: `${issuer}/` }, registered.serviceProvider)).body.error, 'invalid_target');
    assert.equal(service(request({ ...base, resource: issuer }, {
        ...registered.dataSource, scopes: ['introspection']
    })).body.error, 'unauthorized_client');
    const dsForm = { grant_type: 'client_credentials', ...assertionFields, scope: CEILING, resource: endpointAddress };
    for (const value of ['[]', '{}', JSON.stringify(rar('Consent', 'missing-business-id').details)]) {
        assert.notEqual(service(request({ ...dsForm, authorization_details: value }, registered.serviceProvider, cleanClaims())).status, 200);
    }
    assert.equal(issued.length, 0);

    for (const [resourceType, id, mutate] of [
        ['Endpoint', 'endpoint-ds', resource => { resource.status = 'off'; }],
        ['HealthcareService', 'instance', resource => { resource.active = false; }],
        ['HealthcareService', 'catalog', resource => { resource.active = false; }]
    ]) {
        const staleFixtures = resources();
        mutate(staleFixtures.find(resource => resource.resourceType === resourceType && resource.id === id));
        const stale = harness(staleFixtures);
        const result = stale.service(request(dsForm, registered.serviceProvider, cleanClaims()));
        assert.notEqual(result.status, 200);
        assert.equal(stale.issued.length, 0);
    }
});

test('legacy management scope is one named connectathon adapter and strict remains closed', () => {
    const warnings = [];
    const common = harness();
    const strictResult = common.service(request({
        grant_type: 'client_credentials', ...assertionFields,
        scope: SCOPES.legacyManagement, resource: issuer
    }, clients().serviceProvider));
    assert.equal(strictResult.body.error, 'invalid_scope');

    const issued = [];
    const adapted = createTokenService({
        tokenStore: { issue(kind, claims, lifetime) { issued.push({ kind, claims, lifetime }); return { token: 'opaque', record: { ...claims, kind, iat: 1000, exp: 1000 + lifetime } }; }, get size() { return issued.length; } },
        fhirStore: new TestStore(resources()),
        authenticate: req => req.authentication,
        getIssuer: () => issuer,
        getPolicy: () => ({ compatibility: { enabledAdapters: ['legacy-management-scope-cruds'] } }),
        getConfig: () => ({}), getLifetime: () => 45, clock: () => 1000,
        logger: { info() {}, warn(message, fields) { warnings.push({ message, fields }); } }
    });
    const result = adapted(request({
        grant_type: 'client_credentials', ...assertionFields,
        scope: SCOPES.legacyManagement, resource: issuer
    }, clients().serviceProvider));
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, SCOPES.management);
    assert.equal(result.body.expires_in, 45);
    assert.equal(issued[0].lifetime, 45);
    assert.equal(warnings[0].fields.adapter, 'legacy-management-scope-cruds');
});


test('issuance reads an existing first-use window without starting or restarting it', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { FileFirstUseWindowStore } = require('../src/state-store');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'issuance-window-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const firstUseStore = new FileFirstUseWindowStore(directory);
    const fixtures = resources('one-time');
    let now = 2000;
    const { service } = harness(fixtures, { firstUseStore, clock: () => now });
    const input = request({ grant_type: 'client_credentials', ...assertionFields,
        scope: CEILING, resource: endpointAddress }, clients().serviceProvider, cleanClaims());
    assert.equal(service(input).status, 200);
    assert.deepEqual(fs.readdirSync(directory), []);
    firstUseStore.getOrStart(require('../src/clinical-first-use').firstUseKey('instance', 'consent-1', 'sp-client', 'org-ds'), 3600, now);
    now = 5599;
    assert.equal(service(input).status, 200);
    now = 5600;
    assert.equal(service(input).body.error, 'invalid_authorization_details');
    assert.equal(firstUseStore.getOrStart(require('../src/clinical-first-use').firstUseKey('instance', 'consent-1', 'sp-client', 'org-ds'), 3600, now).expiresAt, 5600);
    const relaxed = harness(fixtures, { firstUseStore, clock: () => now,
        getPolicy: () => ({ compatibility: { enabledAdapters: [] }, simulation: { controls: { consentState: false } } }) });
    assert.equal(relaxed.service(input).body.error, 'invalid_authorization_details');
});


test('request authentication evidence separates selected bare keys and retains explicit signature simulation', () => {
    const { authenticationContext } = require('../src/token-service');
    const client = { mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) };
    assert.equal(authenticationContext({ mtls: { thumbprint: 'C'.repeat(43) } }, { client, assertionSigningThumbprint: null, assertionKeyThumbprint: 'D'.repeat(43) }), null);
    assert.equal(authenticationContext({ mtls: { thumbprint: 'C'.repeat(43) } }, { client, assertionSigningThumbprint: null, assertionKeyThumbprint: null }), null);
    const context = authenticationContext({ mtls: { thumbprint: 'C'.repeat(43) } }, { client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: 'E'.repeat(43) });
    assert.equal(context.token_endpoint_mtls['x5t#S256'], 'C'.repeat(43));
    assert.equal(context.client_assertion_signing['x5t#S256'], 'E'.repeat(43));
});

test('strict issuance evidence cannot infer observation from configured roles or skipped checks', () => {
    const { authenticationContext } = require('../src/token-service');
    const client = clients().serviceProvider;
    const request = { mtls: { thumbprint: client.mtlsThumbprint } };
    const evidence = { client, transportVerified: true, signatureVerified: true,
        assertionSigningThumbprint: client.assertionThumbprint };
    const strict = { requireVerified: true };
    assert.equal(authenticationContext(request, { client }, strict), null);
    for (const changed of [{ transportVerified: false }, { signatureVerified: false }, { assertionSigningThumbprint: null }]) {
        assert.equal(authenticationContext(request, { ...evidence, ...changed }, strict), null);
    }
    assert.equal(authenticationContext({}, evidence, strict), null);
    assert.equal(authenticationContext(request, evidence, strict).correlation_verified, true);
});
