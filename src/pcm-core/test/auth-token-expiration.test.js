const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const jwt = require('jsonwebtoken');
const { jwkThumbprint } = require('../../shared/assertion-keys');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const PCM_ORG_ID = 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id';
const PCM_ORG_TYPE = 'http://pcm.fhir.health.gov.il/cs/pcm-org-type';

function clearPcmModuleCache() {
    for (const modulePath of [
        '../src/logger',
        '../src/team-config',
        '../src/public-mtls',
        '../src/oauth-role',
        '../src/oauth-metadata',
        '../src/client-assertion',
        '../src/state-store',
        '../src/token-store',
        '../src/token-authorization',
        '../src/token-service',
        '../src/store',
        '../src/routes/auth'
    ]) {
        delete require.cache[require.resolve(modulePath)];
    }
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
    });
}

async function assertIssuedTokenLifetime(accessTokenExpiresInSeconds, isExpired) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-token-expiration-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousCertsDir = process.env.CERTS_DIR;
    const previousLogDir = process.env.LOG_DIR;
    const previousStateDir = process.env.STATE_DIR;
    const previousIssuer = process.env.PCM_ISSUER;

    try {
        process.env.TEAM_CONFIG_PATH = configPath;
        process.env.CERTS_DIR = require('../../../test-support/certificates').certificates();
        process.env.LOG_DIR = path.join(tmp, 'logs');
        process.env.STATE_DIR = path.join(tmp, 'state');
        fs.writeFileSync(configPath, JSON.stringify(require('../../../test-support/team-config').buildTeamConfig({ security: { pcmApi: { accessTokenExpiresInSeconds } } })));

        clearPcmModuleCache();
        const authRoutes = require('../src/routes/auth');
        const { tokens } = require('../src/store');
        const fhirStore = require('../src/fhir/store');
        fhirStore.clear();
        fhirStore.add({
            resourceType: 'Organization', id: 'org-hospital-a-parent', active: true,
            identifier: [{ use: 'official', system: PCM_ORG_ID, value: 'PCM-PARENT' }],
            type: [{ coding: [{ system: PCM_ORG_TYPE, code: 'parent-org' }] }]
        });
        fhirStore.add({
            resourceType: 'Organization', id: 'org-sp', active: true,
            identifier: [{ use: 'official', system: PCM_ORG_ID, value: 'PCM-ORG-SP-0001' }],
            type: [{ coding: [{ system: PCM_ORG_TYPE, code: 'service-provider' }] }],
            partOf: { reference: 'Organization/org-hospital-a-parent' }
        });

        const app = express();
        app.use(express.urlencoded({ extended: false }));
        app.use('/', authRoutes);

        const server = http.createServer(app);
        await listen(server);

        try {
            const address = server.address();
            const tokenEndpoint = `http://127.0.0.1:${address.port}/token`;
            process.env.PCM_ISSUER = 'https://pcm2mtest.health.gov.il/api/fhir-service/r4';
            const clientId = 'pcm-sp-local-0001';
            const assertion = jwt.sign({
                iss: clientId,
                sub: clientId,
                aud: `${process.env.PCM_ISSUER}/token`,
                jti: uuidv4()
            }, fs.readFileSync(path.join(require('../../../test-support/certificates').certificates(), 'sp-client-assertion.key')), {
                algorithm: 'ES256',
                keyid: jwkThumbprint(fs.readFileSync(path.join(require('../../../test-support/certificates').certificates(), 'sp-client-assertion.key'))),
                expiresIn: '5m'
            });

            const response = await fetch(tokenEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                    client_assertion: assertion,
                    scope: 'system/*.crus',
                    resource: process.env.PCM_ISSUER
                })
            });

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.expires_in, accessTokenExpiresInSeconds);

            const storedToken = tokens.get(body.access_token);
            assert.ok(storedToken, 'opaque token should be stored');
            assert.equal(storedToken.exp - storedToken.iat, accessTokenExpiresInSeconds);
            if (isExpired) {
                assert.ok(storedToken.exp < Math.floor(Date.now() / 1000), 'negative lifetime should mint an already-expired token');
            } else {
                assert.ok(storedToken.exp > Math.floor(Date.now() / 1000), 'positive lifetime should mint a future-expiring token');
            }
        } finally {
            await close(server);
        }
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        if (previousCertsDir === undefined) delete process.env.CERTS_DIR;
        else process.env.CERTS_DIR = previousCertsDir;
        if (previousLogDir === undefined) delete process.env.LOG_DIR;
        else process.env.LOG_DIR = previousLogDir;
        if (previousStateDir === undefined) delete process.env.STATE_DIR;
        else process.env.STATE_DIR = previousStateDir;
        if (previousIssuer === undefined) delete process.env.PCM_ISSUER;
        else process.env.PCM_ISSUER = previousIssuer;
        clearPcmModuleCache();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

test('POST /token stores the supported preset lifetime at issuance', async () => {
    await assertIssuedTokenLifetime(300, false);
});
