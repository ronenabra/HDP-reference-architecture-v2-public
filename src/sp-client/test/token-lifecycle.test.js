'use strict';

/** Exercise Doctor token caching, policy changes and failure logs through real client paths. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
installTestRuntime();
const axios = require('axios');
const client = require('../src/client');
const logger = require('../src/logger');
const { ExpiringTokenCache } = require('../src/oauth');
const { TYPE, ROLE, BASIS, SERVICE } = require('../../shared/data-authorization-details');
const { SANDBOX_GUID_ID_SYSTEM, sandboxIdentityOptions } = require('../../shared/identity-mapping');
const { environmentEndpoints } = require('../../shared/pcm-environment');
const { PROFILES, CODE_SYSTEMS, EXTENSIONS, CONSENT_POLICY } = require('../src/constants');
const { readUnifiedPage } = require('../../pcm-core/src/unified-log-page');

const patient = { system: SANDBOX_GUID_ID_SYSTEM, value: '1b54ee14-cb93-445e-b00d-ded8113f8b2d' };
const source = 'https://clinical.example/fhir';
const originalAdapter = axios.defaults.adapter;
let config, requests, tokenLifetime, malformed, denied, malformedDiscovery, previewMode, wireConsent, wireScope, tokenAlteration, introspectionMode, statusPause, sourcePause, consentReadHook;
let customResponse;

fs.cpSync(require('../../../test-support/certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
const privateKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
fs.writeFileSync(path.join(process.env.CERTS_DIR, 'sp-client-assertion.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }));

/** Save a complete runtime policy without changing the selected local transport URL. */
function configure(preset = 'connectathon-easy', environment = 'test') {
    config = buildTeamConfig({ contract: { environment } }, preset);
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
}

const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
const grantFixture = clinicalTokenFixture({ scope: `patient/Patient.rs?${V} patient/Observation.rs?status=final&${V} patient/Condition.rs?${V}` });
const approvedConsent = grantFixture.approve(patient);
const approvedScope = `patient/Patient.rs?${V} patient/Observation.rs?status=final&${V} patient/Condition.rs?${V}`;

/** Explicit newly approved disposable authority, returned by the mocked FHIR wire. */
function consent() { return structuredClone(wireConsent || approvedConsent); }

/** Enriched Consent grant, kept separate from the opaque access token. */
function tokenResponse(scope = 'patient/Observation.rs', enriched = true) {
    return { access_token: 'opaque-guid-token', token_type: 'Bearer', expires_in: tokenLifetime, scope,
        ...(enriched ? { authorization_details: [{ type: TYPE,
            purposeOfUse: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' }],
            fhirContext: [
                { type: 'Consent', role: `${ROLE}authorization-basis`, identifier: { system: BASIS.Consent, value: (wireConsent || approvedConsent).identifier[0].value } },
                { type: 'HealthcareService', role: `${ROLE}healthcare-service`, identifier: { system: SERVICE.Consent, value: grantFixture.service.identifier[0].value } },
                { type: 'Patient', role: `${ROLE}authorization-patient`, identifier: { ...(wireConsent || approvedConsent).patient.identifier } }
            ] }] } : {}) };
}

