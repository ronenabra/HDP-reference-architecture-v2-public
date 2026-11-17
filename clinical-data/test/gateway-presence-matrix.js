'use strict';

/**
 * Exercise strict online and batch presence through the public gateway path.
 *
 * Unlike the direct-HAPI matrix, this test obtains opaque access tokens from
 * PCM and therefore proves the complete mTLS -> introspection -> local-JWT ->
 * HAPI chain. Run it from a disposable container attached only to pcm-net.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { assertLegacyCapability, assertAnonymousDenied } = require('./gateway-presence-contract');

const CERTS_DIR = process.env.PCM_MATRIX_CERTS_DIR || '/runtime/certs';
const TOKEN_ENDPOINT = process.env.PCM_MATRIX_TOKEN_ENDPOINT || 'https://pcm-core:3000/api/fhir-service/r4/token';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const CLIENT_ID = 'pcm-presence-orchestrator';
const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json', 'utf8'));
const TOKEN_AUDIENCE = `${config.contract.operational.oauthBase}/token`;
const HTEST_SYSTEM = 'http://fhir.health.gov.il/identifier/il-hdp-test-id';
const NATIONAL_ID_SYSTEM = 'http://fhir.health.gov.il/identifier/il-national-id';
const HOS = Object.freeze(['ho-a', 'ho-b', 'ho-c']);

const tls = Object.freeze({
    ca: fs.readFileSync(path.join(CERTS_DIR, 'rootCA.crt')),
    cert: fs.readFileSync(path.join(CERTS_DIR, 'presence-orchestrator.crt')),
    key: fs.readFileSync(path.join(CERTS_DIR, 'presence-orchestrator.key')),
    rejectUnauthorized: true
});

/** Send an HTTPS request using the registered presence-orchestrator identity. */
function request(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined
            ? null
            : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = https.request(url, {
            ...tls,
            method,
            headers: {
                Accept: 'application/fhir+json',
                'X-Flow-Id': crypto.randomUUID(),
                ...(payload === null ? {} : {
                    'Content-Type': typeof body === 'string'
                        ? 'application/x-www-form-urlencoded'
                        : 'application/fhir+json',
                    'Content-Length': Buffer.byteLength(payload)
                }),
                ...headers
            }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = JSON.parse(text); } catch (_error) { /* retain raw diagnostics */ }
                resolve({ status: response.statusCode, body: parsed, text });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/** Create the strict ES256 private_key_jwt used at PCM's token endpoint. */
function clientAssertion(claims = {}, signingKey = null) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
        iss: CLIENT_ID,
        sub: CLIENT_ID,
        aud: TOKEN_AUDIENCE,
        iat: now,
        exp: now + 120,
        jti: crypto.randomUUID(),
        ...claims
    }, signingKey || fs.readFileSync(path.join(CERTS_DIR, 'presence-orchestrator-assertion.key')), {
        algorithm: 'ES256',
        header: { alg: 'ES256', typ: 'JWT' }
    });
}

