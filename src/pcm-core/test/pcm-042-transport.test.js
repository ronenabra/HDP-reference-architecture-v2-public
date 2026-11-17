'use strict';
/** Actual strict TLS dispatch and once-decoded GET/POST authorization requests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { startRuntime } = require('../../../test-support/pcm-042-runtime');
const { PCM_PATH } = require('../../shared/pcm-environment');
const { createClientAssertion, pkceChallenge } = require('../../sp-client/src/oauth');
const { CLIENT_ASSERTION_TYPE } = require('../src/client-assertion');

/** Use trusted server verification, optional independently registered client credentials. */
function request(runtime, route, { method = 'GET', body = '', cert = false, headers = {} } = {}) {
    const directory = process.env.CERTS_DIR;
    const transport = cert === true ? 'sp-client-assertion' : cert === 'untrusted' ? 'untrusted-client' : cert;
    return new Promise((resolve, reject) => {
        const req = https.request(`https://localhost:${runtime.api.address().port}${route}`, {
            method, ca: fs.readFileSync(path.join(directory, 'rootCA.crt')),
            ...(cert ? { cert: fs.readFileSync(path.join(directory, `${transport}.crt`)),
                key: fs.readFileSync(path.join(directory, `${transport}.key`)) } : {}),
            headers: { ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers }
        }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json() { return JSON.parse(text); } }));
        });
        req.on('error', reject); req.end(body);
    });
}

/** Build one complete once-encoded authorization form with caller-selected edge cases. */
function parameters(runtime, changes = {}) {
    return new URLSearchParams({ response_type: 'code', client_id: runtime.config.organizations.serviceProvider.clientId,
        redirect_uri: `${runtime.doctorBase}/callback`, scope: 'patient/Observation.rs?code=a&status=final', state: 'state&literal=%26',
        code_challenge: pkceChallenge('A'.repeat(43)), code_challenge_method: 'S256', aud: runtime.endpoints.fhirBase, ...changes }).toString();
}

