'use strict';
/** Actual immutable clinical decisions, introspection and enforced HAPI requests. */
const fs = require('fs'), path = require('path'), https = require('https'), assert = require('node:assert/strict'), jwt = require('jsonwebtoken'), crypto = require('crypto');
const client = require('/app/src/client');
const config = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
const { savedApproval, rememberApproval, requestCeiling, assertIssuedApproval, approvalCommand, presetCommand } = require('./demo-approval-contract');
const certs = '/runtime/certs';

/** One bounded request with the exact registered transport identity. */
function request(url, { method = 'GET', body, bearer, role = config.certificateRoles.serviceProvider, form = false } = {}) {
    const payload = body ? form ? new URLSearchParams(body).toString() : JSON.stringify(body) : undefined;
    const certificate = role.mtls || { cert: role.gatewayMtlsCert, key: role.gatewayMtlsKey };
    return new Promise((resolve, reject) => {
        // A settings save can gracefully reload NGINX while an idle pooled socket
        // is closing. Each qualification probe owns one fresh TLS attempt; never replay it.
        const req = https.request(url, { method, agent: false, ca: fs.readFileSync(path.join(certs, 'rootCA.crt')), cert: fs.readFileSync(path.join(certs, certificate.cert)), key: fs.readFileSync(path.join(certs, certificate.key)), headers: {
            Accept: 'application/fhir+json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(payload ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/fhir+json' } : {}) } }, response => {
            let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('Oversized response')); });
            response.on('end', () => { let json; try { json = JSON.parse(text); } catch (_) {} resolve({ status: response.statusCode, json }); });
        }); req.setTimeout(15000, () => req.destroy(new Error('Timeout'))); req.on('error', error => {
            error.message = `${method} ${url}: ${error.message}; reusedSocket=${Boolean(req.reusedSocket)}`;
            reject(error);
        }); req.end(payload);
    });
}

/** Request a fresh token instead of using a positive client cache. */
async function issue(consent, scope, sourceIndex = 0) {
    const pending = consent.status === 'proposed';
    // This negative probe must reach PCM before any saved-approval assertion can apply.
    if (pending) assert.notEqual(scope, undefined, 'A proposed Consent rejection probe needs an explicit scope');
    else await observeApproval(consent);
    scope ??= requestCeiling(consent);
    const issued = await request(`${config.internalBaseUrls.pcmAuth}/token`, { method: 'POST', form: true, body: {
        grant_type: 'client_credentials', resource: config.healthOrganizations[sourceIndex].endpoint, scope,
        authorization_details: JSON.stringify(require('/shared/data-authorization-details').consentAuthorizationDetails(consent)),
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: client._test.generateClientAssertion('hospital-a', null, `${config.contract.operational.fhirBase}/token`)
    } });
    if (issued.status === 200) {
        assert.equal(pending, false, 'PCM issued a token for an unapproved proposed Consent');
        assertIssuedApproval(consent, issued.json);
    }
    return issued;
}

/** Registered Data Source introspection keeps audience and signing identity exact. */
async function introspect(token, sourceIndex = 0) {
    const ho = config.healthOrganizations[sourceIndex], now = Math.floor(Date.now() / 1000), audience = `${config.contract.operational.fhirBase}/introspect`;
    const assertion = jwt.sign({ iss: ho.clientId, sub: ho.clientId, aud: audience, iat: now, exp: now + 120, jti: crypto.randomUUID() }, fs.readFileSync(path.join(certs, ho.certificates.gatewayAssertionKey)), { algorithm: 'ES256', header: { typ: 'JWT' } });
    return request(`${config.internalBaseUrls.pcmAuth}/introspect`, { method: 'POST', form: true, role: ho.certificates, body: { token, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion } });
}

/** Save a supported transport profile through protected Admin; clinical authority stays mandatory. */
async function save(options = {}) {
    const response = await fetch(`${config.internalBaseUrls.pcmUi}/admin/config/simulation`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD }, body: JSON.stringify(presetCommand(config, options)), signal: AbortSignal.timeout(15000) });
    const json = await response.json();
    return { status: response.status, json };
}

/** Review a new pending decision explicitly, then read its saved authority through the ordinary client. */
async function approvePending(pending, options) {
    const response = await fetch(`${config.internalBaseUrls.pcmUi}/admin/consents/${pending.id}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD },
        body: JSON.stringify(approvalCommand(pending, options)), signal: AbortSignal.timeout(15000)
    });
    assert.equal(response.status, 200, `explicit approval HTTP${response.status}: ${await response.text()}`);
    const consent = await client.checkConsentStatus(pending.id, 'hospital-a');
    await observeApproval(consent);
    return consent;
}

/** Qualification-only Admin diagnostics stay separate from the independently asserted public protocol. */
async function observeApproval(consent) {
    const response = await fetch(`${config.internalBaseUrls.pcmUi}/admin/consents`, { headers: {
        accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, 'Protected qualification oracle unavailable; no public success inferred');
    const result = await response.json();
    assert.equal(result.diagnostics?.schema, 'pcm-consumer-review/1');
    assert.equal(result.diagnostics.visibility, 'diagnostic');
    rememberApproval(consent, result.diagnostics.approvals[consent.id]);
}

module.exports = { request, issue, introspect, save, approvePending, savedApproval, requestCeiling, client, config };
