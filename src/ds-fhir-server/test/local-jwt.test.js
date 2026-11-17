const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

process.env.LOG_DIR = process.env.LOG_DIR || path.join(process.env.TEST_TMPDIR || '/tmp', 'ds-fhir-local-jwt-test-logs');

const { clearLocalJwtCache, getPreferredJwksUrls, validateLocalPayload, verifyLocalJwt } = require('../src/local-jwt');

function withEnv(values, fn) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            clearLocalJwtCache();
        });
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function localClaims(patient) {
    return {
        schema: 'pcm-ds-local-token/5',
        policy_stamp: 'test-policy',
        request_binding: { method: 'GET', uri: '/fhir/Observation' },
        authorization_schema: 'pcm-ds-authorization-context/4',
        ho_id: 'ho-a',
        kind: 'data-source-access',
        scenario: 'consent-access',
        sub: 'pcm-sp-client-0001',
        client_id: 'pcm-sp-client-0001',
        scope: 'patient/Observation.rs',
        pcm_issuer: 'https://pcm.example.test',
        pcm_audience: 'https://ho-a.example.test/fhir',
        pcm_expires_at: Math.floor(Date.now() / 1000) + 30,
        authentication: {
            correlationVerified: true,
            tokenEndpointMtlsThumbprint: 'A'.repeat(43),
            clientAssertionSigningThumbprint: 'B'.repeat(43)
        },
        organization: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: 'SP-1' },
        patient_identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' },
        consent_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id', value: 'CONSENT-1' },
        healthcare_service_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-healthcareservice-instance-id', value: 'SERVICE-1' }
    };
}

test('verifyLocalJwt discovers OAuth metadata and verifies against JWKS', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
        ...crypto.createPublicKey(privateKey).export({ format: 'jwk' }),
        kid: 'local-key',
        alg: 'RS256',
        use: 'sig'
    };

    const server = http.createServer((req, res) => {
        const issuer = `http://127.0.0.1:${server.address().port}`;
        if (req.url === '/.well-known/oauth-authorization-server') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` }));
            return;
        }
        if (req.url === '/.well-known/jwks.json') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ keys: [jwk] }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });

    const port = await listen(server);
    const issuer = `http://127.0.0.1:${port}`;
    const token = jwt.sign(localClaims('Patient/local-123'), privateKey, {
        algorithm: 'RS256',
        keyid: 'local-key',
        jwtid: 'local-jti',
        issuer,
        audience: `${issuer}/fhir`,
        expiresIn: '30s'
    });

    try {
        await withEnv({
            LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL: `${issuer}/.well-known/oauth-authorization-server`,
            LOCAL_JWT_ISSUER: issuer,
            HO_ID: 'ho-a',
            LOCAL_JWT_AUDIENCE: `${issuer}/fhir`
        }, async () => {
            const payload = await verifyLocalJwt(token);
            assert.equal(payload.sub, 'pcm-sp-client-0001');
            assert.equal(payload.patient, undefined);
        });
    } finally {
        server.close();
    }
});

test('verifyLocalJwt prefers internal JWKS when metadata is loaded from an internal URL', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
        ...crypto.createPublicKey(privateKey).export({ format: 'jwk' }),
        kid: 'internal-key',
        alg: 'RS256',
        use: 'sig'
    };
    let internalJwksHits = 0;

    const server = http.createServer((req, res) => {
        if (req.url === '/.well-known/oauth-authorization-server') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                issuer: 'https://public-ds.example.test',
                jwks_uri: 'https://public-ds.example.test/.well-known/jwks.json'
            }));
            return;
        }
        if (req.url === '/.well-known/jwks.json') {
            internalJwksHits += 1;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ keys: [jwk] }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });

    const port = await listen(server);
    const metadataUrl = `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`;
    const token = jwt.sign(localClaims('Patient/internal-123'), privateKey, {
        algorithm: 'RS256',
        keyid: 'internal-key',
        jwtid: 'internal-jti',
        issuer: 'https://public-ds.example.test',
        audience: 'urn:ho-a:fhir',
        expiresIn: '30s'
    });

    try {
        await withEnv({
            LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL: metadataUrl
            ,LOCAL_JWT_ISSUER: 'https://public-ds.example.test'
            ,LOCAL_JWT_AUDIENCE: 'urn:ho-a:fhir'
            ,HO_ID: 'ho-a'
        }, async () => {
            assert.deepEqual(getPreferredJwksUrls({
                jwks_uri: 'https://public-ds.example.test/.well-known/jwks.json'
            }), [
                `http://127.0.0.1:${port}/.well-known/jwks.json`,
                'https://public-ds.example.test/.well-known/jwks.json'
            ]);

            const payload = await verifyLocalJwt(token);
            assert.equal(payload.patient, undefined);
            assert.equal(internalJwksHits, 1);
        });
    } finally {
        server.close();
    }
});