/** Substitute only the wire adapter; request construction, interceptors and validation run normally. */
async function wire(request) {
    requests.push(request);
    const url = new URL(request.url);
    const issuer = environmentEndpoints(config.contract.environment).oauthBase;
    let data;
    if (url.pathname.endsWith('/.well-known/smart-configuration')) {
        data = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
            introspection_endpoint: `${issuer}/introspect`,
            authorization_details_types_supported: [TYPE], grant_types_supported: ['authorization_code', 'client_credentials'],
            response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'],
            tls_client_certificate_bound_access_tokens: false,
            capabilities: ['launch-standalone', 'client-confidential-asymmetric', 'permission-patient', 'permission-v2'] };
        if (malformedDiscovery) data.capabilities = [];
    } else if (url.pathname.endsWith('/introspect')) {
        if (statusPause) await statusPause;
        if (['refused', 'unsupported', 'unavailable'].includes(introspectionMode)) throw Object.assign(new Error('Optional capability unavailable'), { config: request, response: { config: request, status: { refused: 403, unsupported: 404, unavailable: 503 }[introspectionMode], data: { error: 'access_denied' } } });
        if (introspectionMode === 'inactive') data = { active: false };
        else {
            data = { ...tokenResponse(wireScope), active: true, exp: Math.floor(Date.now() / 1000) + tokenLifetime, client_id: config.organizations.serviceProvider.clientId, aud: source };
            delete data.access_token; delete data.token_type; delete data.expires_in;
            if (introspectionMode === 'issuer-valid') data.iss = issuer;
            if (introspectionMode === 'issuer-mismatch') data.iss = issuer + '/another-issuer';
            if (introspectionMode === 'issuer-null') data.iss = null;
            if (introspectionMode === 'scope-mismatch') data.scope = 'patient/Patient.rs';
            if (introspectionMode === 'client-mismatch') data.client_id = 'another-client';
            if (introspectionMode === 'audience-mismatch') data.aud = source + '-b';
            if (introspectionMode === 'extended-expiry') data.exp += 60;
            if (introspectionMode === 'malformed') data.active = 'true';
        }
    } else if (url.pathname.endsWith('/token')) {
        if (denied) {
            const error = new Error('Request failed with status code 401');
            error.config = request;
            error.response = { config: request, status: 401, data: { error: 'invalid_client', error_description: 'Client not registered' } };
            throw error;
        }
        const form = new URLSearchParams(request.data);
        data = tokenResponse(form.has('authorization_details') ? wireScope : (form.get('scope') || 'patient/Observation.rs'), form.has('authorization_details'));
        if (form.has('authorization_details')) data.access_token = 'opaque-source-token-' + Buffer.from(form.get('resource')).toString('base64url');
        if (malformed && form.has('authorization_details')) data.authorization_details = [];
        if (tokenAlteration && form.has('authorization_details')) tokenAlteration(data);
    } else if (/\/HealthcareService\/[^/]+$/.test(url.pathname)) {
        data = grantFixture.store.get('HealthcareService', url.pathname.split('/').at(-1));
    } else if (/\/Organization\/[^/]+$/.test(url.pathname)) {
        data = grantFixture.store.get('Organization', url.pathname.split('/').at(-1));
    } else if (url.pathname.endsWith('/Consent')) {
        data = { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ search: { mode: 'match' }, resource: consent() }] };
        consentReadHook?.();
    } else if (request.url.startsWith(source)) {
        if (previewMode === 'override-denied') throw Object.assign(new Error('Custom GET denied'), { response: { status: 403 }, config: request });
        if (sourcePause) await sourcePause;
        if (previewMode === 'second-source-denied' && request.url.startsWith(source + '-b')) throw Object.assign(new Error('Second source denied'), { response: { status: 403 }, config: request });
        if (previewMode === 'partial' && url.pathname.endsWith('/Condition')) throw Object.assign(new Error('Condition denied'), { response: { status: 403 }, config: request });
        data = { resourceType: 'Bundle', type: 'searchset', total: 1,
            entry: [{ resource: { resourceType: url.pathname.split('/').at(-1), id: 'guid-data' } }] };
        if (previewMode === 'empty') data = { resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] };
        if (previewMode === 'paging') {
            const type = url.pathname.split('/').at(-1);
            data = { resourceType: 'Bundle', type: 'searchset', total: type === 'Observation' ? 13 : 1, entry: Array.from({ length: type === 'Observation' ? 10 : 1 }, (_, i) => ({ resource: { resourceType: type, id: String(i) } })), link: type === 'Observation' ? [{ relation: 'next', url: 'https://untrusted.invalid/secret?token=private' }] : [] };
        }
        if (customResponse) data = structuredClone(customResponse);
    } else throw new Error(`Unexpected test request: ${request.url}`);
    return { config: request, status: 200, headers: { 'content-type': 'application/fhir+json' }, data };
}

test.beforeEach(() => {
    configure(); client.resetCache(); requests = []; tokenLifetime = 86400; malformed = false; denied = false; malformedDiscovery = false; previewMode = null; wireConsent = approvedConsent; wireScope = approvedScope; tokenAlteration = null; introspectionMode = 'active'; statusPause = null; sourcePause = null; consentReadHook = null;
    axios.defaults.adapter = wire;
    customResponse = null;
});
test.after(() => { axios.defaults.adapter = originalAdapter; });