/** Send an assertion without hiding failures behind the happy-path token helper. */
async function issueToken(ho, patients, assertion = clientAssertion(), resource = `https://${ho}-gateway:8080/fhir`) {
    const form = new URLSearchParams({
        grant_type: 'client_credentials', client_assertion_type: ASSERTION_TYPE,
        client_assertion: assertion, scope: 'system/Patient.s', resource,
        authorization_details: JSON.stringify([{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access', fhirContext: [
            { type: 'Contract', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis', identifier: {
                system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001'
            } }, ...patients.map(identifier => ({ type: 'Patient', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient', identifier }))
        ] }])
    });
    return request(TOKEN_ENDPOINT, { method: 'POST', body: form.toString() });
}

/** Obtain one HO-bound opaque presence token from PCM. */
async function token(ho, scope) {
    const result = await issueToken(ho, scope);
    assert.equal(result.status, 200, `${ho} token issuance: ${result.text}`);
    assert.equal(result.body.token_type, 'Bearer');
    assert.ok(result.body.access_token);
    return result.body.access_token;
}

/** Prove denial at PCM using actual signed requests and retain a warm token for expiry. */
async function tokenBoundary() {
    const scope = scopeFor([{ system: HTEST_SYSTEM, value: '1' }]);
    const assertion = clientAssertion();
    const startedAt = Date.now();
    const issued = await issueToken('ho-a', scope, assertion);
    assert.equal(issued.status, 200, 'token-boundary setup must obtain a real token');
    assert.ok(Number.isSafeInteger(issued.body.expires_in) && issued.body.expires_in > 0);
    const replay = await issueToken('ho-a', scope, assertion);
    assert.ok([400, 401, 403].includes(replay.status), `assertion replay must fail: ${replay.status}`);
    const wrongAudience = await issueToken('ho-a', scope, clientAssertion({ aud: `${TOKEN_AUDIENCE}/wrong` }));
    assert.ok([400, 401, 403].includes(wrongAudience.status), `bad assertion audience must fail: ${wrongAudience.status}`);
    const independent = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const wrongSignature = await issueToken('ho-a', scope, clientAssertion({}, independent));
    assert.ok([400, 401, 403].includes(wrongSignature.status), `unregistered ES256 signature must fail: ${wrongSignature.status}`);
    const expiredAssertion = await issueToken('ho-a', scope, clientAssertion({ iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 }));
    assert.ok([400, 401, 403].includes(expiredAssertion.status), `expired assertion must fail: ${expiredAssertion.status}`);
    const uri = `/fhir/Patient?identifier=${encodeURIComponent(`${HTEST_SYSTEM}|1`)}&_summary=count&_count=0`;
    const warm = await gatewayRequest('ho-a', issued.body.access_token, uri);
    assert.equal(warm.status, 200, 'expiry setup must warm the public gateway with an active token');
    assert.equal(warm.body.total, 1);
    return { accessToken: issued.body.access_token, expiresAt: startedAt + issued.body.expires_in * 1000 + 2000, uri };
}

function scopeFor(identifiers) {
    return identifiers;
}

function presenceEntry(value) {
    const identifier = encodeURIComponent(`${HTEST_SYSTEM}|${value}`);
    return { request: { method: 'GET', url: `Patient?identifier=${identifier}&_summary=count&_count=0` } };
}

async function gatewayRequest(ho, tokenValue, requestPath, options = {}) {
    return request(`https://${ho}-gateway:8080${requestPath}`, {
        ...options,
        headers: { Authorization: `Bearer ${tokenValue}`, ...(options.headers || {}) }
    });
}

async function assertDenied(result, label) {
    assert.ok([400, 401, 403, 405, 413].includes(result.status), `${label}: ${result.status} ${result.text}`);
    assert.equal(result.text.includes('Synthetic HTEST'), false, `${label} leaked patient data`);
}

/** Prove positive, absent, malformed, wrong-operation, and cross-HO cases. */
async function runHo(ho) {
    const htestOne = { system: HTEST_SYSTEM, value: '1' };
    const htestTwo = { system: HTEST_SYSTEM, value: '2' };
    const absent = { system: NATIONAL_ID_SYSTEM, value: '000000026' };
    const onlineScope = scopeFor([htestOne]);
    const onlineToken = await token(ho, onlineScope);
    for (const [identifierValue, total] of [[htestOne, 1], [absent, 0]]) {
        const scopedToken = identifierValue === htestOne
            ? onlineToken
            : await token(ho, scopeFor([identifierValue]));
        const identifier = encodeURIComponent(`${identifierValue.system}|${identifierValue.value}`);
        const result = await gatewayRequest(ho, scopedToken,
            `/fhir/Patient?identifier=${identifier}&_summary=count&_count=0`);
        assert.equal(result.status, 200, `${ho} online ${identifierValue.value}: ${result.text}`);
        assert.equal(result.body.resourceType, 'Bundle');
        assert.equal(result.body.type, 'searchset');
        assert.equal(result.body.total, total);
        assert.deepEqual(result.body.entry || [], []);
        assert.equal(result.text.includes('Synthetic HTEST'), false);
    }

    const onlineIdentifier = encodeURIComponent(`${HTEST_SYSTEM}|1`);
    await assertDenied(await gatewayRequest(ho, onlineToken,
        `/fhir/Patient?identifier=${onlineIdentifier}&_summary=count&_count=0&name=forbidden`),
    `${ho} online extra query`);
    await assertDenied(await gatewayRequest(ho, onlineToken,
        `/fhir/Patient?identifier=${encodeURIComponent(HTEST_SYSTEM + '|2')}&_summary=count&_count=0`), `${ho} substituted Patient identifier`);
    await assertDenied(await gatewayRequest(ho, onlineToken, '/fhir/Observation?_count=1'), `${ho} presence is not clinical scope`);
    await assertDenied(await gatewayRequest(ho, onlineToken, '/fhir/Patient', { method: 'POST', body: { resourceType: 'Patient' } }), `${ho} public writes remain denied`);

    const batchToken = await token(ho, scopeFor([htestOne, htestTwo]));
    const batch = await gatewayRequest(ho, batchToken, '/fhir', {
        method: 'POST',
        body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry('1'), presenceEntry('2')] }
    });
    assert.equal(batch.status, 200, `${ho} batch: ${batch.text}`);
    assert.equal(batch.body.type, 'batch-response');
    assert.deepEqual(batch.body.entry.map(entry => entry.response.status), ['200', '200']);
    assert.deepEqual(batch.body.entry.map(entry => entry.resource.total), [1, 1]);
    assert.ok(batch.body.entry.every(entry => (entry.resource.entry || []).length === 0));
    assert.equal(batch.text.includes('Synthetic HTEST'), false);

    const isolated = await gatewayRequest(ho, batchToken, '/fhir', {
        method: 'POST', body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry('3'), presenceEntry('2')] }
    });
    assert.equal(isolated.status, 200, `${ho} isolated entries: ${isolated.text}`);
    assert.deepEqual(isolated.body.entry.map(entry => entry.response.status), ['403', '200']);
    await assertDenied(await gatewayRequest(ho, batchToken, '/fhir', {
        method: 'POST', body: { resourceType: 'Bundle', type: 'batch', entry: [presenceEntry('1')], padding: 'x'.repeat(config.presence.batch.maxPayloadBytes) }
    }), `${ho} configured payload limit`);
    await assertDenied(await gatewayRequest(ho, batchToken, '/fhir', {
        method: 'POST',
        body: { resourceType: 'Bundle', type: 'transaction', entry: [presenceEntry('1')] }
    }), `${ho} transaction under batch token`);

    const foreignHo = HOS[(HOS.indexOf(ho) + 1) % HOS.length];
    await assertDenied(await gatewayRequest(foreignHo, onlineToken,
        `/fhir/Patient?identifier=${onlineIdentifier}&_summary=count&_count=0`),
    `${ho} token at ${foreignHo}`);

    console.log(`PASS ${ho} gateway online/batch presence and isolation`);
}

