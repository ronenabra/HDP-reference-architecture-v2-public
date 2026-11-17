const { buildTeamConfig } = require('../../../test-support/team-config');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

test('custom data sources are registered as PCM OAuth2 clients', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-client-registry-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousCertsDir = process.env.CERTS_DIR;

    try {
        process.env.TEAM_CONFIG_PATH = configPath;
        process.env.CERTS_DIR = tmp;
        fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
            organizations: {
                dataSources: [{
                    id: 'org-custom',
                    businessIdentifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: 'CUSTOM' },
                    name: 'Custom Source',
                    endpoint: 'https://custom.example/fhir',
                    clientId: 'pcm-custom-client-0001',
                    pcmClientAuth: {
                        clientId: 'pcm-custom-client-0001',
                        certThumbprint: 'A'.repeat(43),
                        cert: 'custom/org-custom.crt',
                        key: 'custom/org-custom.key',
                        assertionCertificates: {
                            RS256: 'custom/org-custom-rsa.crt'
                        }
                    },
                    scopes: ['introspection']
                }]
            }
        })));

        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/store')];
        const { findClientById } = require('../src/store');
        const client = findClientById('pcm-custom-client-0001');

        assert.equal(client.organizationId, 'org-custom');
        assert.equal(client.certPath, path.join(tmp, 'custom/org-custom.crt'));
        assert.equal(client.assertionKeyPaths.ES256, path.join(tmp, 'custom/org-custom.crt'));
        assert.equal(client.assertionKeyPaths.RS256, path.join(tmp, 'custom/org-custom-rsa.crt'));
        assert.deepEqual(client.scopes, ['introspection']);
        assert.equal(client.role, 'data-source');
        assert.equal(client.mtlsThumbprint, null, 'missing role files must not trust a cached display thumbprint');

        const material = require('../../../test-support/certificates').certificates();
        fs.mkdirSync(path.join(tmp, 'custom'));
        fs.copyFileSync(path.join(material, 'sp-client-assertion.crt'), path.join(tmp, 'custom/org-custom.crt'));
        fs.copyFileSync(path.join(material, 'hospital-b-sp.crt'), path.join(tmp, 'custom/transport.crt'));
        const config = require('../src/team-config').loadTeamConfig();
        config.runtime.stateDir = path.join(tmp, 'state');
        config.organizations.dataSources[0].pcmClientAuth.mtlsCert = 'custom/transport.crt';
        require('../src/team-config').saveTeamConfig(config);
        const updated = findClientById(client.clientId);
        assert.equal(updated.mtlsThumbprint, require('../src/crypto').certToX5tS256(fs.readFileSync(path.join(tmp, 'custom/transport.crt'))));
        assert.notEqual(updated.mtlsThumbprint, updated.assertionThumbprint);
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        if (previousCertsDir === undefined) delete process.env.CERTS_DIR;
        else process.env.CERTS_DIR = previousCertsDir;
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/store')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('three HAPI HOs plus the legacy source use separate assertion and mTLS certificate bindings', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-ho-client-registry-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousCertsDir = process.env.CERTS_DIR;
    try {
        const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json'), 'utf8'));
        process.env.TEAM_CONFIG_PATH = configPath;
        process.env.CERTS_DIR = tmp;
        fs.writeFileSync(configPath, JSON.stringify(config));
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/store')];
        const clients = require('../src/store').buildClients().filter(client => client.role === 'data-source');

        const hapiOrganizationIds = new Set(config.healthOrganizations.map(ho => ho.dataSourceOrganization.id));
        const hapiClients = clients.filter(client => hapiOrganizationIds.has(client.organizationId));
        const legacyClient = clients.find(client => !hapiOrganizationIds.has(client.organizationId));
        assert.deepEqual(hapiClients.map(client => client.organizationId), config.healthOrganizations.map(ho => ho.dataSourceOrganization.id));
        assert.deepEqual(hapiClients.map(client => path.basename(client.certPath)), config.healthOrganizations.map(ho => ho.certificates.gatewayAssertionCert));
        assert.ok(legacyClient);
        assert.equal(new Set(clients.map(client => client.clientId)).size, 4);
        assert.equal(new Set(clients.map(client => path.basename(client.certPath))).size, 4);
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        if (previousCertsDir === undefined) delete process.env.CERTS_DIR;
        else process.env.CERTS_DIR = previousCertsDir;
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/store')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('standalone SMART capability uses explicit exact redirect and patient scopes', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-smart-client-registry-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousCertsDir = process.env.CERTS_DIR;
    try {
        process.env.TEAM_CONFIG_PATH = configPath;
        process.env.CERTS_DIR = tmp;
        fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
            organizations: {
                serviceProvider: {
                    redirectUri: 'https://app.example.test/callback',
                    redirectUris: [
                        'https://app.example.test/callback',
                        'https://app.example.test/second-callback'
                    ],
                    smartScopes: ['patient/*.rs', 'patient/Observation.rs']
                }
            }
        })));
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/store')];
        const { findClientById } = require('../src/store');
        const client = findClientById('pcm-sp-local-0001');
        assert.equal(client.authorizationCodeGrant, true);
        assert.equal(client.redirectUri, 'https://app.example.test/callback');
        assert.deepEqual(client.redirectUris, [
            'https://app.example.test/callback',
            'https://app.example.test/second-callback'
        ]);
        assert.deepEqual(client.smartScopes, ['patient/*.rs', 'patient/Observation.rs']);
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        if (previousCertsDir === undefined) delete process.env.CERTS_DIR;
        else process.env.CERTS_DIR = previousCertsDir;
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/store')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