test('GET override sends only the exact suffix and preserves count, direct-read and large FHIR responses', async () => {
    const cases = [
        ['/Patient', { resourceType: 'Bundle', type: 'searchset', entry: [] }],
        ['/Observation?_summary=count', { resourceType: 'Bundle', type: 'searchset', total: 42 }],
        ['/Patient/known-id', { resourceType: 'Patient', id: 'known-id' }],
        ['/Practitioner/known-id', { resourceType: 'Practitioner', id: 'known-id' }],
        ['/Observation?code=a%7Cb&code=c+d&_count=21', { resourceType: 'Bundle', total: 21,
            entry: Array.from({ length: 21 }, (_, i) => ({ resource: { resourceType: 'Observation', id: String(i) } })),
            link: [{ relation: 'next', url: source + '/never-follow' }] }]
    ];
    for (const [path, response] of cases) {
        requests = []; customResponse = response;
        const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s', path);
        const sent = requests.filter(request => request.url.startsWith(source));
        assert.equal(sent.length, 1); assert.equal(sent[0].url, source + path);
        assert.equal(sent[0].method, 'get'); assert.equal(sent[0].maxRedirects, 0);
        assert.match(sent[0].headers.Authorization, /^Bearer opaque-source-token-/);
        const { preview, ...body } = result;
        assert.deepEqual(body, response); assert.equal(preview.requestOverride, path);
        assert.equal(preview.effectiveGrant.scope, approvedScope);
        assert.deepEqual(preview.actions, [{ type: 'FHIR', method: 'GET', path, source }]);
    }
});

test('GET override permits explicit reads with a read-only grant and leaves refusal to the source', async () => {
    wireScope = 'patient/Observation.r';
    customResponse = { resourceType: 'Observation', id: 'known-id' };
    const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', wireScope, '/Observation/known-id');
    assert.equal(result.id, 'known-id');
    requests = []; previewMode = 'override-denied';
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', wireScope, '/Patient'), error => error.response?.status === 403);
    assert.deepEqual(requests.filter(request => request.url.startsWith(source)).map(request => request.url), [source + '/Patient']);
});

test('GET override rejects malformed paths before network and retains token and response validation', async () => {
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s', 'Patient'), /must start with/);
    assert.equal(requests.length, 0);
    malformed = true;
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s', '/Patient'), error => error.classification === 'invalid_token_response');
    assert.equal(requests.filter(request => request.url.startsWith(source)).length, 0);
    malformed = false; customResponse = { message: 'not a FHIR resource' };
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s', '/Patient'), error => error.classification === 'unexpected_response');
});

test('empty GET override keeps predefined bounded Patient and Observation searches', async () => {
    const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Patient.rs patient/Observation.rs', '');
    const sent = requests.filter(request => request.url.startsWith(source));
    assert.equal(sent.length, 2);
    for (const request of sent) assert.equal(new URL(request.url).searchParams.get('_count'), '10');
    assert.equal(new URL(sent.find(request => new URL(request.url).pathname.endsWith('/Patient')).url).searchParams.get('identifier'), `${patient.system}|${patient.value}`);
    assert.equal(result.preview.limit, 10); assert.equal(result.preview.requestOverride, undefined);
});

test('GUID cache admission retains the caller gate, exact identifier, lifetime and expiry bounds', () => {
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        configure(preset);
        let now = 1000;
        const cache = new ExpiringTokenCache({ clock: () => now, skewMs: 0 });
        const response = tokenResponse();
        const options = { maximumLifetime: 86400, ...sandboxIdentityOptions(config) };
        if (preset === 'strict') {
            assert.throws(() => cache.put('guid', response, options), /Sandbox GUID/);
            assert.equal(cache.get('guid'), null);
        } else {
            assert.equal(cache.put('guid', response, options), response.access_token);
            assert.deepEqual(cache.details('guid').authorization_details[0].fhirContext[2].identifier, patient);
            now += 30000; assert.equal(cache.get('guid'), null);
        }
    }
    const cache = new ExpiringTokenCache();
    assert.throws(() => cache.put('default', tokenResponse()), /Sandbox GUID/);
    assert.throws(() => cache.put('production', tokenResponse(), { maximumLifetime: 30, allowSandboxGuid: true }), /closed/);
    for (const value of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
        const response = tokenResponse(); response.authorization_details[0].fhirContext[2].identifier.value = value;
        assert.throws(() => cache.put(value, response, { allowSandboxGuid: true }), /Sandbox GUID/);
    }
});

