const { buildTeamConfig } = require('../../../test-support/team-config');
/**
 * Tests for request-time client runtime config.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
process.env.LOG_DIR = process.env.LOG_DIR || path.join(tmpRoot, 'sp-client-runtime-test-logs');

test('client helpers read current team config instead of boot snapshot', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-client-runtime-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousPcmFhir = process.env.PCM_FHIR_URL;
    const previousDsGateway = process.env.DS_GATEWAY_URL;

    delete process.env.PCM_FHIR_URL;
    delete process.env.DS_GATEWAY_URL;
    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/client')];
    const client = require('../src/client');

    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        security: { serviceProviderToDataSource: { verifyServerCertificate: false } },
        internalBaseUrls: { pcmAuth: 'https://pcm-one:3000/api/fhir-service/r4', pcmFhir: 'https://pcm-one:3000/api/fhir-service/r4', referenceDataSource: 'https://ds-one:8080/fhir' }
    })));
    assert.equal(client._test.getPcmFhirUrl(), 'https://pcm-one:3000/api/fhir-service/r4');
    assert.equal(client._test.getDsGatewayUrl(), 'https://ds-one:8080/fhir');
    assert.equal(client._test.shouldVerifyDataSourceServer(), false);

    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        securitySimulation: { global: { serverCertificateVerification: true } },
        internalBaseUrls: { pcmAuth: 'https://pcm-two:3000/api/fhir-service/r4', pcmFhir: 'https://pcm-two:3000/api/fhir-service/r4', referenceDataSource: 'https://ds-two:8080/fhir' }
    })));
    assert.equal(client._test.getPcmFhirUrl(), 'https://pcm-two:3000/api/fhir-service/r4');
    assert.equal(client._test.getDsGatewayUrl(), 'https://ds-two:8080/fhir');
    assert.equal(client._test.shouldVerifyDataSourceServer(), true);

    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        organizations: { dataSources: ['source-a', 'source-b'].map(id => ({ id, name: id, clientId: `pcm-${id}-client-0001`, businessIdentifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: id } })) },
        securitySimulation: { perSource: { 'source-a': { serverCertificateVerification: true } } }
    })));
    assert.equal(client._test.shouldVerifyDataSourceServer('source-a'), true);
    assert.equal(client._test.shouldVerifyDataSourceServer('source-b'), false);


    if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
    else process.env.TEAM_CONFIG_PATH = previousConfigPath;
    if (previousPcmFhir === undefined) delete process.env.PCM_FHIR_URL;
    else process.env.PCM_FHIR_URL = previousPcmFhir;
    if (previousDsGateway === undefined) delete process.env.DS_GATEWAY_URL;
    else process.env.DS_GATEWAY_URL = previousDsGateway;
    delete require.cache[require.resolve('../src/client')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('client resolves custom data source trust metadata by endpoint URL', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-client-ds-trust-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;

    process.env.TEAM_CONFIG_PATH = configPath;
    delete require.cache[require.resolve('../src/client')];
    const client = require('../src/client');

    try {
        fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
            organizations: {
                dataSources: [{
                    id: 'org-custom',
                    clientId: 'pcm-custom-client-0001',
                    businessIdentifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: 'CUSTOM' },
                    name: 'Custom Source',
                    endpoint: 'https://custom.example/fhir',
                    serverTrust: {
                        mode: 'custom-ca',
                        caCert: 'custom/custom-ca.crt',
                        certThumbprint: 'A'.repeat(43)
                    }
                }]
            }
        })));

        const source = client._test.findDataSourceByUrl('https://custom.example/fhir/');
        assert.equal(source.id, 'org-custom');
        assert.equal(source.serverTrust.mode, 'custom-ca');
        assert.equal(source.serverTrust.caCert, 'custom/custom-ca.crt');
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        delete require.cache[require.resolve('../src/client')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('client routes own public reference data source endpoint through internal gateway URL', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-client-ds-route-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousDsGateway = process.env.DS_GATEWAY_URL;

    process.env.TEAM_CONFIG_PATH = configPath;
    process.env.DS_GATEWAY_URL = 'https://localhost:8080/fhir';
    delete require.cache[require.resolve('../src/client')];
    const client = require('../src/client');

    try {
        fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
            publicBaseUrls: {
                referenceDataSource: 'https://public-nlb.example.test:8280/fhir'
            },
            internalBaseUrls: {
                referenceDataSource: 'https://localhost:8080/fhir'
            }
        })));

        assert.deepEqual(client._test.resolveDataSourceRequestTarget('https://public-nlb.example.test:8280/fhir/'), {
            audienceUrl: 'https://public-nlb.example.test:8280/fhir/',
            requestUrl: 'https://localhost:8080/fhir',
            usedInternalRoute: true
        });

        assert.deepEqual(client._test.resolveDataSourceRequestTarget('https://external.example.test/fhir'), {
            audienceUrl: 'https://external.example.test/fhir',
            requestUrl: 'https://external.example.test/fhir',
            usedInternalRoute: false
        });
        assert.equal(
            client._test.resolveDataSourceRequestTarget('https://external.example.test/fhir/').audienceUrl,
            'https://external.example.test/fhir/'
        );
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        if (previousDsGateway === undefined) delete process.env.DS_GATEWAY_URL;
        else process.env.DS_GATEWAY_URL = previousDsGateway;
        delete require.cache[require.resolve('../src/client')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('client keeps public PCM FHIR identity while routing over the private back-channel', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'sp-client-pcm-route-'));
    const configPath = path.join(tmp, 'team-config.json');
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousPcmFhir = process.env.PCM_FHIR_URL;

    delete process.env.PCM_FHIR_URL;
    process.env.TEAM_CONFIG_PATH = configPath;
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig({
        publicBaseUrls: { pcmApi: 'https://pcm.public.example.test:9443/api/fhir-service/r4' },
        internalBaseUrls: {
            pcmAuth: 'https://pcm-core:3000/api/fhir-service/r4',
            pcmFhir: 'https://pcm-core:3000/api/fhir-service/r4'
        }
    })));
    delete require.cache[require.resolve('../src/client')];
    const client = require('../src/client');

    try {
        assert.equal(
            client._test.backchannelEndpoint('https://pcm2mtest.health.gov.il/api/fhir-service/r4/token'),
            'https://pcm-core:3000/api/fhir-service/r4/token'
        );
        assert.equal(
            client._test.logicalPcmFhirAudience('https://pcm-core:3000/api/fhir-service/r4'),
            'https://pcm2mtest.health.gov.il/api/fhir-service/r4'
        );
        assert.equal(
            client._test.logicalPcmFhirAudience('https://source.example.test/fhir'),
            'https://source.example.test/fhir'
        );
    } finally {
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        if (previousPcmFhir === undefined) delete process.env.PCM_FHIR_URL;
        else process.env.PCM_FHIR_URL = previousPcmFhir;
        delete require.cache[require.resolve('../src/client')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('client cache keys include requested scope and certificate names match committed identities', () => {
    require('../../../test-support/team-config').installTestRuntime();
    const client = require('../src/client');

    assert.equal(client._test.certNameForIdentity('hospital-a'), 'sp-client-assertion');
    assert.equal(client._test.certNameForIdentity('hospital-b'), 'hospital-b-sp');
    assert.equal(client._test.certNameForIdentity('untrusted'), 'untrusted-client');

    const defaultScopeKey = client._test.tokenCacheKey('hospital-a', 'https://ds.example/fhir', 'consent-1');
    const observationScopeKey = client._test.tokenCacheKey('hospital-a', 'https://ds.example/fhir', 'consent-1', 'patient/Observation.rs');

    assert.notEqual(defaultScopeKey, observationScopeKey);
    assert.equal(JSON.parse(defaultScopeKey).at(-1), 'system/*.crus');
    assert.equal(JSON.parse(observationScopeKey).at(-1), 'patient/Observation.rs');
});
