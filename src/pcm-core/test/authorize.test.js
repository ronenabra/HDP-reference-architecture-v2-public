require('../../../test-support/team-config').installTestRuntime();
'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const test = require('node:test');

const previousLogDir = process.env.LOG_DIR;
const moduleLogDir = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-authorize-logs-'));
process.env.LOG_DIR = moduleLogDir;
const { FileAuthorizationRecordRepository, pkceS256 } = require('../src/authorization-store');
const { createAuthorizeRouter } = require('../src/routes/authorize');
const { ConfiguredTestIdentityProvider } = require('../src/sandbox-identity-provider');
const { createTokenService } = require('../src/token-service');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const client = {
    clientId: 'pcm-sp-test-0001',
    name: 'Test SMART Application',
    role: 'service-provider',
    authorizationCodeGrant: true,
    mtlsThumbprint: 'A'.repeat(43),
    assertionThumbprint: 'B'.repeat(43),
    redirectUris: ['https://app.example.test/callback'],
    smartScopes: ['patient/*.rs', 'patient/Observation.rs', 'patient/Condition.rs']
};
const verifier = 'A'.repeat(43);

test.after(() => {
    if (previousLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    fs.rmSync(moduleLogDir, { recursive: true, force: true });
});

async function withServer(callback) {
    const directory = fs.mkdtempSync(path.join(tmpRoot, 'pcm-authorize-route-'));
    let now = 2_000;
    let sequence = 0;
    const store = new FileAuthorizationRecordRepository(directory, {
        clock: () => now,
        tokenGenerator: kind => `pcm-${kind}-route-${++sequence}`
    });
    const identityProvider = new ConfiguredTestIdentityProvider([{
        idSystem: 'https://example.test/patient-id',
        idValue: 'private-patient-1',
        display: 'Configured Patient Alpha'
    }]);
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.resolve(__dirname, '..', 'src', 'views'));
    app.use(express.urlencoded({ extended: true }));
    app.use(createAuthorizeRouter({
        findClient: id => (id === client.clientId ? client : null),
        store,
        identityProvider,
        getFhirAudience: () => 'https://pcm.example.test/r4',
        requireMtls: (req, res, next) => next()
    }));
    const issuedTokens = [];
    const tokenService = createTokenService({
        tokenStore: {
            issue(kind, claims, lifetime) {
                const token = `opaque-authorize-route-${issuedTokens.length + 1}`;
                issuedTokens.push({ token, kind, claims, lifetime });
                return { token, record: { ...claims, kind, iat: now, exp: now + lifetime } };
            },
            get size() { return issuedTokens.length; }
        },
        fhirStore: { get() { return null; }, getAll() { return []; } },
        authenticate: req => { req.mtls = { thumbprint: client.mtlsThumbprint }; return { client, decodedAssertion: {}, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: client.assertionThumbprint }; },
        getIssuer: () => 'https://pcm.example.test',
        getPolicy: () => ({ compatibility: { enabledAdapters: [] } }),
        getConfig: () => ({}),
        getLifetime: () => 30,
        authorizationStore: store,
        clock: () => now,
        logger: { info() {}, warn() {} }
    });
    app.post('/token', (req, res) => {
        const result = tokenService(req);
        res.status(result.status).json(result.body);
    });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await callback({
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            store,
            issuedTokens,
            setNow: value => { now = value; }
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function authorizeUrl(baseUrl, overrides = {}) {
    const parameters = new URLSearchParams({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: client.redirectUris[0],
        scope: 'patient/Observation.rs patient/Condition.rs',
        state: 'state-test-123',
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        aud: 'https://pcm.example.test/r4',
        ...overrides
    });
    return `${baseUrl}/authorize?${parameters}`;
}

const browserCookies = new Map();
async function begin(baseUrl, overrides = {}) {
    const response = await fetch(authorizeUrl(baseUrl, overrides), { redirect: 'manual', headers: { Cookie: browserCookies.get(baseUrl) || '' } });
    if (response.headers.getSetCookie().length) browserCookies.set(baseUrl, response.headers.getSetCookie()[0].split(';')[0]);
    const html = await response.text();
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(html)?.[1];
    return { response, html, transactionId };
}

async function decide(baseUrl, transactionId, values = {}) {
    return fetch(`${baseUrl}/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: browserCookies.get(baseUrl) || '' },
        body: new URLSearchParams({
            transaction_id: transactionId,
            decision: 'approve',
            patient: 'configured-patient-1',
            approved_scope: 'patient/Observation.rs',
            ...values
        })
    });
}

async function exchangeCode(baseUrl, code, overrides = {}) {
    return fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: client.redirectUris[0],
            code_verifier: verifier,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: 'test.assertion.value',
            ...overrides
        })
    });
}

test('authorize interaction redirects and exchanges a patient/scope-bound one-time code over HTTP', async () => {
    await withServer(async ({ baseUrl, issuedTokens }) => {
        const started = await begin(baseUrl);
        assert.equal(started.response.status, 200);
        assert.ok(started.transactionId);
        assert.match(started.html, /Configured Patient Alpha/);
        assert.doesNotMatch(started.html, /private-patient-1/);

        const response = await decide(baseUrl, started.transactionId);
        assert.equal(response.status, 302);
        const location = new URL(response.headers.get('location'));
        assert.equal(location.searchParams.get('state'), 'state-test-123');
        const code = location.searchParams.get('code');
        assert.ok(code);

        const exchange = await exchangeCode(baseUrl, code);
        assert.equal(exchange.status, 200);
        assert.deepEqual(issuedTokens[0].claims.patient, {
            system: 'https://example.test/patient-id',
            value: 'private-patient-1'
        });
        assert.equal(issuedTokens[0].claims.scope, 'patient/Observation.rs');
        assert.equal((await exchangeCode(baseUrl, code)).status, 400);
    });
});

test('HTTP authorization-code exchange rejects PKCE, redirect, client, expiry, and scope expansion failures', async () => {
    await withServer(async ({ baseUrl, setNow }) => {
        async function approvedCode() {
            const started = await begin(baseUrl);
            const response = await decide(baseUrl, started.transactionId);
            return new URL(response.headers.get('location')).searchParams.get('code');
        }
        assert.equal((await exchangeCode(baseUrl, await approvedCode(), { code_verifier: 'B'.repeat(43) })).status, 400);
        assert.equal((await exchangeCode(baseUrl, await approvedCode(), { redirect_uri: 'https://app.example.test/other' })).status, 400);

        const originalClientId = client.clientId;
        const codeForClientMismatch = await approvedCode();
        client.clientId = 'pcm-sp-test-other';
        assert.equal((await exchangeCode(baseUrl, codeForClientMismatch)).status, 400);
        client.clientId = originalClientId;

        const expired = await approvedCode();
        setNow(3_000);
        assert.equal((await exchangeCode(baseUrl, expired)).status, 400);
        setNow(2_000);

        const expanded = await approvedCode();
        assert.equal((await exchangeCode(baseUrl, expanded, { scope: 'patient/Condition.rs' })).status, 400);
    });
});

test('denial and cancellation return access_denied with original state', async () => {
    await withServer(async ({ baseUrl }) => {
        for (const decision of ['deny', 'cancel']) {
            const started = await begin(baseUrl, { state: `state-${decision}` });
            const response = await decide(baseUrl, started.transactionId, { decision });
            const location = new URL(response.headers.get('location'));
            assert.equal(location.searchParams.get('error'), 'access_denied');
            assert.equal(location.searchParams.get('state'), `state-${decision}`);
            assert.equal(location.searchParams.has('code'), false);
        }
    });
});

test('authorize rejects unknown clients and non-exact redirect URIs without redirecting', async () => {
    await withServer(async ({ baseUrl }) => {
        const wrongClient = await fetch(authorizeUrl(baseUrl, { client_id: 'pcm-unknown-client' }), { redirect: 'manual' });
        assert.equal(wrongClient.status, 400);
        assert.equal(wrongClient.headers.has('location'), false);

        const wrongRedirect = await fetch(authorizeUrl(baseUrl, {
            redirect_uri: `${client.redirectUris[0]}/`
        }), { redirect: 'manual' });
        assert.equal(wrongRedirect.status, 400);
        assert.equal(wrongRedirect.headers.has('location'), false);
    });
});

test('authorize redirects protocol and PKCE errors only to the registered URI', async () => {
    await withServer(async ({ baseUrl }) => {
        const cases = [
            { response_type: 'token' },
            { response_mode: 'fragment' },
            { code_challenge: '' },
            { code_challenge_method: 'plain' },
            { aud: 'https://pcm.example.test/r4/' }
        ];
        for (const overrides of cases) {
            const response = await fetch(authorizeUrl(baseUrl, overrides), { redirect: 'manual' });
            assert.equal(response.status, 302);
            const location = new URL(response.headers.get('location'));
            assert.equal(location.origin + location.pathname, client.redirectUris[0]);
            assert.ok(location.searchParams.get('error'));
            assert.equal(location.searchParams.get('state'), 'state-test-123');
        }
    });
});

test('authorize rejects user scopes, _filter, malformed advanced scopes, and approval expansion', async () => {
    await withServer(async ({ baseUrl }) => {
        const constrained = await begin(baseUrl, {
            scope: 'patient/Observation.rs?subject.identifier=system%7Cvalue&_has:Encounter:subject:status=finished'
        });
        assert.equal(constrained.response.status, 200);
        assert.match(constrained.html, /subject.identifier/);
        assert.match(constrained.html, /_has:Encounter:subject:status/);

        for (const scope of [
            'user/Observation.rs',
            'patient/Observation.rs?_filter=status=current',
            'patient/Observation.rs?subject.name',
            'patient/Observation.rs patient/Observation.rs'
        ]) {
            const response = await fetch(authorizeUrl(baseUrl, { scope }), { redirect: 'manual' });
            assert.equal(response.status, 302);
            assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), 'invalid_scope');
        }

        const started = await begin(baseUrl, { scope: 'patient/Observation.rs' });
        const expanded = await decide(baseUrl, started.transactionId, {
            approved_scope: 'patient/Medication.rs'
        });
        assert.equal(new URL(expanded.headers.get('location')).searchParams.get('error'), 'invalid_scope');
    });
});

test('authorization transaction expiry fails closed and authorization code remains out of logs', async () => {
    await withServer(async ({ baseUrl, setNow }) => {
        const started = await begin(baseUrl);
        setNow(2_301);
        const expired = await decide(baseUrl, started.transactionId);
        assert.equal(expired.status, 400);
        assert.equal((await expired.json()).error, 'invalid_request');

        for (const source of ['../src/routes/authorize.js', '../src/authorize-service.js', '../src/authorization-store.js']) {
            const text = fs.readFileSync(path.resolve(__dirname, source), 'utf8');
            assert.doesNotMatch(text, /console\.|logger\./);
        }
    });
});
