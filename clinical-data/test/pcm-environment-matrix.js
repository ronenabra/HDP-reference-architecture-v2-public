'use strict';

/** Locally qualify exact logical endpoints and lifetime bounds under actual public mTLS. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json'));
const certs = process.env.PCM_MATRIX_CERTS_DIR || '/runtime/certs';
const base = config.contract.operational.fhirBase;
const transport = config.internalBaseUrls.pcmAuth;
const role = config.certificateRoles.serviceProvider;
const tls = { ca: fs.readFileSync(path.join(certs, config.certificates.rootCaCert)), cert: fs.readFileSync(path.join(certs, role.mtls.cert)), key: fs.readFileSync(path.join(certs, role.mtls.key)) };

/** Send one bounded request without redirect or logical-host network access. */
function request(suffix, { method = 'GET', body, bearer, anonymous = false } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? new URLSearchParams(body).toString() : undefined;
        const req = https.request(`${transport}${suffix}`, { ...(anonymous ? { ca: tls.ca } : tls), method,
            headers: { Accept: 'application/fhir+json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('Oversized response')); });
            res.on('end', () => { let json; try { json = JSON.parse(text); } catch (_) { /* HEAD has no body */ } resolve({ status: res.statusCode, json }); });
        });
        req.setTimeout(10000, () => req.destroy(new Error('Timed out')));
        req.on('error', reject); req.end(payload);
    });
}

/** Sign a new authentication-only assertion for every request, including negative probes. */
function form(overrides = {}, audience = `${base}/token`) {
    const now = Math.floor(Date.now() / 1000);
    const clientId = config.organizations.serviceProvider.clientId;
    return { grant_type: 'client_credentials', scope: 'system/*.crus', resource: base,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: jwt.sign({ iss: clientId, sub: clientId, aud: audience, iat: now, exp: now + 120, jti: crypto.randomUUID() },
            fs.readFileSync(path.join(certs, role.assertion.key)), { algorithm: 'ES256', header: { typ: 'JWT', kid: require(fs.existsSync('/shared') ? '/shared/assertion-keys' : '../../src/shared/assertion-keys').jwkThumbprint(fs.readFileSync(path.join(certs, role.assertion.key))) } }), ...overrides };
}

/** Observe both metadata forms, protected Contract routes and exact token semantics. */
async function main() {
    assert.equal(config.conformance.preset, 'strict', 'environment acceptance requires strict controls');
    for (const suffix of ['/.well-known/smart-configuration', '/.well-known/oauth-authorization-server']) {
        const metadata = await request(suffix);
        assert.equal(metadata.status, 200, JSON.stringify(metadata));
        assert.equal(metadata.json.token_endpoint, `${base}/token`);
        assert.ok(metadata.json.authorization_details_types_supported.includes('https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access'));
    }
    const issued = await request('/token', { method: 'POST', body: form() });
    assert.equal(issued.status, 200, JSON.stringify(issued));
    assert.equal(issued.json.expires_in, config.contract.environment === 'production' ? 30 : 86400);
    const bearer = issued.json.access_token;
    const get = await request('/Contract?_count=1', { bearer });
    const post = await request('/Contract/_search', { method: 'POST', bearer, body: { _count: '1' } });
    assert.equal(get.status, 200); assert.equal(post.status, 200);
    assert.equal(get.json.type, 'searchset'); assert.equal(post.json.type, 'searchset');
    assert.equal((await request('/Contract/missing', { bearer })).status, 404);
    assert.equal((await request('/Contract/missing', { method: 'HEAD', bearer })).status, 404);
    for (const resource of [`${base}/`, base.replace('pcm2mtest.', 'pcm2m.').replace('pcm2m.', config.contract.environment === 'test' ? 'pcm2m.' : 'pcm2mtest.')]) {
        const denied = await request('/token', { method: 'POST', body: form({ resource }) });
        assert.equal(denied.json.error, 'invalid_target');
    }
    const audience = await request('/token', { method: 'POST', body: form({}, `${base}/token/`) });
    assert.equal(audience.json.error, 'invalid_client');
    for (const suffix of ['/Contract', '/.well-known/smart-configuration', '/token']) {
        const anonymous = await request(suffix, { anonymous: true }).catch(() => ({ status: 0 }));
        assert.ok(anonymous.status === 0 || anonymous.status >= 400, 'missing mTLS must fail');
    }
    const result = { scenarios: [{ id: `strict-${config.contract.environment}-endpoints-lifetimes`, executed: true, status: 'pass', expiresIn: issued.json.expires_in }], conformanceExceptions: config.contract.conformanceExceptions };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
