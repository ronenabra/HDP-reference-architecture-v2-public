'use strict';

/** Actual local OAuth/SMART and Contract projection qualification in each preset. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json'));
const certificates = process.env.PCM_MATRIX_CERTS_DIR || '/runtime/certs';
const shared = name => require(fs.existsSync('/shared') ? `/shared/${name}` : `../../src/shared/${name}`);
const policy = shared('conformance-policy').buildEffectivePolicy(config, process.env);
const role = config.certificateRoles.serviceProvider;
const read = name => fs.readFileSync(path.join(certificates, name));

/** Request only configured private transport; logical national URLs are assertion values. */
function request(suffix, { method = 'GET', body, bearer, anonymous = false, credentials = role.mtls } = {}) {
    return new Promise((resolve, reject) => {
        const bytes = body === undefined ? undefined : new URLSearchParams(body).toString();
        const url = new URL(config.internalBaseUrls.pcmAuth);
        const req = https.request({ hostname: url.hostname, port: url.port, path: suffix.startsWith('/.well-known/oauth-authorization-server/api/') ? suffix : `${url.pathname}${suffix}`, method,
            ca: read(config.certificates.rootCaCert), ...(anonymous ? {} : { cert: read(credentials.cert), key: read(credentials.key) }),
            headers: { accept: 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(bytes === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(bytes) }) } }, response => {
            let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 2e6) req.destroy(new Error('release matrix response too large')); });
            response.on('end', () => { let json; try { json = JSON.parse(text); } catch (_) { /* HTML authorize response is expected. */ } resolve({ status: response.statusCode, json, text, headers: response.headers }); });
        });
        req.setTimeout(15000, () => req.destroy(new Error('release matrix timeout'))); req.on('error', reject); req.end(bytes);
    });
}

/** Sign with one explicitly registered curve/key and the exact RFC7638 selection identity. */
function assertion(algorithm, { kid, omitKid = false, claims = {} } = {}) {
    const key = read(algorithm === 'ES384' ? 'sp-client-assertion-es384.key' : role.assertion.key);
    const now = Math.floor(Date.now() / 1000), client = config.organizations.serviceProvider.clientId;
    return jwt.sign({ iss: client, sub: client, aud: `${config.contract.operational.oauthBase}/token`, iat: now, exp: now + 120, jti: crypto.randomUUID(), ...claims }, key,
        { algorithm, header: { typ: 'JWT', ...(omitKid ? {} : { kid: kid || shared('assertion-keys').jwkThumbprint(key) }) } });
}

/** Return the ordinary management grant, without data RAR or workflow powers. */
function form(value) {
    return { grant_type: 'client_credentials', scope: 'system/*.crus', resource: config.contract.operational.fhirBase,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: value };
}

