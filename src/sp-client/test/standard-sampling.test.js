'use strict';
/** Exercise Doctor's ordinary token construction and bounded direct source request. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime({ sandboxSampling: { sourceIds: ['ho-a', 'ho-b'] }, serviceCatalog: { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'sample-test-service', instanceIdentifier: 'SAMPLE-TEST' }] } });
fs.cpSync(require('../../../test-support/certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
for (const role of ['serviceProvider', 'hospitalBServiceProvider']) config.systemAuthorization.clientEntitlements[config.organizations[role].clientId] = ['sandbox-patient-sample'];
fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
for (const prefix of ['sp-client', 'hospital-b-sp']) {
    fs.writeFileSync(path.join(process.env.CERTS_DIR, `${prefix}-assertion.key`), crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
}
const axios = require('axios'), client = require('../src/client');
const { samplingResources } = require('../../pcm-core/src/fhir/sampling-policy');
const { authorizationDetails } = require('../../pcm-core/src/data-grant');
const { URI, SYSTEM } = require('../../shared/sandbox-patients');
const { TYPE } = require('../../shared/data-authorization-details');
let tokenCalls = [], sourceCalls = [], change, denied, hold;
const [service, contract] = samplingResources(config), oldAdapter = axios.defaults.adapter;
axios.defaults.adapter = async request => {
    let data;
    if (request.url.endsWith('/.well-known/smart-configuration')) {
        const issuer = config.contract.operational.oauthBase;
        data = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, introspection_endpoint: `${issuer}/introspect`, authorization_details_types_supported: [TYPE], grant_types_supported: ['client_credentials', 'authorization_code'], response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'], tls_client_certificate_bound_access_tokens: false, capabilities: ['launch-standalone', 'client-confidential-asymmetric', 'permission-patient', 'permission-v2'] };
    } else if (request.url.endsWith('/token')) {
        const form = new URLSearchParams(request.data); tokenCalls.push(form);
        if (denied) throw Object.assign(Error('Denied'), { config: request, response: { status: 400, data: { error: 'invalid_authorization_details' } } });
        data = { access_token: `ordinary-${tokenCalls.length}`, token_type: 'Bearer', expires_in: 60, scope: 'system/Patient.s', authorization_details: authorizationDetails('sandbox-patient-sample', contract, service) };
    } else {
        sourceCalls.push(request);
        if (hold) await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new axios.CanceledError()), { once: true }));
        assert.ok(config.healthOrganizations.some(ho => request.url === `${ho.endpoint}${URI.slice(5)}`));
        assert.ok(request.httpsAgent.options.cert); assert.ok(request.httpsAgent.options.key); assert.equal(request.httpsAgent.options.rejectUnauthorized, false);
        assert.equal(request.timeout, 10000); assert.equal(request.maxContentLength, 128 * 1024); assert.equal(request.maxRedirects, 0);
        data = { resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: 'https://never-follow.invalid' }], entry: [{ resource: { resourceType: 'Patient', identifier: [{ system: SYSTEM, value: 'Ab123456-1234-5678-9012-1234567890ab' }], meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] }, name: [{ text: 'Synthetic' }] } }] };
        if (change) { config.runtime.revision = (config.runtime.revision || 0) + 1; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config)); }
    }
    return { status: 200, config: request, headers: {}, data };
};
test.after(() => { axios.defaults.adapter = oldAdapter; });
test('app/source/basis cache partitions, Contract-only RAR and one direct projected page', async () => {
    for (const identity of ['hospital-a', 'hospital-b']) for (const sourceId of ['ho-a', 'ho-b']) {
        const result = await client.loadSandboxPatientSample(sourceId, identity); assert.equal(result.requests, 1); assert.equal(result.patients.length, 1); assert.equal(result.sourceId, sourceId);
        await client.loadSandboxPatientSample(sourceId, identity);
    }
    assert.equal(tokenCalls.length, 4); assert.equal(sourceCalls.length, 8);
    for (const form of tokenCalls) {
        assert.equal(form.get('scope'), 'system/Patient.s');
        const rar = JSON.parse(form.get('authorization_details')); assert.equal(rar[0].fhirContext.length, 1); assert.equal(rar[0].fhirContext[0].type, 'Contract');
        const claims = require('jsonwebtoken').decode(form.get('client_assertion'));
        assert.equal(claims.aud, `${config.contract.operational.oauthBase}/token`);
    }
    assert.notEqual(client._test.tokenCacheKey('hospital-a', config.healthOrganizations[0].endpoint, 'other-basis', 'system/Patient.s'), client._test.tokenCacheKey('hospital-a', config.healthOrganizations[0].endpoint, contract.identifier[0].value, 'system/Patient.s'));
});
test('failures, explicit cancellation and changed configuration cannot publish or fall back', async () => {
    change = true; await assert.rejects(client.loadSandboxPatientSample('ho-a'), /superseded/); change = false;
    const before = sourceCalls.length; denied = true; client.resetCache();
    await assert.rejects(client.loadSandboxPatientSample('ho-a')); assert.equal(sourceCalls.length, before); denied = false;
    const controller = new AbortController(); controller.abort(); await assert.rejects(client.loadSandboxPatientSample('ho-a', 'hospital-a', controller.signal), /cancelled/); assert.equal(sourceCalls.length, before);
    hold = true; const ongoing = new AbortController(), pending = client.loadSandboxPatientSample('ho-a', 'hospital-a', ongoing.signal);
    while (sourceCalls.length === before) await new Promise(resolve => setImmediate(resolve));
    ongoing.abort(); await assert.rejects(pending, /canceled/); hold = false; assert.equal(sourceCalls.length, before + 1);
    delete config.systemAuthorization.clientEntitlements[config.organizations.serviceProvider.clientId]; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    await assert.rejects(client.loadSandboxPatientSample('ho-a'), /entitled/);
});