test('Doctor fetches GUID Patient/Observation and reuses the data token in every connectathon preset', async () => {
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) {
        configure(preset); client.resetCache(); requests = [];
        const scope = 'patient/Patient.rs patient/Observation.rs';
        const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', scope);
        assert.equal(result.entry.length, 2);
        const patientRequest = requests.find(request => request.url.startsWith(`${source}/Patient?`));
        assert.equal(new URL(patientRequest.url).searchParams.get('identifier'), `${patient.system}|${patient.value}`);
        await client.fetchData(approvedConsent.id, source, 'hospital-a', scope);
        const dataTokens = requests.filter(request => request.url.endsWith('/token') && new URLSearchParams(request.data).has('authorization_details'));
        assert.equal(dataTokens.length, 1);
        assert.equal(new URLSearchParams(dataTokens[0].data).get('scope'), scope);
        assert.equal(requests.filter(request => request.url.startsWith(source)).some(request => new URL(request.url).pathname.endsWith('/Condition')), false);
    }
});

test('invalid successful tokens produce visible correlated failure logs and never call the source', async () => {
    malformed = true;
    await logger.withContext({ flowId: 'guid-fetch-flow', logCategory: 'harness', logVisibility: 'diagnostic', operation: 'fetch-data' }, async () => {
        await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs'), error => {
            assert.equal(error.classification, 'invalid_token_response');
            assert.match(error.message, /response validation failed \(HTTP 200\)/);
            assert.doesNotMatch(error.message, /before receiving/);
            return true;
        });
    });
    assert.ok(!requests.some(request => request.url.startsWith(source)));
    const entries = fs.readFileSync(logger.getLogPath(), 'utf8').trim().split('\n').map(JSON.parse);
    const failed = entries.findLast(entry => entry.details.type === 'DATA_FETCH_FAILED');
    assert.equal(failed.details.flowId, 'guid-fetch-flow');
    assert.equal(failed.details.category, 'system'); assert.equal(failed.details.visibility, 'default');
    assert.equal(failed.details.stage, 'PCM token request');
    const page = readUnifiedPage(path.dirname(process.env.LOG_DIR), [{ dir: path.basename(process.env.LOG_DIR), label: 'Doctor', role: 'doctor' }], { diagnostics: 'false' });
    assert.ok(page.entries.some(entry => entry.details.type === 'DATA_FETCH_FAILED' && entry.details.flowId === 'guid-fetch-flow'));
    malformed = false;
    assert.equal((await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs')).resourceType, 'Bundle');
});

test('Doctor fetch completion emits a diagnostic summary beside ordinary HTTP evidence', async () => {
    const context = { flowId: 'fetch-summary-flow', correlationId: 'fetch-summary-request', causesSystemFlow: true };
    const result = await logger.withContext(context, () => client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs'));
    assert.equal(result.resourceType, 'Bundle');
    const entries = fs.readFileSync(logger.getLogPath(), 'utf8').trim().split('\n').map(JSON.parse)
        .filter(entry => entry.details.flowId === context.flowId);
    const summary = entries.find(entry => entry.details.type === 'DATA_FETCH_COMPLETED');
    assert.ok(summary);
    assert.equal(summary.details.category, 'harness');
    assert.equal(summary.details.visibility, 'diagnostic');
    assert.equal(summary.details.causesSystemFlow, true);
    assert.equal(summary.details.correlationId, context.correlationId);
    assert.equal(summary.details.consentId, approvedConsent.id);
    assert.equal(summary.details.targetUrl, source);
    assert.equal(summary.event.eventName, 'DATA_FETCH_COMPLETED');
    assert.deepEqual(summary.event.source, { componentId: 'sp-client', role: 'doctor' });
    const exchange = entries.filter(entry => ['OUTGOING_REQUEST', 'OUTGOING_RESPONSE'].includes(entry.details.type));
    assert.ok(exchange.some(entry => entry.details.url.startsWith(source + '/Observation?')));
    assert.ok(exchange.every(entry => entry.details.category === 'system' && entry.details.visibility === 'default'));
});

test('strict GUID rejection stays a response-validation failure without clinical dispatch', async () => {
    configure('strict');
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs'), error => {
        assert.equal(error.classification, 'invalid_token_response'); assert.match(error.message, /Sandbox GUID/); return true;
    });
    assert.ok(!requests.some(request => request.url.startsWith(source)));
});

