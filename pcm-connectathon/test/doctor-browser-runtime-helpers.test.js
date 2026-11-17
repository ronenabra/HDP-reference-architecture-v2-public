'use strict';

/** Verify browser probes can sign real ES256 requests with the distinct participant roles. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { certificates } = require('../../test-support/certificates');
/** Supply a real disposable transport certificate for the probe’s DER confirmation. */
function transportCertificate(directory) { fs.copyFileSync(path.join(certificates(), 'hospital-b-sp.crt'), path.join(directory, 'transport.crt')); }

/** Load helpers while registering, but never running, Playwright journeys. */
function loadHelpers(certs, checkingExpect) {
    const ignored = () => {};
    ignored.beforeEach = ignored;
    const context = { require(name) {
        return name === '@playwright/test' ? { test: ignored, expect: checkingExpect || ignored }
            : require(name.startsWith('.') ? path.resolve(__dirname, '../ui/tests', name) : name);
    }, __dirname: path.resolve(__dirname, '../ui/tests'), process: { env: { PCM_UI_CERTS_DIR: certs } }, Buffer, URL, URLSearchParams };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../ui/tests/doctor-diagnostics.spec.js'), 'utf8'), context);
    return context;
}

test('browser probe signs the matching registered P-256 assertion rather than an RSA transport key', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-browser-assertion-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    transportCertificate(directory);
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const transport = crypto.createPrivateKey(fs.readFileSync(path.join(certificates(), 'hospital-b-sp.key')));
    fs.writeFileSync(path.join(directory, 'registered-assertion.key'), ec.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    fs.writeFileSync(path.join(directory, 'rsa-transport.key'), transport.export({ type: 'pkcs8', format: 'pem' }));
    const config = { certificateRoles: { serviceProvider: {
        assertion: { key: 'registered-assertion.key' }, mtls: { cert: 'transport.crt', key: 'rsa-transport.key' }
    } }, healthOrganizations: [{ id: 'ho-a', certificates: {
        gatewayAssertionKey: 'registered-assertion.key', gatewayMtlsKey: 'rsa-transport.key', gatewayMtlsCert: 'transport.crt'
    } }] };
    const helpers = loadHelpers(directory);
    for (const participant of ['serviceProvider', 'healthOrganization:ho-a']) {
        const token = helpers.assertion(config, participant, 'registered-client-0001', 'https://pcm.example/token');
        const [header, claims, signature] = token.split('.');
        assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
        assert.equal(JSON.parse(Buffer.from(header, 'base64url')).kid, require('../../src/shared/assertion-keys').jwkThumbprint(ec.publicKey));
        assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, 'https://pcm.example/token');
        assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')).cnf, require('../../src/shared/assertion-keys').certificateConfirmation(fs.readFileSync(path.join(directory, 'transport.crt'))));
        assert.equal(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), {
            key: ec.publicKey, dsaEncoding: 'ieee-p1363'
        }, Buffer.from(signature, 'base64url')), true);
        assert.equal(helpers.certificateRole(config, participant, 'mtls').key, 'rsa-transport.key');
    }
});


test('negative Doctor evidence distinguishes independently signed remote requests from the registered signer', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-negative-assertion-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    transportCertificate(directory);
    const registered = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const unregistered = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    for (const [name, key] of [['registered.key', registered], ['unregistered.key', unregistered]]) {
        fs.writeFileSync(path.join(directory, name), key.export({ type: 'pkcs8', format: 'pem' }));
    }
    const audience = 'https://pcm.example/token';
    const config = { contract: { operational: { oauthBase: 'https://pcm.example' } }, publicBaseUrls: { pcmApi: 'https://pcm.example' }, organizations: {
        serviceProvider: { clientId: 'registered-client-0001' }, untrustedClient: { clientId: 'unregistered-client-0001' }
    }, certificateRoles: { serviceProvider: { assertion: { key: 'registered.key' }, mtls: { cert: 'transport.crt' } },
        untrustedClient: { assertion: { key: 'unregistered.key' }, mtls: { cert: 'transport.crt' } } } };
    const helpers = loadHelpers(directory);
    const entry = token => ({ details: { data: new URLSearchParams({ client_assertion: token }).toString() } });
    for (const identity of ['untrusted', 'untrusted-assertion']) {
        const client = identity === 'untrusted' ? config.organizations.untrustedClient.clientId : config.organizations.serviceProvider.clientId;
        const negative = helpers.assertion(config, 'untrustedClient', client, audience);
        assert.equal(helpers.negativeAssertionReachedRemote(config, entry(negative), identity), true);
        const normal = helpers.assertion(config, 'serviceProvider', client, audience);
        assert.equal(helpers.negativeAssertionReachedRemote(config, entry(normal), identity), false);
    }
    assert.equal(helpers.negativeAssertionReachedRemote(config, { details: { data: 'scope=system%2F*.crus' } }, 'untrusted'), false);
});