async function main() {
    const scenarios = [];
    // System entitlement never implies clinical Consent authority, even in easy mode.
    const clinicalDenial = await request(TOKEN_ENDPOINT, { method: 'POST', body: new URLSearchParams({
        grant_type: 'client_credentials', client_assertion_type: ASSERTION_TYPE, client_assertion: clientAssertion(),
        scope: 'patient/Observation.s', resource: config.healthOrganizations[0].endpoint,
        authorization_details: JSON.stringify([{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access', fhirContext: [{
            type: 'Consent', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis', identifier: {
                system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'PCM-CONSENT-NO-SYSTEM-PRIVILEGE'
            }
        }] }])
    }).toString() });
    assert.ok([400, 401].includes(clinicalDenial.status), 'presence entitlement cannot authorize clinical Consent');
    assert.equal(clinicalDenial.body.error, 'unauthorized_client');
    scenarios.push({ id: 'system-client-clinical-privilege-denied', status: 'pass', executed: true });
    const easy = config.conformance.preset === 'connectathon-easy';
    const boundary = easy ? null : await tokenBoundary();
    if (boundary) scenarios.push({ id: 'token-assertion-boundary', status: 'pass', executed: true, probes: ['replay', 'audience', 'unregistered-signature', 'expiry'] });
    for (const ho of HOS) {
        assertAnonymousDenied(await request(`https://${ho}-gateway:8080/fhir/Observation?_count=1`), ho);
        await assertDenied(await request(`https://${ho}-gateway:8080/fhir`, { method: 'POST', body: { resourceType: 'Bundle', type: 'transaction', entry: [] } }), `${ho} anonymous public writes remain denied`);
        await runHo(ho);
        scenarios.push({ id: `gateway-${ho}`, status: 'pass', executed: true, mode: 'enforced-online-batch-isolation' });
    }
    if (config.conformance.preset === 'strict') {
        const remaining = Math.max(0, boundary.expiresAt - Date.now());
        assert.ok(remaining <= 35000, 'strict expiry probe must remain a bounded 30-second token test');
        if (remaining) await new Promise(resolve => setTimeout(resolve, remaining));
        await assertDenied(await gatewayRequest('ho-a', boundary.accessToken, boundary.uri), 'expired warm opaque token');
        scenarios.push({ id: 'gateway-token-expiry', status: 'pass', executed: true });
    }
    if (config.legacyDataSource?.enabled) {
        // Health remains diagnostic; a valid presence decision cannot supply this source's missing matcher.
        const health = await request(new URL('/healthz', config.legacyDataSource.internalFhirBaseUrl).href);
        assert.equal(health.status, 200); assert.equal(health.body.service, 'ds-gateway'); assert.equal(health.body.status, 'ok');
        assertAnonymousDenied(await request(`${config.legacyDataSource.internalFhirBaseUrl}/Observation`), 'legacy');
        const response = await request(`${config.legacyDataSource.internalFhirBaseUrl}/Observation`, {
            headers: { Authorization: `Bearer ${await token('ho-a', scopeFor([{ system: HTEST_SYSTEM, value: '1' }]))}` }
        });
        assert.ok([401, 403].includes(response.status), 'legacy must reject a token belonging to another source');
        assertAnonymousDenied(response, 'legacy foreign-source token');
        assert.notEqual(response.body?.issue?.[0]?.code, 'not-supported', 'foreign-source token must not reach legacy capability dispatch');
        const issued = await issueToken('legacy', [{ system: HTEST_SYSTEM, value: '1' }], clientAssertion(), config.legacyDataSource.internalFhirBaseUrl);
        assert.equal(issued.status, 200, issued.text); assert.equal(issued.body.token_type, 'Bearer'); assert.ok(issued.body.access_token);
        const own = await request(`${config.legacyDataSource.internalFhirBaseUrl}/Patient?identifier=${encodeURIComponent(HTEST_SYSTEM + '|1')}&_summary=count&_count=0`, { headers: { Authorization: `Bearer ${issued.body.access_token}` } });
        assertLegacyCapability(own);
        scenarios.push({ id: 'legacy-compatibility', status: 'pass', executed: true });
    }
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify({ preset: config.conformance.preset, scenarios }, null, 2));
    console.log('THREE-HO GATEWAY SCENARIOS PASS');
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main };