test('SMART discovery refreshes after switching environments at the same transport URL', async () => {
    const base = client._test.getPcmFhirUrl();
    assert.equal((await client._test.getSmartConfiguration(base)).issuer, environmentEndpoints('test').oauthBase);
    const initialDiscoveries = requests.filter(request => request.url.includes('/.well-known/')).length;
    configure('connectathon-easy', 'production');
    assert.equal(client._test.getPcmFhirUrl(), base);
    assert.equal((await client._test.getSmartConfiguration(base)).issuer, environmentEndpoints('production').oauthBase);
    assert.equal(requests.filter(request => request.url.includes('/.well-known/')).length, initialDiscoveries + 1);
});

test('SMART code exchange enforces production and test lifetime ceilings', async () => {
    for (const [environment, lifetime, accepted] of [['production', 31, false], ['production', 30, true], ['test', 86400, true], ['test', 86401, false]]) {
        configure('connectathon-easy', environment); tokenLifetime = lifetime;
        const transaction = await client.beginSmartAuthorization();
        const exchange = client.exchangeSmartAuthorization(transaction, { state: transaction.state, code: 'authorized-code' });
        if (accepted) assert.equal((await exchange).expires_in, lifetime);
        else await assert.rejects(exchange, /closed Bearer-token/);
    }
});

test('token endpoint rejection retains its server diagnostic and appears as a fetch failure', async () => {
    denied = true;
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs'), error => {
        assert.equal(error.message, 'Client not registered'); assert.equal(error.classification, 'authorization_failed'); return true;
    });
    assert.ok(!requests.some(request => request.url.startsWith(source)));
    const entries = fs.readFileSync(logger.getLogPath(), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.findLast(entry => entry.details.type === 'DATA_FETCH_FAILED').details.visibility, 'default');
});

test('successful malformed discovery remains a validation failure and prevents token/source requests', async () => {
    config.internalBaseUrls.pcmFhir = 'https://discovery-failure.example/api/fhir-service/r4';
    config.internalBaseUrls.pcmAuth = config.internalBaseUrls.pcmFhir;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    malformedDiscovery = true;
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs'), error => {
        assert.equal(error.classification, 'invalid_discovery_response');
        assert.match(error.message, /SMART discovery failed closed/);
        assert.doesNotMatch(error.message, /before receiving/);
        return true;
    });
    assert.ok(!requests.some(request => request.url.endsWith('/token') || request.url.startsWith(source)));
});

test('actual Doctor client retains per-type first-page evidence and never requests an untrusted continuation', async () => {
    previewMode = 'paging';
    const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs patient/Condition.rs');
    assert.equal(result.entry.length, 11);
    assert.deepEqual(result.preview.types.map(type => [type.type, type.count, type.boundary]), [['Observation', 10, 'more'], ['Condition', 1, 'complete']]);
    assert.equal(requests.filter(request => request.url.startsWith(source)).length, 2);
    assert.ok(requests.filter(request => request.url.startsWith(source)).every(request => new URL(request.url).searchParams.get('_count') === '10'));
    assert.ok(requests.every(request => !request.url.includes('untrusted')));
    assert.doesNotMatch(JSON.stringify(result), /private|untrusted/);
});
test('actual Doctor client keeps successful first page when another resource type is denied', async () => {
    previewMode = 'partial';
    const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.rs patient/Condition.rs');
    assert.equal(result.preview.outcome, 'partial');
    assert.equal(result.preview.failures[0].outcome, 'denied');
    assert.equal(result.entry[0].resource.resourceType, 'Observation');
});

test('unresolved query actions never dispatch a hardcoded Observation fallback', async () => {
    requests = [];
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a'), /no Observation fallback/);
    await assert.rejects(client.fetchAllSources(approvedConsent, 'hospital-a'), /scope is required/);
    assert.equal(requests.length, 0);
});

test('service refresh clears only the selected registered provider token partition', async () => {
    configure('connectathon-easy'); client.resetCache(); requests = [];
    const audience = client._test.getPcmFhirUrl();
    await client._test.getToken(audience, 'hospital-a');
    await client._test.getToken(audience, 'hospital-b');
    const issued = () => requests.filter(request => request.url.endsWith('/token')).length;
    assert.equal(issued(), 2);
    client.resetCache('hospital-a');
    await client._test.getToken(audience, 'hospital-b'); assert.equal(issued(), 2);
    await client._test.getToken(audience, 'hospital-a'); assert.equal(issued(), 3);
});