test('browser lifecycle RAR uses the authoritative Consent business identifier', () => {
    const helpers = loadHelpers('/unused');
    const consent = { id: 'local-id', identifier: [{ system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'business-id' }] };
    const actual = JSON.parse(JSON.stringify(helpers.consentDetails(consent)));
    const { consentAuthorizationDetails } = require('../../src/shared/data-authorization-details');
    assert.deepEqual(actual, consentAuthorizationDetails(consent));
    assert.throws(() => helpers.consentDetails({ id: 'local-id' }), /authoritative/);
    assert.throws(() => helpers.consentDetails({ identifier: [...consent.identifier, ...consent.identifier] }), /authoritative/);
});

test('browser clinical request uses public Consent and finite intent; obtained scope is independent', () => {
    const f = require('../../test-support/doctor-public-fixture').doctorPublicFixture(), helpers = loadHelpers('/unused');
    const request = helpers.clinicalApprovalRequest(f.consent);
    assert.equal(request.scope, 'patient/Patient.rs patient/Observation.rs');
    assert.equal(request.approvedScope, undefined);
    assert.equal(helpers.clinicalResponse(f.response, f.consent, { conformance: { preset: 'strict' } }, f.instance), f.scope);
    assert.throws(() => helpers.clinicalApprovalRequest({ ...f.consent, status: 'proposed' }), /active public Consent/);
    assert.throws(() => helpers.clinicalResponse({ ...f.response, scope: 'patient/Observation.s?_filter=x' }, f.consent, {}, f.instance), /unsupported/);
});
test('browser runners have no private approval-module mount closure', () => {
    assert.deepEqual(require('../ui/approval-modules.json'), []);
    const source = fs.readFileSync(path.resolve(__dirname, '../ui/tests/doctor-diagnostics.spec.js'), 'utf8');
    assert.doesNotMatch(source, /consent-scope-snapshot|service-grant|readApprovalSnapshot|inspectScope/);
});
test('browser issuance reads public Consent, sends app intent and preserves independently returned effective grant', async () => {
    const f = require('../../test-support/doctor-public-fixture').doctorPublicFixture();
    const helpers = loadHelpers('/unused', value => ({ toBe(expected) { assert.equal(value, expected); } }));
    const calls = [], before = JSON.stringify(f.consent);
    const config = { organizations: { serviceProvider: { clientId: 'owned-client' } }, contract: { operational: { fhirBase: 'https://pcm.example/fhir', oauthBase: 'https://pcm.example/oauth' } }, publicBaseUrls: { pcmApi: 'https://pcm.example/fhir' } };
    helpers.assertion = () => 'unit-only-assertion';
    helpers.mtlsRequest = async (_config, participant, url, options = {}) => {
        calls.push({ participant, url, options });
        if (url.endsWith(`/Consent/${f.consent.id}`)) return { status: 200, json: structuredClone(f.consent) };
        if (url.endsWith(`/HealthcareService/${f.instance.id}`)) return { status: 200, json: structuredClone(f.instance) };
        return { status: 200, json: options.form.resource === config.contract.operational.fhirBase
            ? { access_token: 'unit-only-opaque', expires_in: 30, scope: 'system/*.crus' } : f.response };
    };
    const credential = await helpers.issue(config, 'https://source.example/fhir', undefined, f.consent.id);
    assert.equal(calls.length, 5); assert.ok(calls.every(call => call.participant === 'serviceProvider'));
    assert.equal(calls[4].options.form.scope, 'patient/Patient.rs patient/Observation.rs');
    assert.equal(credential.effectiveScope, f.scope); assert.equal(JSON.stringify(f.consent), before);
});