test('successful local JWT discovery and cache decisions remain default security evidence', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'local-jwt.js'), 'utf8');

    assert.match(source, /type: 'LOCAL_JWT_DISCOVERY'/);
    assert.match(source, /type: 'LOCAL_JWT_DISCOVERY_SUCCEEDED'/);
    assert.match(source, /type: 'LOCAL_JWT_METADATA_CACHE_HIT'/);
    assert.match(source, /type: 'LOCAL_JWT_JWKS_CACHE_HIT'/);
    assert.match(source, /type: 'LOCAL_JWT_VERIFIED'/);
    assert.match(source, /category: 'security'/);
    assert.match(source, /visibility: 'default'/);
});

test('closed local claims reject pairwise HO and lifetime substitution', () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        ...localClaims('Patient/local-123'),
        iat: now,
        exp: now + 30,
        iss: 'https://ds-auth-adapter.internal/ho-a',
        aud: 'urn:pcm:ho:ho-a:fhir-server',
        jti: 'jti-1'
    };
    return withEnv({ HO_ID: 'ho-a' }, () => {
        assert.equal(validateLocalPayload(claims), claims);
        assert.throws(() => validateLocalPayload({ ...claims, ho_id: 'ho-b' }), /binding/);
        assert.throws(() => validateLocalPayload({ ...claims, exp: now + 31 }), /binding/);
        assert.throws(() => validateLocalPayload({ ...claims, unexpected: true }), /not closed/);
    });
});

test('presence uses a Contract and explicit patient list without a clinical compartment', () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...localClaims('Patient/unused'), iat: now, exp: now + 30,
        iss: 'https://adapter', aud: 'urn:ho-a:fhir', jti: 'presence',
        kind: 'online-presence', scenario: 'presence-check',
        contract_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' },
        presence_identifiers: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }] };
    for (const key of ['patient', 'patient_identifier', 'organization', 'consent_identifier', 'healthcare_service_identifier']) delete claims[key];
    claims.scope = 'system/Patient.s?identifier=http://fhir.health.gov.il/identifier/il-national-id|000000018&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics';
    return withEnv({ HO_ID: 'ho-a' }, () => {
        assert.equal(validateLocalPayload(claims), claims);
        assert.throws(() => validateLocalPayload({ ...claims, patient: 'Patient/one' }), /presence|not closed/);
        assert.throws(() => validateLocalPayload({ ...claims, scope: 'system/Patient.s' }), /presence|not closed/);
        assert.throws(() => validateLocalPayload({ ...claims, schema: 'pcm-ds-local-token/2' }), /binding/);
    });
});

test('legacy selected budget above100 reloads independently of its security identity', async () => {
    const directory = fs.mkdtempSync('/tmp/legacy-presence-105-');
    const configPath = path.join(directory, 'team-config.json');
    const config = require('../../../test-support/team-config').buildTeamConfig({}, 'connectathon-easy');
    config.presence.sources = { legacy: { maxPatients: 105 } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...localClaims(), ho_id: 'legacy-ds', kind: 'batch-presence', scenario: 'presence-check',
        iat: now, exp: now + 30, iss: 'https://adapter', aud: 'urn:legacy:fhir', jti: 'legacy-105',
        contract_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' },
        presence_identifiers: Array.from({ length: 105 }, (_, index) => ({ system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: String(index + 1) })) };
    for (const key of ['patient_identifier', 'organization', 'consent_identifier', 'healthcare_service_identifier']) delete claims[key];
    const { buildEffectivePolicy, simulationPolicyStamp } = require('../../shared/conformance-policy');
    const policy = buildEffectivePolicy(config);
    claims.policy_stamp = simulationPolicyStamp(policy.simulation.perSource['legacy-ds'] || policy.simulation.controls, 'legacy-ds', config.runtime.revision || 0);
    claims.scope = `system/Patient.s?identifier=${claims.presence_identifiers.map(id => `${id.system}|${id.value}`).join(',')}&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics`;
    try {
        await withEnv({ TEAM_CONFIG_PATH: configPath, HO_ID: 'legacy-ds' }, () => {
            assert.equal(validateLocalPayload(claims), claims);
            config.runtime.revision = 1; config.runtime.queryLimitsRevisionOffset = 1;
            fs.writeFileSync(configPath, JSON.stringify(config));
            assert.equal(validateLocalPayload(claims), claims, 'query-only revision retains legacy presence authority');
            config.runtime.revision = 2; fs.writeFileSync(configPath, JSON.stringify(config));
            assert.throws(() => validateLocalPayload(claims), /source policy is stale/);
            config.runtime.revision = 1;
            config.presence.sources.legacy.maxPatients = 100; fs.writeFileSync(configPath, JSON.stringify(config));
            assert.throws(() => validateLocalPayload(claims), /presence/);
        });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('closed legacy context rejects mixed clinical prefixes and identity disagreements', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...localClaims(), iat: now, exp: now + 30, iss: 'https://adapter', aud: 'urn:ho-a:fhir', jti: 'closed-clinical' };
    await withEnv({ HO_ID: 'ho-a', TEAM_CONFIG_PATH: undefined }, () => {
        assert.throws(() => validateLocalPayload({ ...claims, scope: 'patient/Observation.s system/Patient.s' }), /scope context/);
        assert.throws(() => validateLocalPayload({ ...claims, scope: 'patient/Patient.s?identifier=http://fhir.health.gov.il/identifier/il-national-id|000000026' }), /disagrees/);
    });
});