test('ordinary Consent source and lifecycle refresh preserve another provider token partition; full reset clears both', async () => {
    const { refreshConsent } = require('../src/consent-refresh');
    const audience = client._test.getPcmFhirUrl();
    const issued = () => requests.filter(request => request.url.endsWith('/token')).length;
    await client._test.getToken(audience, 'hospital-a'); await client._test.getToken(audience, 'hospital-b');
    assert.equal(issued(), 2);
    const record = { owner: 'hospital-a', consent: consent(), data: { old: true } };
    const publicIdentifier = structuredClone(record.consent.identifier);
    const changedSources = consent(); changedSources.provision.actor = [];
    await refreshConsent(record, changedSources, { discover: async () => null, resetCache: client.resetCache });
    await client._test.getToken(audience, 'hospital-b'); assert.equal(issued(), 2);
    await client._test.getToken(audience, 'hospital-a'); assert.equal(issued(), 3);
    const inactive = { ...structuredClone(record.consent), status: 'inactive' };
    await refreshConsent(record, inactive, { discover: () => assert.fail('Inactive Consent cannot discover'), resetCache: client.resetCache });
    await client._test.getToken(audience, 'hospital-b'); assert.equal(issued(), 3);
    await client._test.getToken(audience, 'hospital-a'); assert.equal(issued(), 4);
    assert.deepEqual(record.consent.identifier, publicIdentifier);
    client.resetCache();
    await client._test.getToken(audience, 'hospital-b'); await client._test.getToken(audience, 'hospital-a');
    assert.equal(issued(), 6);
});


test('actual outgoing search-only and read-only selections preserve complete token ceilings without widening', async () => {
    for (const action of ['s', 'r']) {
        client.resetCache(); requests = [];
        const scope = `patient/Patient.rs?${V} patient/Observation.${action}?status=final&${V}`;
        wireConsent = grantFixture.approve(patient, scope); wireScope = scope;
        const selection = action === 's' ? 'patient/Observation.s' : 'patient/Patient.s patient/Observation.r';
        const result = await client.fetchData(wireConsent.id, source, 'hospital-a', selection);
        const clinicalTokens = requests.filter(request => request.url.endsWith('/token') && new URLSearchParams(request.data).has('authorization_details'));
        assert.equal(clinicalTokens.length, 1);
        assert.equal(new URLSearchParams(clinicalTokens[0].data).get('scope'), selection);
        assert.equal(new URLSearchParams(clinicalTokens[0].data).get('resource'), source);
        assert.equal(result.preview.effectiveGrant.scope, scope);
        const outgoing = requests.filter(request => request.url.startsWith(source));
        assert.equal(outgoing.length, 1); assert.equal(outgoing[0].method, 'get');
        assert.equal(new URL(outgoing[0].url).pathname, action === 's' ? '/fhir/Observation' : '/fhir/Patient');
        if (action === 'r') {
            assert.equal(result.preview.skipped[0].outcome, 'skipped-read-only');
            requests = [];
            await assert.rejects(client.fetchData(wireConsent.id, source, 'hospital-a', 'patient/Observation.r'), error => error.classification === 'read_only_limitation');
            assert.ok(!requests.some(request => request.url.startsWith(source)));
            await assert.rejects(client.fetchData(wireConsent.id, source, 'hospital-a', 'patient/Observation.rs'), error => error.classification === 'read_only_limitation');
            assert.ok(!requests.some(request => request.url.startsWith(source)));
        }
    }
});

test('unexpected returned scope, basis, service or Patient aborts before source dispatch and cache admission', async () => {
    for (const alter of [value => { value.scope = 'patient/Observation.s?_filter=unsupported'; }, ...[0, 1, 2].map(index => value => { value.authorization_details[0].fhirContext[index].identifier.value = '000000026'; })]) {
        client.resetCache(); requests = []; tokenAlteration = alter;
        await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s'), error => error.classification === 'invalid_token_response');
        assert.ok(!requests.some(request => request.url.startsWith(source)));
        tokenAlteration = null;
        await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
        assert.equal(requests.filter(request => request.url.endsWith('/token') && new URLSearchParams(request.data).has('authorization_details')).length, 2);
    }
});

test('empty successful search stays distinct from a skipped supported read and a denied query', async () => {
    previewMode = 'empty';
    const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    assert.equal(result.preview.outcome, 'empty'); assert.deepEqual(result.preview.failures, []); assert.deepEqual(result.preview.skipped, []);
});


