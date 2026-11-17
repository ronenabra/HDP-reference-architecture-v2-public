const { buildTeamConfig } = require('../../../test-support/team-config');
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
const spClientId = 'pcm-sp-local-0001';
const spBusinessIdentifier = 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id#PCM-ORG-SP-0001';
const approvedDataSourceResource = 'https://approved-source.example/fhir';
const unlistedDataSourceResource = 'https://unlisted-source.example/fhir';
const logicalIssuer = 'https://pcm2mtest.health.gov.il/api/fhir-service/r4';
const { rar } = require('../../../test-support/data-grants');
const internalResource = 'https://localhost/internal/fhir';
const EXT_PCM_SERVICE = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service';
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

function b2bExtensions(consentReference) {
    return {
        'hl7-b2b': {
            version: '1',
            organization_id: spBusinessIdentifier,
            purpose_of_use: ['http://terminology.hl7.org/CodeSystem/v3-ActReason#TREAT'],
            consent_policy: ['https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024'],
            consent_reference: [consentReference]
        }
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
        '../src/oauth-metadata',
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

function clientAssertion(audience, extensions) {
    const claims = {
        iss: spClientId,
        sub: spClientId,
        aud: audience,
        jti: uuidv4()
    };
    if (extensions) claims.extensions = extensions;

    return jwt.sign(claims, fs.readFileSync(path.join(require('../../../test-support/certificates').certificates(), 'sp-client-assertion.key')), {
        algorithm: 'ES256',
        keyid: jwkThumbprint(fs.readFileSync(path.join(require('../../../test-support/certificates').certificates(), 'sp-client-assertion.key'))),
        expiresIn: '5m'
    });
}

function addApprovedConsent(fhirStore, { serviceActive = true } = {}) {
    fhirStore.add(organization('org-hospital-a-parent', 'parent-org'));
    fhirStore.add({
        ...organization('org-sp', 'service-provider', 'org-hospital-a-parent', 'PCM-ORG-SP-0001')
    });
    fhirStore.add({
        resourceType: 'HealthcareService',
        id: 'svc-canonical',
        active: true,
        meta: {
            profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-canonical'],
            tag: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-meta-tag', code: 'catalog' }]
        },
        identifier: [{
            use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-catalog-id', value: 'CATALOG-1'
        }],
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-service-business-status',
            valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-service-business-status', code: 'active' }
        }]
    });
    fhirStore.add({
        resourceType: 'HealthcareService',
        id: 'svc-active',
        active: serviceActive,
        providedBy: { reference: 'Organization/org-sp' },
        meta: {
            profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-instance'],
            tag: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-meta-tag', code: 'instance' }]
        },
        identifier: [{
            use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-instance-id', value: 'INSTANCE-1'
        }],
        name: 'Approved Service',
        extraDetails: 'Purpose for approved data-source access',
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-service-business-status',
            valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-service-business-status', code: 'active' }
        }, {
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice',
            valueReference: { reference: 'HealthcareService/svc-canonical' }
        }]
    });
    fhirStore.add(organization('org-moh-parent', 'parent-org'));
    fhirStore.add({
        ...organization('org-team-a-ho-a-source', 'source', 'org-moh-parent'),
        endpoint: [{ reference: 'Endpoint/endpoint-vaccine-repo' }]
    });
    fhirStore.add({
        resourceType: 'Endpoint',
        id: 'endpoint-vaccine-repo',
        status: 'active',
        address: approvedDataSourceResource,
        managingOrganization: { reference: 'Organization/org-team-a-ho-a-source' }
    });
    fhirStore.add({
        resourceType: 'Consent',
        id: 'consent-approved',
        identifier: [{ system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'CONSENT-APPROVED' }],
        status: 'active',
        patient: {
            identifier: {
                system: 'http://fhir.health.gov.il/identifier/il-national-id',
                value: '000000018'
            }
        },
        extension: [
            {
                url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status',
                valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-consent-business-status', code: 'active' }
            },
            {
                url: EXT_PCM_SERVICE,
                valueReference: { reference: 'HealthcareService/svc-active' }
            }
        ],
        provision: {
            period: { start: '2020-01-01T00:00:00.000Z', end: '2030-01-01T00:00:00.000Z' },
            actor: [
                {
                    role: { coding: [{ code: 'IRCP' }] },
                    reference: { reference: 'Organization/org-sp' }
                },
                {
                    role: { coding: [{ code: 'CST' }] },
                    reference: { reference: 'Organization/org-team-a-ho-a-source' }
                }
            ]
        }
    });
}

