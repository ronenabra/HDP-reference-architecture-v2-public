'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('node:fs');

// Set worker-owned paths before importing application modules with runtime state.
const testRuntime = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || require('node:os').tmpdir(), 'adapter-bindings-'));
const previousRuntimeEnv = { LOG_DIR: process.env.LOG_DIR, STATE_DIR: process.env.STATE_DIR };
process.env.LOG_DIR = path.join(testRuntime, 'logs');
process.env.STATE_DIR = path.join(testRuntime, 'state');
test.after(() => {
    for (const [key, value] of Object.entries(previousRuntimeEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(testRuntime, { recursive: true, force: true });
});

const { resolveBindings, validateSmartConfiguration } = require('../src/index');

function config() {
    return {
        contract: { environment: 'test', operational: { oauthBase: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4', fhirBase: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4' } },
        internalBaseUrls: { pcmAuth: 'https://pcm.internal:3000/api/fhir-service/r4', pcmFhir: 'https://pcm.internal:3000/api/fhir-service/r4' },
        publicBaseUrls: { pcmApi: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4' },
        organizations: {
            'ho-a': { id: 'ho-a', clientId: 'pcm-ds-ho-a-0001', endpoint: 'https://ho-a.example.test/fhir' },
            referenceDataSource: { id: 'reference', clientId: 'pcm-ds-reference-0001', endpoint: 'https://reference.example.test/fhir' }
        },
        certificateRoles: { referenceDataSource: { assertion: { key: 'assertion.key' }, mtls: { cert: 'mtls.crt', key: 'mtls.key' } } },
        certificates: { rootCaCert: 'ca.crt' }
    };
}

test('one image resolves immutable per-HO identity, audience, keys, and local token bindings', () => {
    const bindings = resolveBindings(config(), {
        HO_ID: 'ho-a', CERTS_DIR: '/certs', PCM_INTROSPECTION_AUTH_MODE: 'direct',
        DS_ASSERTION_KEY_PATH: '/ho-a/assertion.key', DS_MTLS_CERT_PATH: '/ho-a/mtls.crt',
        DS_MTLS_KEY_PATH: '/ho-a/mtls.key', DS_ROOT_CA_PATH: '/ho-a/ca.crt'
    });
    assert.equal(bindings.hoId, 'ho-a');
    assert.equal(bindings.clientId, 'pcm-ds-ho-a-0001');
    assert.equal(bindings.expectedAudience, 'https://ho-a.example.test/fhir');
    assert.equal(bindings.discoveryIssuer, 'https://pcm2mtest.health.gov.il/api/fhir-service/r4');
    assert.equal(bindings.authBase, 'https://pcm.internal:3000/api/fhir-service/r4');
    assert.equal(bindings.expectedIssuer, 'https://pcm2mtest.health.gov.il/api/fhir-service/r4');
    assert.equal(bindings.authMode, 'direct');
    assert.equal(bindings.assertionKeyPath, '/ho-a/assertion.key');
    assert.equal(bindings.localIssuer, 'https://ds-auth-adapter.internal/ho-a');
    assert.equal(bindings.localAudience, 'urn:pcm:ho:ho-a:fhir-server');
});

test('runtime bindings reject non-HTTPS endpoints and unknown caller modes', () => {
    assert.throws(() => resolveBindings(config(), { HO_ID: 'ho-a', PCM_INTROSPECTION_AUTH_MODE: 'mixed' }), /bearer or direct/);
    assert.throws(() => resolveBindings(config(), { HO_ID: 'ho-a', DS_EXPECTED_AUDIENCE: 'http://ho-a/fhir' }), /HTTPS URL/);
});

test('SMART discovery must exactly bind issuer, endpoints, private_key_jwt, and ES256', () => {
    const bindings = resolveBindings(config(), { HO_ID: 'ho-a' });
    const metadata = {
        issuer: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4',
        authorization_endpoint: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4/authorize',
        token_endpoint: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4/token',
        introspection_endpoint: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4/introspect',
        authorization_details_types_supported: ['https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access'],
        grant_types_supported: ['authorization_code', 'client_credentials'],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
        introspection_endpoint_auth_methods_supported: ['private_key_jwt'],
        introspection_endpoint_auth_signing_alg_values_supported: ['ES256'],
        tls_client_certificate_bound_access_tokens: false,
        code_challenge_methods_supported: ['S256'],
        capabilities: ['client-confidential-asymmetric']
    };
    assert.deepEqual(validateSmartConfiguration(metadata, bindings), {
        tokenEndpoint: metadata.token_endpoint,
        introspectionEndpoint: metadata.introspection_endpoint
    });
    assert.throws(() => validateSmartConfiguration({ ...metadata, token_endpoint: `${metadata.token_endpoint}/` }, bindings), /do not match/);
    assert.throws(() => validateSmartConfiguration({ ...metadata, token_endpoint_auth_signing_alg_values_supported: ['RS256'] }, bindings), /do not match/);
    assert.deepEqual(validateSmartConfiguration({ ...metadata, extra: true }, bindings), validateSmartConfiguration(metadata, bindings));
});

test('normalization snapshot includes strict-to-mTLS GUID eligibility and exact fixture enrollment without revision', () => {
    const { normalizationConfiguration } = require('../src/index');
    const { buildTeamConfig } = require('../../../test-support/team-config');
    const config = buildTeamConfig({}, 'strict');
    const strict = normalizationConfiguration(config, 'ho-a');
    config.conformance = buildTeamConfig({}, 'connectathon-mtls').conformance;
    const mtls = normalizationConfiguration(config, 'ho-a');
    assert.equal(strict.allowSandboxGuid, false);
    assert.equal(mtls.allowSandboxGuid, true);
    config.systemAuthorization.memberships.push({ identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }, homeHmoId: 'ho-a', sandboxFixture: true });
    assert.equal(normalizationConfiguration(config, 'ho-a').syntheticWorkflowFixtures.length, 1);
    config.systemAuthorization.memberships[0].sandboxFixture = false;
    assert.deepEqual(normalizationConfiguration(config, 'ho-a').syntheticWorkflowFixtures, []);
});