test('source audiences use separate validated tokens and one source denial preserves another result', async () => {
    const targets = [source, source + '-b'];
    for (const target of targets) await client.fetchData(approvedConsent.id, target, 'hospital-a', 'patient/Observation.s');
    const issued = requests.filter(request => request.url.endsWith('/token') && new URLSearchParams(request.data).has('authorization_details'));
    assert.deepEqual(issued.map(request => new URLSearchParams(request.data).get('resource')), targets);
    const sourceRequests = requests.filter(request => request.url.startsWith(source));
    assert.notEqual(sourceRequests[0].headers.Authorization, sourceRequests[1].headers.Authorization);
    assert.ok(issued.every(request => new URLSearchParams(request.data).get('scope') === 'patient/Observation.s'));
    previewMode = 'second-source-denied';
    const outcomes = await Promise.allSettled(targets.map(target => client.fetchData(approvedConsent.id, target, 'hospital-a', 'patient/Observation.s')));
    assert.deepEqual(outcomes.map(value => value.status), ['fulfilled', 'rejected']);
    assert.equal(outcomes[0].value.preview.source, source); assert.equal(outcomes[1].reason.response.status, 403);
});

for (const state of ['active', 'issuer-valid', 'issuer-mismatch', 'issuer-null', 'refused', 'unsupported', 'unavailable', 'inactive', 'scope-mismatch', 'client-mismatch', 'audience-mismatch', 'extended-expiry', 'malformed']) {
    test('explicit own-SP introspection outcome: ' + state, async () => {
        tokenLifetime = 30;
        const preview = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
        const grant = preview.preview.effectiveGrant, before = requests.length;
        introspectionMode = state;
        const status = await client.checkTokenStatus(approvedConsent.id, source, 'hospital-a', grant.generation);
        const outgoing = requests.slice(before);
        assert.equal(outgoing.filter(request => request.url.startsWith(source)).length, 0);
        assert.equal(outgoing.filter(request => request.url.endsWith('/token')).length, 0);
        assert.equal(outgoing.filter(request => request.url.endsWith('/introspect')).length, 1);
        assert.equal(outgoing.length, 1, 'explicit status uses only introspection, never management tokens or FHIR reads');
        const form = new URLSearchParams(outgoing[0].data), assertion = require('jsonwebtoken').decode(form.get('client_assertion'));
        assert.equal(assertion.sub, config.organizations.serviceProvider.clientId);
        assert.equal(assertion.aud, environmentEndpoints(config.contract.environment).oauthBase + '/introspect');
        assert.equal(form.get('token_type_hint'), 'access_token');
        assert.equal(grant.expiresAt - grant.acquiredAt, 30000);
        if (['active', 'issuer-valid', 'refused', 'unsupported', 'unavailable'].includes(state)) {
            assert.equal(status.state, state === 'issuer-valid' ? 'active' : state); assert.equal(status.authoritative, undefined);
            const reused = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
            assert.equal(reused.preview.effectiveGrant.acquiredAt, grant.acquiredAt);
            assert.equal(reused.preview.effectiveGrant.expiresAt, grant.expiresAt);
        } else {
            assert.equal(status.authoritative, true);
            assert.equal((await client.checkTokenStatus(approvedConsent.id, source, 'hospital-a', grant.generation)).state, 'unavailable');
        }
    });
}
test('a token remains bound to its original validated issuer after an environment switch', async () => {
    const first = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    configure('connectathon-easy', 'production');
    const before = requests.length;
    const status = await client.checkTokenStatus(approvedConsent.id, source, 'hospital-a', first.preview.effectiveGrant.generation);
    assert.equal(status.state, 'invalid'); assert.equal(status.authoritative, true);
    assert.ok(!requests.slice(before).some(request => request.url.endsWith('/introspect')), 'Never send an original credential to a replacement issuer');
});