async function withTokenServer(options, callback) {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-token-resource-binding-'));
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    const previousCertsDir = process.env.CERTS_DIR;
    const previousLogDir = process.env.LOG_DIR;
    const previousStateDir = process.env.STATE_DIR;
    const previousIssuer = process.env.PCM_ISSUER;

    try {
        process.env.TEAM_CONFIG_PATH = path.join(tmp, 'team-config.json');
        process.env.CERTS_DIR = require('../../../test-support/certificates').certificates();
        process.env.LOG_DIR = path.join(tmp, 'logs');
        process.env.STATE_DIR = path.join(tmp, 'state');
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(buildTeamConfig({
            security: {
                pcmApi: {
                    clientAuth: 'tls',
                    allowAnyTokenResource: options.allowAnyTokenResource === true,
                    accessTokenExpiresInSeconds: 300
                }
            }
        })));

        clearPcmModuleCache();
        const authRoutes = require('../src/routes/auth');
        require('../src/team-config').getEffectiveConformancePolicy();
        const { tokens } = require('../src/store');
        const fhirStore = require('../src/fhir/store');
        fhirStore.clear();
        fhirStore.add(organization('org-hospital-a-parent', 'parent-org'));
        fhirStore.add(organization('org-sp', 'service-provider', 'org-hospital-a-parent', 'PCM-ORG-SP-0001'));
        if (options.withConsent) {
            addApprovedConsent(fhirStore, { serviceActive: options.serviceActive !== false });
            const catalog = fhirStore.get('HealthcareService', 'svc-canonical');
            catalog.extension.push({ url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-information-bucket', extension: [
                { url: 'bucket', valueCodeableConcept: { coding: [{ system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'laboratoryTests' }] } },
                { url: 'historyDepth', valueDuration: { value: 1, system: 'http://unitsofmeasure.org', code: 'a' } }
            ] });
            fhirStore.add(catalog);
            // Approve while operational, then exercise the requested lifecycle loss separately.
            const instance = fhirStore.get('HealthcareService', 'svc-active'); fhirStore.update({ ...instance, active: true });
            const owned = Object.values(fhirStore.data).flatMap(values => [...values.values()]);
            const approved = require('../../../test-support/approved-resource-fixture').approveResources(owned, { now: Math.floor(Date.now() / 1000) });
            fhirStore.clear(); require('../../../test-support/approved-resource-fixture').installApprovedResources(fhirStore, approved);
            if (options.serviceActive === false) fhirStore.update({ ...fhirStore.get('HealthcareService', 'svc-active'), active: false });
        }

        const app = express();
        app.use(express.urlencoded({ extended: true }));
        app.use('/', authRoutes);

        const server = http.createServer(app);
        await listen(server);

        try {
            const address = server.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;
            process.env.PCM_ISSUER = logicalIssuer;
            const postToken = async ({ resources, authorizationDetails, scope = 'system/*.crus' } = {}) => {
                const tokenEndpoint = `${baseUrl}/token`;
                const params = new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                    client_assertion: clientAssertion(`${logicalIssuer}/token`),
                    scope
                });
                if (authorizationDetails) params.set('authorization_details', JSON.stringify(authorizationDetails));
                for (const resource of (Array.isArray(resources) ? resources : [resources])) {
                    params.append('resource', resource);
                }

                return fetch(tokenEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params
                });
            };

            await callback({ baseUrl, postToken, tokens });
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

test('POST /token rejects multiple resource indicators', async () => {
    await withTokenServer({ allowAnyTokenResource: false }, async ({ postToken, tokens }) => {
        const response = await postToken({ resources: [unlistedDataSourceResource, internalResource] });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, 'invalid_target');
        assert.equal(tokens.size, 0);
    });
});

test('token service startup rejects the legacy debug resource bypass', async () => {
    await assert.rejects(
        withTokenServer({ allowAnyTokenResource: true }, async () => {}),
        /violates the authorization ceiling/
    );
});

test('POST /token rejects a non-PCM resource without consent binding when debug bypass is off', async () => {
    await withTokenServer({ allowAnyTokenResource: false }, async ({ postToken, tokens }) => {
        const response = await postToken({ resources: unlistedDataSourceResource });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, 'invalid_target');
        assert.equal(tokens.size, 0);
    });
});

test('POST /token allows management tokens for this PCM FHIR base', async () => {
    await withTokenServer({ allowAnyTokenResource: false }, async ({ baseUrl, postToken, tokens }) => {
        const pcmFhirResource = logicalIssuer;
        const response = await postToken({ resources: pcmFhirResource });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.ok(tokens.get(body.access_token));
        assert.equal(tokens.get(body.access_token).aud, pcmFhirResource);
        assert.equal(Object.hasOwn(tokens.get(body.access_token), 'cnf'), false);
    });
});

test('POST /token enforces Consent endpoint resource binding for RAR data-source tokens', async () => {
    await withTokenServer({ allowAnyTokenResource: false, withConsent: true }, async ({ baseUrl, postToken, tokens }) => {
        const authorizationDetails = rar('Consent', 'PCM-CONSENT-UNIT').details;
        const approvedResponse = await postToken({
            resources: approvedDataSourceResource,
            authorizationDetails,
            scope: require('../../../test-support/approved-resource-fixture').CEILING
        });
        const approvedBody = await approvedResponse.json();

        assert.equal(approvedResponse.status, 200, JSON.stringify(approvedBody));
        assert.equal(tokens.get(approvedBody.access_token).aud, approvedDataSourceResource);

        const rejectedResponse = await postToken({
            resources: unlistedDataSourceResource,
            authorizationDetails,
            scope: require('../../../test-support/approved-resource-fixture').CEILING
        });
        const rejectedBody = await rejectedResponse.json();

        assert.equal(rejectedResponse.status, 400);
        assert.equal(rejectedBody.error, 'invalid_target');
    });
});

test('POST /token rejects data-source token when referenced consent service is inactive', async () => {
    await withTokenServer({ allowAnyTokenResource: false, withConsent: true, serviceActive: false }, async ({ baseUrl, postToken, tokens }) => {
        const response = await postToken({
            resources: approvedDataSourceResource,
            authorizationDetails: rar('Consent', 'PCM-CONSENT-UNIT').details,
            scope: require('../../../test-support/approved-resource-fixture').CEILING
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, 'invalid_authorization_details');
        assert.match(body.error_description, /Authorization basis is unavailable/);
        assert.equal(tokens.size, 0);
    });
});
