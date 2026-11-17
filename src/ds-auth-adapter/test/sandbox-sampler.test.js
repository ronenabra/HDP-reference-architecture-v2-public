'use strict';
/** Normal introspection determines sampling before relaxed open dispatch. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-adapter-'));
process.env.LOG_DIR = path.join(dir, 'logs');

const { buildTeamConfig } = require('../../../test-support/team-config');
const { URI } = require('../../shared/sandbox-patients');
const { validateIntrospectionResponse } = require('../src/introspection-contract');
const { authorizationDetails } = require('../../pcm-core/src/data-grant');
const { samplingResources } = require('../../pcm-core/src/fhir/sampling-policy');
const localJwt = require('../src/local-jwt');

test('ordinary opaque sampling stays bounded under all connectathon presets and rejects strict/inactive/old handles', async t => {
    const config = buildTeamConfig({ sandboxSampling: { sourceIds: ['ho-a'] }, serviceCatalog: { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'sample-test-service', instanceIdentifier: 'SAMPLE-TEST' }] } });
    config.systemAuthorization.clientEntitlements[config.organizations.serviceProvider.clientId] = ['sandbox-patient-sample'];
    const [service, contract] = samplingResources(config), now = Math.floor(Date.now() / 1000);
    const raw = { active: true, client_id: config.organizations.serviceProvider.clientId, sub: config.organizations.serviceProvider.clientId,
        scope: 'system/Patient.s', iss: config.contract.operational.fhirBase, aud: config.healthOrganizations[0].endpoint, iat: now, exp: now + 30,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true },
        authorization_details: authorizationDetails('sandbox-patient-sample', contract, service) };
    const options = { expectedIssuer: raw.iss, expectedAudience: raw.aud, hoId: 'ho-a', allowSandboxGuid: true, controls: { tokenAudience: false, tokenExpiry: false } };
    let decision = validateIntrospectionResponse(raw, options), calls = 0, payload;
    const oldSign = localJwt.signLocalJwt;
    localJwt.signLocalJwt = claims => { payload = claims; return 'normal-private-context'; };
    t.after(() => { localJwt.signLocalJwt = oldSign; fs.rmSync(dir, { recursive: true, force: true }); });
    delete require.cache[require.resolve('../src/mapper')];
    delete require.cache[require.resolve('../src/index')];
    const { createApp } = require('../src/index');
    const server = http.createServer(createApp({ config, env: {}, client: { async introspect(token) {
        calls++; return token === 'ordinary-opaque' ? decision : { active: false };
    } }, bindings: { hoId: 'ho-a', expectedAudience: raw.aud, localIssuer: 'https://adapter.internal/ho-a', localAudience: 'urn:pcm:ho:ho-a:fhir-server' } }).app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const send = (uri = URI, token = 'ordinary-opaque', method = 'GET') => fetch(`http://127.0.0.1:${server.address().port}/auth-check`, {
        headers: { authorization: `Bearer ${token}`, 'x-original-method': method, 'x-original-uri': uri, 'x-pcm-scenario': 'sandbox-patient-sample' }
    });
    assert.equal((await send()).status, 200); assert.equal(calls, 1);
    assert.equal(payload.kind, 'sandbox-patient-sample'); assert.equal(payload.patient, undefined);
    assert.deepEqual(payload.contract_identifier, { system: contract.identifier[0].system, value: contract.identifier[0].value });
    assert.deepEqual(payload.healthcare_service_identifier, { system: service.identifier[0].system, value: service.identifier[0].value });
    for (const uri of ['/fhir/Patient', `${URI}&_include=*`, `${URI}&_getpages=next`, URI.replace('_count=10', '_count=100'), URI.replace('identifier%2Cname', 'identifier%2Ctelecom'), '/fhir/Patient/1', '/fhir/Patient/_history', '/fhir/Observation', '/fhir']) assert.equal((await send(uri)).status, 401);
    assert.equal((await send(URI, 'ordinary-opaque', 'POST')).status, 401);
    assert.equal((await send(URI, 'pcm-sampler-retired')).status, 401);
    decision = { active: false }; assert.equal((await send()).status, 401);
    decision = validateIntrospectionResponse(raw, options);
    config.sandboxSampling.sourceIds = []; assert.equal((await send()).status, 401);
    Object.assign(config, buildTeamConfig({ sandboxSampling: { sourceIds: ['ho-a'] }, serviceCatalog: config.serviceCatalog, systemAuthorization: config.systemAuthorization }, 'strict'));
    assert.equal((await send()).status, 401);
    for (const change of [{ aud: 'https://other.invalid/fhir' }, { exp: now - 1 }, { scope: 'system/Patient.rs' }]) assert.throws(() => validateIntrospectionResponse({ ...raw, ...change }, options));
    const invalid = structuredClone(raw); invalid.authorization_details[0].fhirContext.push(invalid.authorization_details[0].fhirContext[0]);
    assert.throws(() => validateIntrospectionResponse(invalid, options));
    assert.throws(() => validateIntrospectionResponse(raw, { ...options, allowSandboxGuid: false }));
});
