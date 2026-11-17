const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const contract = require('../../src/shared/pcm-contract');
const fixtures = require('../fixtures/pcm-contract-fixtures.json');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('runtime origins remain independent of immutable canonical vocabulary', () => {
    const local = contract.buildOperationalEndpoints('https://pcm2mtest.health.gov.il/api/fhir-service/r4');
    assert.throws(() => contract.buildOperationalEndpoints('https://localhost:7443', 'https://localhost:7443/team/r4'), /exact declared environment/);

    assert.equal(local.oauthBase, 'https://pcm2mtest.health.gov.il/api/fhir-service/r4');
    assert.equal(local.fhirBase, 'https://pcm2mtest.health.gov.il/api/fhir-service/r4');
    assert.equal(contract.CANONICAL_BASE, 'http://pcm.fhir.health.gov.il');
    assert.equal(contract.CODE_SYSTEMS.organizationType, 'http://pcm.fhir.health.gov.il/cs/pcm-org-type');
    assert.equal(contract.CONSENT_POLICY.uri, 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024');
    assert.equal(contract.OPERATIONAL.fhirBase, 'https://pcm2m.health.gov.il/api/fhir-service/r4');
});

test('opaque client ids, business identifiers, and resource ids are separate identities', () => {
    const config = readJson('pcm-connectathon/example-team-config.json');
    const organization = config.organizations.serviceProvider;

    assert.equal(contract.validateTeamContractConfig(config).length, 0);
    assert.ok(contract.isOpaqueClientId(organization.clientId));
    assert.notEqual(organization.clientId, organization.id);
    assert.notEqual(organization.clientId, `Organization/${organization.id}`);
    assert.notEqual(organization.clientId, organization.businessIdentifier.value);
    assert.equal(
        contract.serializeBusinessIdentifier(organization.businessIdentifier),
        `${contract.IDENTIFIER_SYSTEMS.organization}#${organization.businessIdentifier.value}`
    );
});

test('team contract validation rejects legacy scope, URL client ids, bad thumbprints, and missing roles', () => {
    const base = readJson('pcm-connectathon/example-team-config.json');
    const cases = [
        [config => { config.organizations.serviceProvider.scopes.push(contract.SCOPES.legacyManagement); }, /system\/\*\.cruds/],
        [config => { config.organizations.serviceProvider.clientId = 'https://example.org/Organization/org-sp'; }, /opaque identifier/],
        [config => { config.organizations.serviceProvider.clientId = config.organizations.serviceProvider.businessIdentifier.value; }, /independent/],
        [config => { config.organizations.teamDataSource.certThumbprint = 'not-a-thumbprint'; }, /43-character/],
        [config => { delete config.certificateRoles.serviceProvider.assertion; }, /serviceProvider\.assertion/]
    ];

    for (const [mutate, expected] of cases) {
        const config = clone(base);
        mutate(config);
        assert.match(contract.validateTeamContractConfig(config).join('\n'), expected);
    }
});

test('generated profiles share primary P-256 roles and use a distinct Hospital B P-384 signer', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-contract-certs-'));
    const result = spawnSync('node', [
        'pcm-connectathon/scripts/generate-team-certs.js',
        '--team-id', 'fixture-test',
        '--out', tmp
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const config = readJson('pcm-connectathon/example-team-config.json');
    for (const participant of ['presenceOrchestrator', 'serviceProvider', 'hospitalBServiceProvider', 'referenceDataSource']) {
        const role = config.certificateRoles[participant];
        assert[participant === 'serviceProvider' ? 'equal' : 'notEqual'](role.mtls.cert, role.assertion.cert);
        assert[participant === 'serviceProvider' ? 'equal' : 'notEqual'](role.mtls.key, role.assertion.key);
        const key = fs.readFileSync(path.join(tmp, role.assertion.key), 'utf8');
        const cert = new crypto.X509Certificate(fs.readFileSync(path.join(tmp, role.assertion.cert)));
        assert.equal(require('../../src/shared/assertion-keys').signingAlgorithm(key), participant === 'hospitalBServiceProvider' ? 'ES384' : 'ES256');
        assert.equal(cert.publicKey.asymmetricKeyType, 'ec', participant);
        assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, participant === 'hospitalBServiceProvider' ? 'secp384r1' : 'prime256v1', participant);
        assert.equal(
            crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }),
            cert.publicKey.export({ type: 'spki', format: 'pem' }),
            `${participant} assertion certificate must match its private key`
        );
    }
    for (const hoId of ['ho-a', 'ho-b', 'ho-c']) {
        const cert = new crypto.X509Certificate(fs.readFileSync(path.join(tmp, `${hoId}-hapi.crt`)));
        assert.equal(cert.checkHost(hoId + '-hapi'), hoId + '-hapi');
        assert.equal(cert.checkHost('clinical-import-hapi'), 'clinical-import-hapi');
    }
    const before = fs.readdirSync(tmp).sort().map(name => [
        name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, name))).digest('hex')
    ]);
    const rerun = spawnSync('node', [
        'pcm-connectathon/scripts/generate-team-certs.js',
        '--team-id', 'fixture-test',
        '--out', tmp
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    const after = fs.readdirSync(tmp).sort().map(name => [
        name,
        crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, name))).digest('hex')
    ]);
    assert.deepEqual(after, before);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('patient and lifecycle fixtures cover positive and single-reason negative contract cases', () => {
    for (const fixture of fixtures.patients.positive) {
        assert.deepEqual(contract.validatePatientIdentifier(fixture.identifier), [], fixture.case);
        if (fixture.identifier.system === contract.IDENTIFIER_SYSTEMS.syntheticTest) {
            assert.deepEqual(fixture.security, {
                system: contract.SECURITY.system,
                code: contract.SECURITY.syntheticTestCode
            });
        }
    }
    for (const fixture of fixtures.patients.negative) {
        assert.equal(contract.validatePatientIdentifier(fixture.identifier).length, 1, fixture.case);
    }
    for (const required of ['organization', 'endpoint', 'canonicalService', 'instanceService', 'consent', 'presence']) {
        assert.ok(fixtures.lifecycle[required]?.length > 1, required);
    }
});

test('active service code has no unreviewed legacy PCM vocabulary', () => {
    const forbidden = [
        'http://fhir.health.gov.il/cs/pcm-org-type',
        '2.16.840.1.113883.5.8#TREAT',
        'http://pcm.fhir.health.gov.il/Organization/'
    ];
    const sourceRoots = ['src/pcm-core/src', 'src/sp-client/src', 'src/ds-auth-adapter/src', 'src/ds-fhir-server/src'];
    const files = [];
    for (const root of sourceRoots) {
        const pending = [path.join(repoRoot, root)];
        while (pending.length) {
            const current = pending.pop();
            if (!fs.existsSync(current)) continue;
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const absolute = path.join(current, entry.name);
                if (entry.isDirectory()) pending.push(absolute);
                else if (entry.name.endsWith('.js')) files.push(absolute);
            }
        }
    }
    const violations = [];
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const value of forbidden) {
            if (source.includes(value)) violations.push(`${path.relative(repoRoot, file)}: ${value}`);
        }
    }
    assert.deepEqual(violations, []);
    assert.equal(contract.SCOPES.management, 'system/*.crus');
});
