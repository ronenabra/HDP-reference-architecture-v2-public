const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('crypto');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tmpRoot = process.env.TEST_TMPDIR || '/tmp';
const dataSourceClientId = 'pcm-ds-team-a-ho-a-0001';
const dataSourceOrgId = 'org-team-a-ho-a-source';
const dataSourceAddress = 'https://ds.example.test/fhir';
const PCM_ORG_ID = 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id';
const PCM_ORG_TYPE = 'http://pcm.fhir.health.gov.il/cs/pcm-org-type';

function organization(id, role, parent = null, businessId = `PCM-${id}`) {
    return {
        resourceType: 'Organization', id, active: true,
        identifier: [{ use: 'official', system: PCM_ORG_ID, value: businessId }],
        type: [{ coding: [{ system: PCM_ORG_TYPE, code: role }] }],
        ...(parent ? { partOf: { reference: `Organization/${parent}` } } : {})
    };
}

function clearPcmModuleCache() {
    for (const modulePath of [
        '../src/logger',
        '../src/team-config',
        '../src/public-mtls',
        '../src/oauth-role',
        '../src/client-assertion',
        '../src/state-store',
        '../src/token-store',
        '../src/token-authorization',
        '../src/token-service',
        '../src/store',
        '../src/fhir/store',
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

function addDataSourceEndpoint(fhirStore) {
    fhirStore.add(organization('org-reference-parent', 'parent-org'));
    fhirStore.add({
        ...organization(dataSourceOrgId, 'source', 'org-reference-parent'),
        name: 'Reference Data Source',
        endpoint: [{ reference: 'Endpoint/endpoint-vaccine-repo' }]
    });
    fhirStore.add({
        resourceType: 'Endpoint',
        id: 'endpoint-vaccine-repo',
        status: 'active',
        address: dataSourceAddress,
        managingOrganization: { reference: `Organization/${dataSourceOrgId}` }
    });
}

function clientAssertion(audience, options = {}) {
    return jwt.sign({
        iss: dataSourceClientId,
        sub: dataSourceClientId,
        aud: audience,
        jti: options.jti || uuidv4()
    }, fs.readFileSync(path.join(require('../../../test-support/certificates').certificates(), 'ho-a-gateway-assertion.key')), {
        algorithm: 'ES256',
        expiresIn: '5m',
        ...(options.kid ? { header: { kid: options.kid, typ: 'JWT' } } : {})
    });
}

async function withIntrospectionServer(callback, options = {}) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-introspection-client-assertion-'));
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousCertsDir = process.env.CERTS_DIR;
    const previousLogDir = process.env.LOG_DIR;
    const previousStateDir = process.env.STATE_DIR;
    const previousMode = process.env.PCM_CONFORMANCE_MODE;
    const previousIssuer = process.env.PCM_ISSUER;

    try {
        process.env.TEAM_CONFIG_PATH = path.join(tmp, 'team-config.json');
        process.env.CERTS_DIR = require('../../../test-support/certificates').certificates();
        process.env.LOG_DIR = path.join(tmp, 'logs');
        process.env.STATE_DIR = path.join(tmp, 'state');
        const mode = options.mode || 'connectathon';
        process.env.PCM_CONFORMANCE_MODE = mode;
        const teamConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pcm-connectathon/example-team-config.json'), 'utf8'));
        teamConfig.conformance = {
            mode,
            preset: mode === 'strict' ? 'strict' : 'connectathon-balanced',
            policyVersion: require('../../shared/conformance-policy').POLICY_VERSION,
            compatibilityAdapters: options.adapters || (mode === 'connectathon' ? ['legacy-jose-kid', 'legacy-introspection-token-audience'] : [])
        };
        teamConfig.security = mode === 'strict' ? {
                pcmApi: { clientAuth: 'mtls', allowAnyTokenResource: false, accessTokenExpiresInSeconds: 30 },
                dataSourceGateway: { clientAuth: 'mtls' },
                serviceProviderToDataSource: { verifyServerCertificate: true },
                dsGatewayToFhirServer: { protocol: 'https', verifyServerCertificate: true },
                dsFhirServer: { enforceMappedPatients: true }
            } : {
                pcmApi: { clientAuth: 'tls', allowAnyTokenResource: false, accessTokenExpiresInSeconds: 300 },
                dataSourceGateway: { clientAuth: 'tls' },
                serviceProviderToDataSource: { verifyServerCertificate: true },
                dsGatewayToFhirServer: { protocol: 'https', verifyServerCertificate: true, customUrl: '' },
                dsFhirServer: { enforceMappedPatients: true }
            };
        teamConfig.securitySimulation.global = require('../../shared/conformance-policy').presetSimulationDefaults(teamConfig.conformance.preset);
        teamConfig.securitySimulation.perSource = require('../../shared/conformance-policy').presetSourceDefaults(teamConfig.conformance.preset);
        teamConfig.legacyDataSource.enabled = mode !== 'strict';
        teamConfig.organizations.referenceDataSource.endpoint = dataSourceAddress;
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(teamConfig));

        clearPcmModuleCache();
        const authRoutes = require('../src/routes/auth');
        const { tokens } = require('../src/store');
        const fhirStore = require('../src/fhir/store');
        fhirStore.clear();
        addDataSourceEndpoint(fhirStore);
        fhirStore.add(organization('org-hospital-a-parent', 'parent-org'));
        fhirStore.add({
            ...organization('org-sp', 'service-provider', 'org-hospital-a-parent', 'PCM-ORG-SP-0001')
        });
        const activeStatus = {
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-service-business-status',
            valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-service-business-status', code: 'active' }
        };
        fhirStore.add({
            resourceType: 'HealthcareService', id: 'catalog', active: true,
            meta: {
                profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-canonical'],
                tag: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-meta-tag', code: 'catalog' }]
            },
            identifier: [{
                use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-catalog-id', value: 'CATALOG-1'
            }],
            extension: [activeStatus]
        });
        fhirStore.add({
            resourceType: 'HealthcareService', id: 'instance', active: true,
            meta: {
                profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-instance'],
                tag: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-meta-tag', code: 'instance' }]
            },
            identifier: [{ use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-instance-id', value: 'SERVICE-1' }],
            providedBy: { reference: 'Organization/org-sp' },
            extension: [activeStatus, {
                url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice',
                valueReference: { reference: 'HealthcareService/catalog' }
            }]
        });
        fhirStore.add({
            resourceType: 'Consent', id: 'consent-1', status: 'active',
            identifier: [{ system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'CONSENT-1' }],
            patient: { identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' } },
            extension: [
                {
                    url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status',
                    valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-consent-business-status', code: 'active' }
                },
                {
                    url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service',
                    valueReference: { reference: 'HealthcareService/instance' }
                }
            ],
            provision: { period: { start: '2020-01-01T00:00:00.000Z', end: '2030-01-01T00:00:00.000Z' }, actor: [
                { role: { coding: [{ code: 'IRCP' }] }, reference: { reference: 'Organization/org-sp' } },
                { role: { coding: [{ code: 'CST' }] }, reference: { reference: `Organization/${dataSourceOrgId}` } }
            ] }
        });

        const catalog = fhirStore.get('HealthcareService', 'catalog');
        catalog.extension.push({ url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-information-bucket', extension: [
            { url: 'bucket', valueCodeableConcept: { coding: [{ system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'laboratoryTests' }] } },
            { url: 'historyDepth', valueDuration: { value: 1, system: 'http://unitsofmeasure.org', code: 'a' } }
        ] });
        fhirStore.add(catalog);
        const owned = Object.values(fhirStore.data).flatMap(values => [...values.values()]);
        owned.find(item => item.resourceType === 'Consent').patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
        const approved = require('../../../test-support/approved-resource-fixture').approveResources(owned, { now: Math.floor(Date.now() / 1000) });
        fhirStore.clear(); require('../../../test-support/approved-resource-fixture').installApprovedResources(fhirStore, approved);
        const grant = require('../src/data-grant').resolveGrant({ store: fhirStore, config: teamConfig,
            firstUseStore: { get: () => null }, client: { clientId: 'pcm-sp-local-0001', role: 'service-provider', organizationId: 'org-sp' },
            requested: require('../../../test-support/data-grants').rar('Consent', 'PCM-CONSENT-UNIT'), scope: require('../../../test-support/approved-resource-fixture').CEILING,
            resource: dataSourceAddress, now: Math.floor(Date.now() / 1000) });
        const targetToken = uuidv4();
        const callerBearer = uuidv4();
        tokens.set(targetToken, {
            kind: 'data_source_access',
            active: true,
            sub: 'pcm-sp-local-0001',
            client_id: 'pcm-sp-local-0001',
            organization_id: 'org-sp',
            scope: grant.scope, authorization_details: grant.authorization_details,
            aud: dataSourceAddress,
            pcm_authentication_context: {
                token_endpoint_mtls: { 'x5t#S256': require('../src/crypto').certToX5tS256(fs.readFileSync(path.join(process.env.CERTS_DIR, 'sp-client-assertion.crt'))) },
                client_assertion_signing: { 'x5t#S256': require('../src/crypto').certToX5tS256(fs.readFileSync(path.join(process.env.CERTS_DIR, 'sp-client-assertion.crt'))) },
                correlation_verified: true
            },
            authorization: grant,
            exp: Math.floor(Date.now() / 1000) + 300,
            iat: Math.floor(Date.now() / 1000)
        });
        tokens.set(callerBearer, {
            kind: 'introspection', active: true,
            sub: dataSourceClientId, client_id: dataSourceClientId,
            organization_id: dataSourceOrgId, scope: 'system/*.crus',
            iss: 'https://pcm.example.test', aud: 'https://pcm.example.test/introspect',
            pcm_authentication_context: {
                token_endpoint_mtls: { 'x5t#S256': require('../src/crypto').certToX5tS256(fs.readFileSync(path.join(process.env.CERTS_DIR, 'sp-client-assertion.crt'))) },
                client_assertion_signing: { 'x5t#S256': require('../src/crypto').certToX5tS256(fs.readFileSync(path.join(process.env.CERTS_DIR, 'sp-client-assertion.crt'))) },
                correlation_verified: true
            },
            exp: Math.floor(Date.now() / 1000) + 300,
            iat: Math.floor(Date.now() / 1000)
        });

        const app = express();
        app.use(express.urlencoded({ extended: false }));
        if (mode === 'strict') {
            app.use((req, res, next) => {
                req.socket.encrypted = true;
                req.socket.authorized = true;
                req.socket.getPeerCertificate = () => ({
                    raw: Buffer.from('trusted-test-client'),
                    subject: { CN: 'test-client' }
                });
                next();
            });
        }
        app.use('/', authRoutes);

        const server = http.createServer(app);
        await listen(server);

        try {
            const address = server.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const logicalIssuer = teamConfig.contract.operational.fhirBase;
            process.env.PCM_ISSUER = logicalIssuer;
            tokens.set(callerBearer, { ...tokens.get(callerBearer), aud: `${logicalIssuer}/introspect` });
            await callback({ baseUrl, logicalIssuer, targetToken, callerBearer });
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
        if (previousMode === undefined) delete process.env.PCM_CONFORMANCE_MODE;
        else process.env.PCM_CONFORMANCE_MODE = previousMode;
        if (previousIssuer === undefined) delete process.env.PCM_ISSUER;
        else process.env.PCM_ISSUER = previousIssuer;
        clearPcmModuleCache();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function postIntrospection(baseUrl, targetToken, assertionAudience, assertionOptions = {}) {
    return fetch(`${baseUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: clientAssertion(assertionAudience, assertionOptions),
            token: targetToken,
            token_type_hint: 'access_token'
        })
    });
}

async function postBearerIntrospection(baseUrl, targetToken, callerBearer, extra = {}) {
    return fetch(`${baseUrl}/introspect`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Bearer ${callerBearer}`
        },
        body: new URLSearchParams({ token: targetToken, token_type_hint: 'access_token', ...extra })
    });
}

test('POST /introspect accepts private_key_jwt client authentication in the request body', async t => {
    await t.test('accepts the introspection endpoint as JWT audience', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const response = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/introspect`);
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.active, true);
            assert.equal(body.aud, dataSourceAddress);
            assert.equal(body.client_id, 'pcm-sp-local-0001');
        });
    });

    await t.test('uses the public logical audience across an internal transport route', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const accepted = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/introspect`);
            assert.equal(accepted.status, 200);

            const transportAudience = await postIntrospection(baseUrl, targetToken, `${baseUrl}/introspect`);
            assert.equal(transportAudience.status, 401);
            assert.equal((await transportAudience.json()).error, 'invalid_client');
        }, { logicalIssuer: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4' });
    });

    await t.test('accepts the dedicated introspection bearer and rejects mixed caller auth', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken, callerBearer }) => {
            const response = await postBearerIntrospection(baseUrl, targetToken, callerBearer);
            assert.equal(response.status, 200);
            assert.equal((await response.json()).active, true);

            const mixed = await postBearerIntrospection(baseUrl, targetToken, callerBearer, {
                client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion: clientAssertion(`${baseUrl}/introspect`)
            });
            assert.equal(mixed.status, 400);
            assert.equal((await mixed.json()).error, 'invalid_request');
        });
    });

    await t.test('accepts the token endpoint as JWT audience for compatibility', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const response = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/token`);
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.active, true);
            assert.equal(body.aud, dataSourceAddress);
        });
    });

    await t.test('accepts a JOSE kid only through the selected connectathon adapter', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const response = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/introspect`, { kid: 'legacy-key' });
            assert.equal(response.status, 200);
        });
    });

    await t.test('rejects the token endpoint audience when the adapter is not selected', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const response = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/token`);
            assert.equal(response.status, 401);
            assert.equal((await response.json()).error, 'invalid_client');
        }, { adapters: ['legacy-jose-kid'] });
    });

    await t.test('strict mode rejects legacy audience and JOSE kid', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const legacyAudience = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/token`);
            assert.equal(legacyAudience.status, 401);
            const kid = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/introspect`, { kid: 'legacy-key' });
            assert.equal(kid.status, 401);
        }, { mode: 'strict' });
    });

    await t.test('token and introspection routes share one cross-endpoint replay boundary', async () => {
        await withIntrospectionServer(async ({ baseUrl, logicalIssuer, targetToken }) => {
            const jti = uuidv4();
            const tokenResponse = await fetch(`${baseUrl}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                    client_assertion: clientAssertion(`${logicalIssuer}/token`, { jti }),
                    scope: 'system/*.crus',
                    resource: `${logicalIssuer}/introspect`
                })
            });
            assert.equal(tokenResponse.status, 200);

            const replay = await postIntrospection(baseUrl, targetToken, `${logicalIssuer}/introspect`, { jti });
            assert.equal(replay.status, 401);
            assert.match((await replay.json()).error_description, /already been used/);
        }, { adapters: [] });
    });
});