test('Strict and explicit disabled own-token checks dispatch nothing; foreign generation is not inspected', async () => {
    configure('strict'); requests = [];
    assert.equal((await client.checkTokenStatus(approvedConsent.id, source, 'hospital-a', 'unknown')).state, 'disabled');
    assert.equal(requests.length, 0);
    configure();
    assert.equal(client.ownTokenInspectionCapability({ conformance: { preset: 'connectathon-easy' }, security: { pcmApi: { allowServiceProviderOwnTokenIntrospection: false } } }, { mode: 'connectathon' }).enabled, false);
    assert.equal(client.ownTokenInspectionCapability().enabled, true);
    assert.equal((await client.checkTokenStatus(approvedConsent.id, source, 'hospital-b', 'unknown')).state, 'unavailable');
    assert.equal(requests.length, 0);
});
test('valid different filtered effective grant is accepted without a hidden snapshot comparison', async () => {
    tokenAlteration = value => { value.scope = 'patient/Observation.s?status=final'; };
    const result = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Patient.rs patient/Observation.rs');
    assert.equal(result.preview.effectiveGrant.scope, 'patient/Observation.s?status=final');
    assert.deepEqual(result.preview.actions.map(action => action.type), ['Observation']);
    assert.equal(result.preview.skipped[0].outcome, 'not-granted');
});

test('a different valid grant with no selected search is a selection limitation, not a read-only claim', async () => {
    tokenAlteration = value => { value.scope = 'patient/Patient.s'; };
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s'), error => {
        assert.equal(error.classification, 'query_not_granted'); assert.equal(error.grant.scope, 'patient/Patient.s'); return true;
    });
    assert.ok(!requests.some(request => request.url.startsWith(source)));
});

test('a delayed status denial cannot delete a newly issued replacement token generation', async () => {
    const first = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    let release; statusPause = new Promise(resolve => { release = resolve; }); introspectionMode = 'inactive';
    const pending = client.checkTokenStatus(approvedConsent.id, source, 'hospital-a', first.preview.effectiveGrant.generation);
    await new Promise(resolve => setImmediate(resolve)); client.resetCache();
    const second = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    release(); await pending; statusPause = null;
    const third = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    assert.notEqual(first.preview.effectiveGrant.generation, second.preview.effectiveGrant.generation);
    assert.equal(third.preview.effectiveGrant.generation, second.preview.effectiveGrant.generation);
});
test('authoritative invalidation during a source response prevents publication of that token or results', async () => {
    const first = await client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    let release; sourcePause = new Promise(resolve => { release = resolve; });
    const pending = client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Observation.s');
    // Wait for the actual source request to enter the owned wire adapter.
    const before = requests.filter(request => request.url.startsWith(source)).length;
    while (requests.filter(request => request.url.startsWith(source)).length === before) await new Promise(resolve => setImmediate(resolve));
    introspectionMode = 'inactive';
    await client.checkTokenStatus(approvedConsent.id, source, 'hospital-a', first.preview.effectiveGrant.generation);
    release(); await assert.rejects(pending, error => error.classification === 'invalid_token_state' && error.grant === undefined); sourcePause = null;
});

test('public Patient/service context changing between preparation and issuance sends no clinical token or source request', async () => {
    let reads = 0;
    consentReadHook = () => { if (++reads === 1) { wireConsent = consent(); wireConsent.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000026' }; } };
    await assert.rejects(client.fetchData(approvedConsent.id, source, 'hospital-a', 'patient/Patient.s'), /context changed during token preparation/);
    assert.ok(!requests.some(request => request.url.startsWith(source)));
    assert.ok(!requests.some(request => request.url.endsWith('/token') && new URLSearchParams(request.data).has('authorization_details')));
});


test('all presets: Doctor consumes the exact wildcard and sends only selected finite public searches without private policy reads', async () => {
    const types = require('../../shared/service-grant').PATIENT_TYPES;
    const selection = types.map(type => `patient/${type}.rs`).join(' ');
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        configure(preset); client.resetCache(); requests = [];
        wireConsent = grantFixture.approve({ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }, 'patient/*.rs'); wireScope = 'patient/*.rs';
        const result = await client.fetchData(wireConsent.id, source, 'hospital-a', selection);
        assert.equal(result.preview.effectiveGrant.scope, 'patient/*.rs');
        assert.deepEqual(requests.filter(request => request.url.startsWith(source)).map(request => new URL(request.url).pathname.split('/').at(-1)), types);
        assert.ok(requests.every(request => !/admin|sandbox|snapshot|private/.test(new URL(request.url).pathname)), 'Doctor uses ordinary public APIs only');
        const tokens = requests.filter(request => request.url.endsWith('/token') && new URLSearchParams(request.data).has('authorization_details'));
        assert.equal(tokens.length, 1); assert.equal(new URLSearchParams(tokens[0].data).get('scope'), selection);
    }
});