/** Observe current preset outcomes without enabling controls to obtain a strict result. */
async function main() {
    const scenarios = [], record = (id, detail = {}) => scenarios.push({ id, status: 'pass', executed: true, ...detail });
    let bearer;
    for (const algorithm of ['ES256', 'ES384']) {
        for (const omitKid of [false, true]) {
            const result = await request('/token', { method: 'POST', body: form(assertion(algorithm, { omitKid })) });
            if (omitKid) {
                assert.equal(result.status, 401, `SMART missing kid must deny: ${result.text}`);
            } else {
                assert.equal(result.status, 200, `${algorithm}: ${result.text}`);
                assert.equal(result.json.token_type, 'Bearer'); bearer = result.json.access_token;
            }
        }
    }
    const unknown = await request('/token', { method: 'POST', body: form(assertion('ES384', { kid: 'A'.repeat(43) })) });
    // Disabling the existing signature control also disables registered-key selection.
    // SMART's supplied-kid shape remains independently required.
    const unknownExpected = policy.simulation.controls.clientAssertionSignature ? 401 : 200;
    assert.equal(unknown.status, unknownExpected, unknown.text);
    record('042-signing-key-selection', { algorithms: ['ES256', 'ES384'], smartMissingKid: 401, unknownKid: unknown.status, signatureControl: policy.simulation.controls.clientAssertionSignature });
    const metadata = [];
    for (const suffix of ['/.well-known/smart-configuration', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/fhir-service/r4']) {
        const response = await request(suffix); assert.equal(response.status, 200, response.text);
        assert.equal(response.json.token_endpoint, `${config.contract.operational.oauthBase}/token`);
        const algorithms = response.json.token_endpoint_auth_signing_alg_values_supported;
        assert.ok(algorithms.includes('ES256') && algorithms.includes('ES384')); metadata.push(suffix);
    }
    record('042-metadata-aliases', { paths: metadata });
    const parameters = { response_type: 'code', client_id: config.organizations.serviceProvider.clientId, redirect_uri: config.organizations.serviceProvider.redirectUri,
        scope: 'patient/Observation.rs', state: crypto.randomUUID(), code_challenge: crypto.createHash('sha256').update('A'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', aud: config.contract.operational.fhirBase };
    const get = await request(`/authorize?${new URLSearchParams(parameters)}`, { anonymous: true });
    const post = await request('/authorize', { method: 'POST', body: parameters, anonymous: true });
    assert.ok([200, 302].includes(get.status), get.text); assert.equal(post.status, get.status, post.text);
    const invalid = await request('/authorize', { method: 'POST', body: { ...parameters, code_challenge_method: 'plain' }, anonymous: true });
    assert.equal(invalid.status, 302);
    const denied = new URL(invalid.headers.location);
    assert.equal(denied.searchParams.get('error'), 'invalid_request');
    assert.equal(denied.searchParams.has('code'), false);
    assert.equal(denied.searchParams.get('state'), parameters.state);
    record('042-smart-get-post', { get: get.status, post: post.status, invalidPkce: invalid.status, certificateFree: true });
    const hidden = await request('/Contract?_count=100', { bearer }); assert.equal(hidden.status, 200, hidden.text);
    assert.ok((hidden.json.entry || []).every(entry => entry.resource.subType?.[0]?.coding?.[0]?.code === 'sandbox-patient-sample'), 'ordinary SP cannot see PCM-only normative Contracts');
    assert.equal((await request('/Contract/policy-presence', { bearer })).status, 404);
    const source = config.healthOrganizations[0], key = read(source.certificates.gatewayAssertionKey), now = Math.floor(Date.now() / 1000);
    const sourceAssertion = jwt.sign({ iss: source.clientId, sub: source.clientId, aud: `${config.contract.operational.oauthBase}/token`, iat: now, exp: now + 120, jti: crypto.randomUUID() }, key, { algorithm: 'ES256', header: { typ: 'JWT' } });
    const credentials = { cert: source.certificates.gatewayMtlsCert, key: source.certificates.gatewayMtlsKey };
    const issued = await request('/token', { method: 'POST', body: form(sourceAssertion), credentials });
    assert.equal(issued.status, 200, 'a registered non-SMART source may omit kid with an unambiguous approved key');
    const contracts = await request('/Contract?_count=100', { bearer: issued.json.access_token, credentials }); assert.equal(contracts.status, 200, contracts.text);
    const visibleWorkflows = require('./workflow-contract-projection').assertWorkflowProjection(
        (contracts.json.entry || []).map(entry => entry.resource), source, config);
    assert.equal((await request('/Contract/_search', { method: 'POST', bearer, body: { _count: '101' } })).status, 400);
    record('042-contract-membership-projection', { visibleWorkflows, unauthorizedSpRead: 404, nonSmartOmittedKid: issued.status, maximumPageBoundary: 400 });
    const notice = policy.mode === 'strict' ? 'Strict normative controls' : 'CONNECTATHON COMPATIBILITY EVIDENCE — NOT CONFORMANT';
    const result = { scenarios, preset: config.conformance.preset, effectiveControls: policy.simulation.controls, notice, source: config.contract };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { assertion, request, form };
