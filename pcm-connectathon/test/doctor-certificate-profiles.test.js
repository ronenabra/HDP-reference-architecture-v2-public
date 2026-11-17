'use strict';

/** Default and retained-profile migration with real disposable material and offline recovery. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { certificates } = require('../../test-support/certificates');
const { buildTeamConfig } = require('../../test-support/team-config');
const { prepareDoctorProfiles } = require('../../src/shared/doctor-certificate-profiles');
const { publishFiles } = require('../../src/shared/role-credentials');
const { applyRenewal } = require('../scripts/rotate-team-certificates');
const { signingAlgorithm, certificateConfirmation, jwkThumbprint } = require('../../src/shared/assertion-keys');

/** Own a complete older team graph, including its retained clinical sentinel. */
function retained(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-migration-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const certs = path.join(directory, 'certs'); fs.cpSync(certificates(), certs, { recursive: true });
    const config = buildTeamConfig(); config.runtime.stateDir = path.join(directory, 'state');
    fs.mkdirSync(config.runtime.stateDir); fs.writeFileSync(path.join(config.runtime.stateDir, 'clinical-sentinel'), 'retained');
    config.certificateRoles.serviceProvider.mtls = { cert: 'sp-client.crt', key: 'sp-client.key' };
    config.certificates.serviceProvider = { ...config.certificateRoles.serviceProvider.mtls };
    for (const suffix of ['crt', 'key']) fs.copyFileSync(path.join(certs, `sp-client-assertion.${suffix}`), path.join(certs, `hospital-b-sp-assertion.${suffix}`));
    config.organizations.hospitalBServiceProvider.assertionCertificates = { ES256: ['hospital-b-sp-assertion.crt'] };
    const originalConfig = Buffer.from(JSON.stringify(config)); fs.writeFileSync(path.join(directory, 'team-config.json'), originalConfig);
    fs.writeFileSync(path.join(directory, '.env'), `LOCAL_UID=${process.getuid()}\nLOCAL_GID=${process.getgid()}\nTEAM_ADMIN_PASSWORD=owned-only\n`);
    return { directory, certs, config, originalConfig };
}

test('preview stages only Hospital B P-384, shares primary aliases and preserves stable identities and sources', t => {
    const f = retained(t), before = fs.readFileSync(path.join(f.certs, 'hospital-b-sp-assertion.key'));
    const prepared = prepareDoctorProfiles(f.config, f.certs);
    assert.deepEqual(prepared.config.certificateRoles.serviceProvider.mtls, f.config.certificateRoles.serviceProvider.assertion);
    assert.deepEqual(prepared.config.organizations.serviceProvider, f.config.organizations.serviceProvider);
    assert.deepEqual(prepared.config.healthOrganizations, f.config.healthOrganizations);
    assert.deepEqual(prepared.config.organizations.hospitalBServiceProvider.redirectUris, f.config.organizations.hospitalBServiceProvider.redirectUris);
    assert.equal(signingAlgorithm(prepared.material['hospital-b-sp-assertion.key']), 'ES384');
    assert.equal(prepared.config.organizations.hospitalBServiceProvider.assertionCertificates.ES256, undefined);
    assert.equal(prepared.rootChanged, false); assert.deepEqual(fs.readFileSync(path.join(f.certs, 'hospital-b-sp-assertion.key')), before);
    publishFiles(f.certs, prepared.material);
    assert.equal(prepareDoctorProfiles(prepared.config, f.certs).changed, false);
    const primary = new crypto.X509Certificate(fs.readFileSync(path.join(f.certs, prepared.config.certificateRoles.serviceProvider.mtls.cert)));
    assert.equal(primary.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('failed controlled profile recreation restores old role aliases, signer and clinical sentinel', t => {
    const f = retained(t), prepared = prepareDoctorProfiles(f.config, f.certs), before = fs.readFileSync(path.join(f.certs, 'hospital-b-sp-assertion.key'));
    assert.throws(() => applyRenewal({ teamId: 'owned-profile', teamDir: f.directory, prepared, originalConfig: f.originalConfig,
        execute(_cmd, args) { if (args.includes('up')) throw Error('profile recreation fault'); } }), /restored/);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'team-config.json')), f.originalConfig);
    assert.deepEqual(fs.readFileSync(path.join(f.certs, 'hospital-b-sp-assertion.key')), before);
    assert.equal(fs.readFileSync(path.join(f.config.runtime.stateDir, 'clinical-sentinel'), 'utf8'), 'retained');
});

test('actual transport certificate confirmation is distinct from signing JWK identity and accepts PEM or DER', () => {
    const directory = certificates(), cert = fs.readFileSync(path.join(directory, 'hospital-b-sp.crt'));
    assert.deepEqual(certificateConfirmation(cert), certificateConfirmation(new crypto.X509Certificate(cert).raw));
    assert.notEqual(certificateConfirmation(cert)['x5t#S256'], jwkThumbprint(fs.readFileSync(path.join(directory, 'hospital-b-sp-assertion.crt'))));
    assert.throws(() => certificateConfirmation('untrusted caller-supplied thumbprint'));
});

test('ordinary provisioning refuses retained P-256 Hospital B without publishing any files', t => {
    const f = retained(t);
    const snapshot = () => Object.fromEntries(fs.readdirSync(f.certs).filter(name => fs.statSync(path.join(f.certs, name)).isFile()).map(name => [name, fs.readFileSync(path.join(f.certs, name))]));
    const before = snapshot();
    const result = require('node:child_process').spawnSync(process.execPath, ['pcm-connectathon/scripts/generate-team-certs.js', '--team-id', 'owned-profile', '--out', f.certs], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /migrate-doctor-profiles.js/); assert.deepEqual(snapshot(), before);
});