test('strict actual API boundary, discovery aliases and GET/POST parity across preset reload', async t => {
    const runtime = await startRuntime(); t.after(() => runtime.close());
    const ui = http.createServer(require('../src/index').createUiApp());
    await new Promise(resolve => ui.listen(0, resolve));
    t.after(() => new Promise(resolve => { ui.closeAllConnections?.(); ui.close(resolve); }));
    const uiUrl = `http://localhost:${ui.address().port}/sandbox/authentication`;
    const redirectedLogin = await fetch(uiUrl, { redirect: 'manual' });
    assert.equal(redirectedLogin.status, 308);
    assert.equal(redirectedLogin.headers.get('location'), `${new URL(runtime.apiBase).origin}/sandbox/authentication`);
    assert.equal((await fetch(uiUrl + '/start', { method: 'POST' })).status, 401);
    const backend = [ `${PCM_PATH}/token`, `${PCM_PATH}/introspect`, `${PCM_PATH}/metadata`, `${PCM_PATH}/Organization`,
        `${PCM_PATH}/.well-known/smart-configuration`, `${PCM_PATH}/.well-known/oauth-authorization-server`,
        `/.well-known/oauth-authorization-server${PCM_PATH}`, `/.well-known/oauth-authorization-server${PCM_PATH}/`,
        `${PCM_PATH}/authorize/`, `${PCM_PATH}//authorize`, `${PCM_PATH}/%61uthorize`, `${PCM_PATH}/Authorize`,
        `${PCM_PATH}/authorize/decision/`, '/sandbox/authentication/', '/sandbox/authentication/unknown', '/sandbox/authentication/discover/', '/assets/../api/fhir-service/r4/metadata', '/unknown', '/jwks', '/register' ];
    for (const route of backend) {
        const result = await request(runtime, route);
        assert.equal(result.status, 401, route);
    }
    assert.equal((await request(runtime, '/sandbox/authentication')).status, 200);
    const unbound = await request(runtime, '/sandbox/authentication/start', { method: 'POST', body: 'identifier=untrusted' });
    assert.equal(unbound.status, 303); assert.equal(unbound.headers.location, '/sandbox/authentication');
    assert.equal((await request(runtime, `${PCM_PATH}/metadata`, { cert: 'untrusted' })).status, 401);
    assert.equal((await request(runtime, `${PCM_PATH}/metadata`, { headers: { 'x-ssl-client-verify': 'SUCCESS' } })).status, 401);
    for (const route of [`${PCM_PATH}/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server${PCM_PATH}`, `${PCM_PATH}/.well-known/smart-configuration`]) {
        const response = await request(runtime, route, { cert: true });
        assert.equal(response.status, 200, route);
        const value = response.json();
        assert.deepEqual(value.token_endpoint_auth_signing_alg_values_supported, ['ES256', 'ES384']);
        assert.deepEqual(value.introspection_endpoint_auth_signing_alg_values_supported, ['ES256', 'ES384']);
        assert.equal(value.issuer, runtime.endpoints.fhirBase);
        assert.equal(value.jwks_uri, undefined);
    }
    for (const changes of [{}, { code_challenge_method: 'plain' }, { aud: runtime.endpoints.fhirBase.replace('pcm2mtest', 'pcm2m') },
        { redirect_uri: `${runtime.doctorBase}/callback/evil` }, { scope: 'patient/Observation.rs%253Fcode%253Da' }, { state: '' }, { client_assertion: 'prohibited' }]) {
        const body = parameters(runtime, changes);
        const get = await request(runtime, `${PCM_PATH}/authorize?${body}`);
        const post = await request(runtime, `${PCM_PATH}/authorize`, { method: 'POST', body });
        assert.equal(post.status, get.status, JSON.stringify(changes));
        assert.equal(post.headers.location, get.headers.location);
        if (!Object.keys(changes).length) {
            assert.equal(get.status, 200); assert.match(get.text, /code=a&amp;status=final/);
        }
    }
    for (const missing of ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'aud']) {
        const incomplete = new URLSearchParams(parameters(runtime));
        incomplete.delete(missing);
        const get = await request(runtime, `${PCM_PATH}/authorize?${incomplete}`);
        const post = await request(runtime, `${PCM_PATH}/authorize`, { method: 'POST', body: incomplete.toString() });
        assert.equal(post.status, get.status, `missing ${missing}`);
        assert.ok([302, 400].includes(get.status), `missing ${missing} denied`);
        assert.equal(post.headers.location, get.headers.location);
    }
    for (const body of [parameters(runtime) + '&state=duplicate', parameters(runtime) + '&%73tate=duplicate', 'state=%ZZ', 'state=%FF']) {
        for (const method of ['GET', 'POST']) {
            const response = await request(runtime, `${PCM_PATH}/authorize${method === 'GET' ? `?${body}` : ''}`, { method, body: method === 'POST' ? body : '' });
            assert.equal(response.status, 400, `${method} ${body}`);
        }
    }
    assert.equal((await request(runtime, `${PCM_PATH}/authorize`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 400);
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        const policy = runtime.preset(preset);
        assert.equal(policy.simulation.preset, preset);
        const protectedRoute = await request(runtime, `${PCM_PATH}/.well-known/oauth-authorization-server`);
        assert.equal(protectedRoute.status, ['strict', 'connectathon-mtls'].includes(preset) ? 401 : 200, preset);
        assert.equal((await request(runtime, `${PCM_PATH}/authorize?${parameters(runtime)}`)).status, 200, preset);
    }
    // Pair per-source signature controls after warm, valid calls and persisted reloads.
    runtime.preset('connectathon-balanced');
    assert.equal((await fetch(uiUrl, { redirect: 'manual' })).status, 200);
    const store = require('../src/fhir/store');
    const organizationType = 'http://pcm.fhir.health.gov.il/cs/pcm-org-type';
    for (const source of runtime.config.healthOrganizations.slice(0, 2)) {
        store.add({ resourceType: 'Organization', id: source.parentOrganization.id, active: true,
            identifier: [{ use: 'official', ...source.parentOrganization.businessIdentifier }],
            type: [{ coding: [{ system: organizationType, code: 'parent-org' }] }] });
        store.add({ resourceType: 'Organization', id: source.dataSourceOrganization.id, active: true,
            identifier: [{ use: 'official', ...source.dataSourceOrganization.businessIdentifier }],
            type: [{ coding: [{ system: organizationType, code: 'source' }] }], partOf: { reference: `Organization/${source.parentOrganization.id}` },
            endpoint: [{ reference: `Endpoint/${source.endpointId}` }] });
        store.add({ resourceType: 'Endpoint', id: source.endpointId, status: 'active', address: source.endpoint,
            managingOrganization: { reference: `Organization/${source.dataSourceOrganization.id}` } });
    }
    const [first, second] = runtime.config.healthOrganizations;
    const sourceAssertion = (source, wrong = false) => createClientAssertion({ clientId: source.clientId,
        audience: runtime.endpoints.introspectionEndpoint, privateKey: fs.readFileSync(path.join(process.env.CERTS_DIR,
            wrong ? 'sp-client-assertion.key' : source.certificates.gatewayAssertionKey)) });
    const introspect = assertion => request(runtime, `${PCM_PATH}/introspect`, { method: 'POST',
        cert: runtime.config.healthOrganizations.find(source => source.clientId === jwt.decode(assertion).iss).certificates.gatewayMtlsCert.replace(/\.crt$/, ''),
        body: new URLSearchParams({ token: 'unknown-subject', client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion }).toString() });
    const warmedAssertion = sourceAssertion(first);
    const warmed = await introspect(warmedAssertion);
    assert.equal(warmed.status, 200, warmed.text);
    assert.equal((await introspect(sourceAssertion(second))).status, 200);
    const { saveTeamConfig, getEffectiveConformancePolicy } = require('../src/team-config');
    runtime.config.securitySimulation.perSource[first.id] = { clientAssertionSignature: false };
    saveTeamConfig(runtime.config);
    assert.equal(getEffectiveConformancePolicy().simulation.perSource[first.id].clientAssertionSignature, false);
    assert.equal((await introspect(sourceAssertion(first, true))).status, 200);
    assert.equal((await introspect(sourceAssertion(second, true))).status, 401);
    assert.equal((await introspect(warmedAssertion)).status, 401, 'policy reload preserves replay evidence');
    runtime.config.securitySimulation.perSource[first.id].clientAssertionSignature = true;
    saveTeamConfig(runtime.config);
    assert.equal((await introspect(sourceAssertion(first, true))).status, 401);
    assert.equal((await introspect(sourceAssertion(second))).status, 200);
    runtime.preset('strict');
    const rejectedOverride = structuredClone(runtime.config);
    rejectedOverride.securitySimulation.perSource[first.id] = { clientAssertionSignature: false };
    assert.throws(() => saveTeamConfig(rejectedOverride), /strict/i);
    const rollover = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const publicKeyFile = path.join(path.dirname(process.env.TEAM_CONFIG_PATH), 'approved-p384.crt');
    const privateKeyFile = path.join(path.dirname(process.env.TEAM_CONFIG_PATH), 'approved-p384.key');
    fs.writeFileSync(privateKeyFile, rollover.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const certificate = spawnSync('openssl', ['req', '-new', '-x509', '-key', privateKeyFile, '-subj', '/CN=approved-assertion-p384', '-days', '2', '-out', publicKeyFile], { encoding: 'utf8' });
    assert.equal(certificate.status, 0, certificate.stderr);
    runtime.config.healthOrganizations[0].assertionCertificates = { ES384: publicKeyFile };
    saveTeamConfig(runtime.config);
    for (const kid of [false, true]) {
        const assertion = kid ? createClientAssertion({ clientId: first.clientId, audience: runtime.endpoints.introspectionEndpoint, privateKey: rollover.privateKey })
            : jwt.sign({ iss: first.clientId, sub: first.clientId, aud: runtime.endpoints.introspectionEndpoint, jti: crypto.randomUUID() }, rollover.privateKey,
                { algorithm: 'ES384', expiresIn: 300, header: { typ: 'JWT' } });
        assert.equal((await introspect(assertion)).status, 200, `strict direct ES384 kid=${kid}`);
    }
    const dsAssertion = createClientAssertion({ clientId: first.clientId, audience: runtime.endpoints.tokenEndpoint, privateKey: rollover.privateKey });
    const credential = await request(runtime, `${PCM_PATH}/token`, { method: 'POST', cert: first.certificates.gatewayMtlsCert.replace(/\.crt$/, ''), body: new URLSearchParams({
        grant_type: 'client_credentials', scope: 'system/*.crus', resource: runtime.endpoints.introspectionEndpoint,
        client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: dsAssertion }).toString() });
    assert.equal(credential.status, 200, credential.text);
    const bearerCall = { method: 'POST', body: 'token=unknown-subject', headers: { Authorization: `Bearer ${credential.json().access_token}` } };
    assert.equal((await request(runtime, `${PCM_PATH}/introspect`, bearerCall)).status, 401);
    assert.equal((await request(runtime, `${PCM_PATH}/introspect`, { ...bearerCall, cert: true })).status, 200);


    // Successful signed code exchange proves signing and TLS certificate identities remain distinct.
    const started = await request(runtime, `${PCM_PATH}/authorize?${parameters(runtime, { scope: 'patient/Observation.rs' })}`);
    const transaction = /name="transaction_id" value="([^"]+)"/.exec(started.text)[1];
    const decision = await request(runtime, `${PCM_PATH}/authorize/decision`, { method: 'POST',
        headers: { Cookie: started.headers['set-cookie'].map(value => value.split(';')[0]).join('; ') },
        body: new URLSearchParams({ transaction_id: transaction,
        decision: 'approve', patient: 'configured-patient-1', approved_scope: 'patient/Observation.rs' }).toString() });
    assert.equal(decision.status, 302);
    const callback = new URL(decision.headers.location);
    const assertion = createClientAssertion({ clientId: runtime.config.organizations.serviceProvider.clientId,
        audience: runtime.endpoints.tokenEndpoint, privateKey: fs.readFileSync(path.join(process.env.CERTS_DIR, 'sp-client-assertion.key')) });
    const tokenForm = new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code'),
        redirect_uri: `${runtime.doctorBase}/callback`, code_verifier: 'A'.repeat(43), client_assertion: assertion, client_assertion_type: CLIENT_ASSERTION_TYPE }).toString();
    assert.equal((await request(runtime, `${PCM_PATH}/token`, { method: 'POST', body: tokenForm })).status, 401);
    const exchange = await request(runtime, `${PCM_PATH}/token`, { method: 'POST', cert: true, body: tokenForm });
    assert.equal(exchange.status, 200, exchange.text);
    assert.equal(exchange.json().token_type, 'Bearer');
});
