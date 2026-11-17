require('../../../test-support/team-config').installTestRuntime();
'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const test = require('node:test');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const issuer = 'https://pcm2mtest.health.gov.il/api/fhir-service/r4';
const { AUTHORIZATION_DETAILS_TYPE, LOGGING_EXCEPTION } = require('../../shared/pcm-environment');
const strictPolicy = {
    mode: 'strict',
    assertion: { algorithms: ['ES256', 'ES384'] },
    exposure: { notice: '' },
    compatibility: { enabledAdapters: [], warnings: [] }
};

function expectedAuthorizationMetadata() {
    return {
        issuer,
        response_modes_supported: ['query'],
        authorization_details_types_supported: [AUTHORIZATION_DETAILS_TYPE],
        pcm_conformance_exceptions: [LOGGING_EXCEPTION],
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        introspection_endpoint: `${issuer}/introspect`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256', 'ES384'],
        introspection_endpoint_auth_methods_supported: ['private_key_jwt'],
        introspection_endpoint_auth_signing_alg_values_supported: ['ES256', 'ES384'],
        tls_client_certificate_bound_access_tokens: false
    };
}

function expectedSmartMetadata() {
    const oauth = expectedAuthorizationMetadata();
    return {
        issuer: oauth.issuer,
        authorization_details_types_supported: oauth.authorization_details_types_supported,
        pcm_conformance_exceptions: oauth.pcm_conformance_exceptions,
        authorization_endpoint: oauth.authorization_endpoint,
        token_endpoint: oauth.token_endpoint,
        introspection_endpoint: oauth.introspection_endpoint,
        grant_types_supported: oauth.grant_types_supported,
        response_types_supported: oauth.response_types_supported,
        response_modes_supported: ['query'],
        token_endpoint_auth_methods_supported: oauth.token_endpoint_auth_methods_supported,
        token_endpoint_auth_signing_alg_values_supported: ['ES256', 'ES384'],
        introspection_endpoint_auth_methods_supported: oauth.introspection_endpoint_auth_methods_supported,
        introspection_endpoint_auth_signing_alg_values_supported: ['ES256', 'ES384'],
        tls_client_certificate_bound_access_tokens: false,
        code_challenge_methods_supported: ['S256'],
        capabilities: [
            'launch-standalone',
            'client-confidential-asymmetric',
            'permission-patient',
            'permission-v2'
        ]
    };
}

test('strict OAuth and SMART metadata match the pinned closed golden documents', () => {
    const metadata = require('../src/oauth-metadata');
    const options = { policy: strictPolicy };
    process.env.PCM_ISSUER = issuer;
    try {
        assert.deepEqual(metadata.getAuthorizationServerMetadata(null, options), expectedAuthorizationMetadata());
        assert.deepEqual(metadata.getSmartConfiguration(null, options), expectedSmartMetadata());
        assert.equal(Object.hasOwn(metadata.getAuthorizationServerMetadata(null, options), 'jwks_uri'), false);
        assert.equal(Object.hasOwn(metadata.getSmartConfiguration(null, options), 'jwks_uri'), false);
        assert.equal(Object.hasOwn(metadata.getSmartConfiguration(null, options), 'scopes_supported'), false);
    } finally {
        delete process.env.PCM_ISSUER;
    }
});

test('metadata uses the configured HTTPS issuer and ignores spoofed forwarding origins', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-oauth-metadata-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    try {
        fs.writeFileSync(configPath, JSON.stringify(require('../../../test-support/team-config').buildTeamConfig({ publicBaseUrls: { pcmApi: 'https://pcm.example.test/api/fhir-service/r4' } })));
        process.env.TEAM_CONFIG_PATH = configPath;
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/oauth-metadata')];
        const metadata = require('../src/oauth-metadata');
        const request = {
            protocol: 'https',
            get: name => ({ host: 'direct.example.test', 'x-forwarded-host': 'spoofed.example.test' })[name]
        };
        const document = metadata.getAuthorizationServerMetadata(request, { preferConfigured: true, policy: strictPolicy });
        assert.equal(document.issuer, issuer);
        assert.equal(metadata.requestIssuer(request), 'https://direct.example.test');
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/oauth-metadata')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('connectathon metadata advertises enabled algorithms and an explicit non-conformance marker', () => {
    const metadata = require('../src/oauth-metadata');
    const policy = {
        mode: 'connectathon',
        assertion: { algorithms: ['ES256', 'RS256', 'ES384'] },
        exposure: { notice: 'Connectathon compatibility profile' },
        compatibility: {
            enabledAdapters: ['legacy-rs256-assertion', 'legacy-es384-assertion'],
            warnings: []
        }
    };
    process.env.PCM_ISSUER = issuer;
    try {
        for (const document of [
            metadata.getAuthorizationServerMetadata(null, { policy }),
            metadata.getSmartConfiguration(null, { policy })
        ]) {
            assert.deepEqual(document.token_endpoint_auth_signing_alg_values_supported, ['ES256', 'RS256', 'ES384']);
            assert.deepEqual(document.introspection_endpoint_auth_signing_alg_values_supported, ['ES256', 'RS256', 'ES384']);
            assert.equal(document.pcm_sandbox_mode, 'connectathon');
            assert.equal(document.pcm_strict_conformance_evidence, false);
            assert.equal(Object.hasOwn(document, 'jwks_uri'), false);
        }
    } finally {
        delete process.env.PCM_ISSUER;
    }
});

test('PCM has no public JWKS route on API, metadata, or UI source', async () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-no-jwks-route-'));
    const previousLogDir = process.env.LOG_DIR;
    const previousStateDir = process.env.STATE_DIR;
    process.env.LOG_DIR = path.join(tmp, 'logs');
    process.env.STATE_DIR = path.join(tmp, 'state');
    for (const modulePath of ['../src/logger', '../src/routes/auth']) {
        delete require.cache[require.resolve(modulePath)];
    }
    const app = express();
    app.use('/', require('../src/routes/auth'));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/.well-known/jwks.json`);
        assert.equal(response.status, 404);
        for (const sourcePath of ['../src/routes/auth.js', '../src/index.js']) {
            assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, sourcePath), 'utf8'), /\.well-known\/jwks\.json/);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
        if (previousStateDir === undefined) delete process.env.STATE_DIR;
        else process.env.STATE_DIR = previousStateDir;
        for (const modulePath of ['../src/logger', '../src/routes/auth']) {
            delete require.cache[require.resolve(modulePath)];
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
