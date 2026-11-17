'use strict';

/** Public package regressions: immutable source, safety, closure and fresh install credentials. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { archiveSource, assertSupportedImageStore, eligible, execute, exportSource, fileDigest, verifyImageManifest, verifySource } = require('../../scripts/public-release');
const { installPlan } = require('../../scripts/public-sandbox');
const { validateModule } = require('../aws/scripts/validate-terraform-offline');
const { writePrivateEnvironment } = require('../scripts/private-env');
const { REQUIRED_SECRETS, encodeEnvironmentValue, readEnvironmentValue, planTeamCredentials } = require('../scripts/team-credentials');

/** Create an isolated committed fixture without altering the development index or refs. */
function repository(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm public source '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execute('git', ['init', '--quiet'], { cwd: root });
    execute('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    execute('git', ['config', 'user.name', 'Public source fixture'], { cwd: root });
    const policy = { includeDirectories: ['src/', 'vendor/'], includeAdditionalDirectories: [], includeFiles: ['docs/public-release-scope.json', 'docs/public-image-spec.json', 'README.md'],
        includeScripts: [], excludeFiles: [], excludeBasenames: ['.env'], excludeDirectories: [], excludePathSegments: ['node_modules'], excludeSuffixes: ['.key'], pcmIgRelease: '0.4.2' };
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'vendor'));
    fs.writeFileSync(path.join(root, 'docs/public-release-scope.json'), JSON.stringify(policy));
    fs.writeFileSync(path.join(root, 'docs/public-image-spec.json'), JSON.stringify({ images: [{ reference: 'owned:${VERSION}', roles: ['fixture'] }] }));
    fs.writeFileSync(path.join(root, 'src/index.js'), 'committed source\n');
    fs.writeFileSync(path.join(root, 'src/.env'), 'private deployment fixture\n');
    fs.writeFileSync(path.join(root, 'README.md'), '[Guide](src/index.js) [Private](private/report.md)\n');
    fs.writeFileSync(path.join(root, 'vendor/README.md'), '[Upstream subset](omitted-upstream.md)\n');
    execute('git', ['add', '.'], { cwd: root });
    execute('git', ['commit', '--quiet', '-m', 'owned fixture'], { cwd: root });
    return root;
}

test('public export uses committed bytes, excludes private inputs and preserves immutable vendor Markdown', t => {
    const root = repository(t), out = path.join(root, 'export');
    fs.writeFileSync(path.join(root, 'src/index.js'), 'uncommitted private work\n');
    const first = exportSource({ root, ref: 'HEAD', output: out });
    assert.equal(fs.readFileSync(path.join(out, 'src/index.js'), 'utf8'), 'committed source\n');
    assert.ok(!fs.existsSync(path.join(out, 'src/.env')));
    assert.match(fs.readFileSync(path.join(out, 'README.md'), 'utf8'), /Private \(development-only reference omitted\)/);
    assert.equal(fs.readFileSync(path.join(out, 'vendor/README.md'), 'utf8'), '[Upstream subset](omitted-upstream.md)\n');
    const second = exportSource({ root, ref: first.sourceTree, output: path.join(root, 'export-again') });
    assert.deepEqual(first.files, second.files, 'explicit immutable tree reproduces all projected bytes');
    assert.equal(verifySource(out).sourceTree, first.sourceTree);
    assert.throws(() => exportSource({ root, ref: 'HEAD', output: out }), /already exist/);
});

test('public export refuses a selected symbolic link instead of dereferencing developer files', t => {
    const root = repository(t);
    fs.symlinkSync('/etc/passwd', path.join(root, 'src/unsafe'));
    execute('git', ['add', 'src/unsafe'], { cwd: root });
    execute('git', ['commit', '--quiet', '-m', 'unsafe fixture'], { cwd: root });
    assert.throws(() => exportSource({ root, ref: 'HEAD', output: path.join(root, 'export') }), /refuses links/);
    assert.ok(!fs.existsSync(path.join(root, 'export')));
});

test('source verification rejects changed bytes and unrecorded private attachments', t => {
    const root = repository(t), out = path.join(root, 'export');
    exportSource({ root, ref: 'HEAD', output: out });
    fs.writeFileSync(path.join(out, 'extra.zip'), 'unexpected attachment');
    assert.throws(() => verifySource(out), /unrecorded/);
    fs.rmSync(path.join(out, 'extra.zip'));
    fs.writeFileSync(path.join(out, 'src/index.js'), 'tampered');
    assert.throws(() => verifySource(out), /hash mismatch/);
});

test('restricted compatibility subtree admits named generic source but rejects generated deployment data', () => {
    const policy = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/public-release-scope.json')));
    assert.equal(eligible('pcm-connectathon/aws/dockerfiles/pcm-core.Dockerfile', policy), true);
    for (const file of ['pcm-connectathon/aws/generated/team-iris-aws-env.json', 'pcm-connectathon/aws/terraform/team/team-python.tfvars',
        'certs/rootCA.key', 'teams/team-a/.env', 'src/sp-client/node_modules/unsafe.js', 'src/pcm-core/backlog.md']) assert.equal(eligible(file, policy), false, file);
});

test('source archives reproduce byte-for-byte without developer timestamps or ownership', t => {
    const root = repository(t), out = path.join(root, 'export');
    exportSource({ root, ref: 'HEAD', output: out });
    const first = archiveSource(out, path.join(root, 'first.tar.gz'));
    fs.utimesSync(path.join(out, 'src/index.js'), new Date(), new Date());
    const second = archiveSource(out, path.join(root, 'second.tar.gz'));
    assert.equal(first.sha256, second.sha256);
});

test('prebuilt installation rejects incomplete/mismatched images and unsafe preset choices before side effects', t => {
    const root = repository(t), out = path.join(root, 'export');
    const source = exportSource({ root, ref: 'HEAD', output: out });
    const image = { reference: 'owned:v1', roles: ['fixture'], id: 'sha256:' + 'a'.repeat(64) };
    const manifest = { schemaVersion: 'pcm-public-images/1', sourceTree: source.sourceTree,
        sourceManifestSha256: fileDigest(path.join(out, 'PUBLIC_SOURCE_MANIFEST.json')), version: 'v1', hapiVersion: 'v1', images: [image] };
    verifyImageManifest(out, manifest);
    assert.throws(() => verifyImageManifest(out, { ...manifest, images: [] }), /incomplete/);
    assert.throws(() => verifyImageManifest(out, { ...manifest, version: 'wrong/path' }), /invalid/);
    const file = path.join(root, 'image-manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest));
    const args = { 'team-id': 'owned-fixture', 'image-manifest': file };
    const plan = installPlan(out, args, () => ({ Id: image.id, Os: 'linux', Architecture: 'amd64' }));
    assert.ok(plan.argv.includes('--no-build'));
    assert.equal(plan.preset, 'connectathon-easy');
    assert.throws(() => installPlan(out, args, () => ({ Id: 'wrong' })), /mismatched/);
    assert.throws(() => installPlan(out, { ...args, preset: 'strict', 'password-free-admin': true }), /strict/);
    assert.ok(!fs.existsSync(plan.teamsRoot));
});

test('archive installation refuses an unqualified image store instead of weakening immutable ID checks', () => {
    assertSupportedImageStore({ DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']] });
    assert.throws(() => assertSupportedImageStore({ DriverStatus: [['Backing Filesystem', 'extfs']] }), /classic image-store installation is not qualified/);
});

test('fresh team generations get distinct private credentials and a private environment file', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm fresh credentials '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const create = team => {
        const result = spawnSync(process.execPath, ['pcm-connectathon/scripts/create-team.js', '--team-id', team, '--teams-root', directory, '--preset', 'strict'],
            { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const file = path.join(directory, team, '.env');
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    };
    const first = create('public-one'), second = create('public-two');
    for (const name of ['TEAM_ADMIN_PASSWORD', 'PCM_POSTGRES_ADMIN_PASSWORD', ...['A', 'B', 'C'].flatMap(letter => [`PCM_${letter}_DB_PASSWORD`, `PCM_${letter}_IMPORT_CREDENTIAL`])]) {
        assert.match(first[name], /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(first[name], second[name], name);
        assert.ok(!first[name].includes('local-only'));
    }
});

test('forced local recreation preserves database/import/Admin credentials and package version pins', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm retained credentials '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const root = path.resolve(__dirname, '../..'), team = path.join(directory, 'public-retained');
    const invoke = (force, override) => {
        const environment = { ...process.env };
        delete environment.TEAM_ADMIN_PASSWORD;
        for (const name of REQUIRED_SECRETS) delete environment[name];
        if (!force) { environment.VERSION = 'public-package-fixture'; environment.PCM_HAPI_VERSION = 'public-hapi-fixture'; }
        else { delete environment.VERSION; delete environment.PCM_HAPI_VERSION; }
        if (override !== undefined) environment.TEAM_ADMIN_PASSWORD = override;
        const result = spawnSync(process.execPath, ['pcm-connectathon/scripts/create-local-team.js', '--team-id', 'public-retained',
            '--teams-root', directory, '--preset', 'strict', '--quiet-secrets', ...(force ? ['--force'] : [])], { cwd: root, env: environment, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return fs.readFileSync(path.join(team, '.env'), 'utf8');
    };
    const first = invoke(false);
    // Compose quoting/dollar escapes are raw retained bytes, never JS replacement directives.
    const quoted = "'owned$$literal-$&-case'";
    fs.writeFileSync(path.join(team, '.env'), first
        .replace(/^PCM_A_DB_PASSWORD=.*$/m, () => `PCM_A_DB_PASSWORD=${quoted}`)
        .replace(/^TEAM_ADMIN_PASSWORD=.*$/m, () => `TEAM_ADMIN_PASSWORD=${quoted}`));
    const before = planTeamCredentials(team, 'strict', {}).values;
    assert.match(first, /^VERSION=public-package-fixture$/m);
    assert.match(first, /^PCM_HAPI_VERSION=public-hapi-fixture$/m);
    const recreated = invoke(true);
    assert.deepEqual(planTeamCredentials(team, 'strict', {}).values, before);
    assert.match(recreated, /^VERSION=public-package-fixture$/m);
    assert.match(recreated, /^PCM_HAPI_VERSION=public-hapi-fixture$/m);
    const changedAdmin = require('node:crypto').randomBytes(32).toString('base64url');
    invoke(true, changedAdmin);
    const after = planTeamCredentials(team, 'strict', {}).values;
    assert.equal(after.TEAM_ADMIN_PASSWORD, changedAdmin);
    for (const name of REQUIRED_SECRETS) assert.equal(after[name], before[name], name);
    assert.equal(fs.statSync(path.join(team, '.env')).mode & 0o777, 0o600);
});

test('incomplete retained credentials fail before forced bootstrap stops or rewrites anything', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm incomplete credentials '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const team = path.join(directory, 'public-incomplete'), root = path.resolve(__dirname, '../..');
    fs.mkdirSync(team);
    const environment = REQUIRED_SECRETS.filter(name => name !== 'PCM_B_DB_PASSWORD').map(name => `${name}=owned-disposable-fixture`).join('\n') + '\nTEAM_ADMIN_PASSWORD=\n';
    const file = path.join(team, '.env');
    fs.writeFileSync(file, environment, { mode: 0o600 });
    fs.writeFileSync(path.join(team, 'team-config.json'), 'unchanged configuration sentinel');
    for (const script of ['create-team.js', 'create-local-team.js', 'bootstrap-local-team.js']) {
        const result = spawnSync(process.execPath, [`pcm-connectathon/scripts/${script}`, '--team-id', 'public-incomplete',
            '--teams-root', directory, '--force'], { cwd: root, encoding: 'utf8' });
        assert.notEqual(result.status, 0, script);
        assert.match(result.stderr, /PCM_B_DB_PASSWORD/);
        assert.doesNotMatch(result.stdout, /replace-stop|repair|Created|Started/);
        assert.equal(fs.readFileSync(file, 'utf8'), environment);
        assert.equal(fs.readFileSync(path.join(team, 'team-config.json'), 'utf8'), 'unchanged configuration sentinel');
        assert.deepEqual(fs.readdirSync(team).sort(), ['.env', 'team-config.json']);
    }
});

test('retained secret validation rejects ambiguity and rotation while preserving deliberate password-free Easy', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm credentials edge '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, '.env');
    const valid = REQUIRED_SECRETS.map(name => `${name}=owned-disposable-fixture`).join('\n') + '\nTEAM_ADMIN_PASSWORD=\n';
    fs.writeFileSync(file, valid, { mode: 0o600 });
    assert.equal(planTeamCredentials(directory, 'connectathon-easy', {}).values.TEAM_ADMIN_PASSWORD, '');
    assert.throws(() => planTeamCredentials(directory, 'strict', {}), /strict requires/);
    assert.throws(() => planTeamCredentials(directory, 'connectathon-easy', { PCM_A_DB_PASSWORD: 'different' }), /cannot rotate PCM_A_DB_PASSWORD/);
    fs.writeFileSync(file, valid + 'PCM_A_DB_PASSWORD=ambiguous\n');
    assert.throws(() => planTeamCredentials(directory, 'connectathon-easy', {}), /exactly one PCM_A_DB_PASSWORD/);
    fs.writeFileSync(file, valid.replace('PCM_A_DB_PASSWORD=owned-disposable-fixture', 'PCM_A_DB_PASSWORD=""'));
    assert.throws(() => planTeamCredentials(directory, 'connectathon-easy', {}), /missing PCM_A_DB_PASSWORD/);
    fs.unlinkSync(file);
    assert.throws(() => planTeamCredentials(directory, 'connectathon-easy', {}), /regular private .env/);
});

test('new operator plaintext is encoded once while retained Compose text remains unchanged', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm plaintext credentials '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const value = 'operator-$$-$NAME';
    assert.equal(encodeEnvironmentValue(value), '"operator-$$$$-$$NAME"');
    assert.equal(encodeEnvironmentValue('normal-base64url_value'), 'normal-base64url_value');
    const plan = planTeamCredentials(path.join(directory, 'fresh'), 'strict', { TEAM_ADMIN_PASSWORD: value });
    assert.equal(plan.values.TEAM_ADMIN_PASSWORD, '"operator-$$$$-$$NAME"');
    const target = path.join(directory, 'retained'); fs.mkdirSync(target);
    const lines = REQUIRED_SECRETS.map(name => `${name}=owned-disposable-fixture`).join('\n');
    fs.writeFileSync(path.join(target, '.env'), `${lines}\nTEAM_ADMIN_PASSWORD="operator-$$$$-$$NAME"\n`);
    assert.equal(planTeamCredentials(target, 'strict', {}).values.TEAM_ADMIN_PASSWORD, '"operator-$$$$-$$NAME"');
    assert.throws(() => encodeEnvironmentValue('invalid\nsecond-line'), /single line/);
    // These are the same four synthetic values independently checked in actual never-started Compose containers.
    for (const plaintext of ['owned-$$-$PCM_P0_DOLLAR_PROOF', 'owned-quote"-backslash\\-$PCM_P0_DOLLAR_PROOF',
        "owned-single'-$$-backslash\\", 'owned-tab\t-$$-$PCM_P0_DOLLAR_PROOF']) {
        assert.equal(readEnvironmentValue(`TEAM_ADMIN_PASSWORD=${encodeEnvironmentValue(plaintext)}\n`, 'TEAM_ADMIN_PASSWORD'), plaintext);
    }
    assert.equal(readEnvironmentValue("PCM_A_DB_PASSWORD='owned$$literal-$&-case'\n", 'PCM_A_DB_PASSWORD'), 'owned$$literal-$&-case');
    assert.throws(() => readEnvironmentValue('TEAM_ADMIN_PASSWORD="unterminated\n', 'TEAM_ADMIN_PASSWORD'), /invalid serialized/);
    assert.throws(() => readEnvironmentValue('TEAM_ADMIN_PASSWORD=first\nTEAM_ADMIN_PASSWORD=second\n', 'TEAM_ADMIN_PASSWORD'), /ambiguous serialized/);
    assert.throws(() => readEnvironmentValue('TEAM_ADMIN_PASSWORD=$UNRESOLVED\n', 'TEAM_ADMIN_PASSWORD'), /ambiguous.*interpolation/);
    for (const value of ['"$UNRESOLVED"', '"${UNRESOLVED}"']) {
        assert.throws(() => readEnvironmentValue(`TEAM_ADMIN_PASSWORD=${value}\n`, 'TEAM_ADMIN_PASSWORD'), /ambiguous.*interpolation/);
    }
    assert.equal(readEnvironmentValue('TEAM_ADMIN_PASSWORD="$$UNRESOLVED"\n', 'TEAM_ADMIN_PASSWORD'), '$UNRESOLVED');
});

test('browser attachment scanning rejects the decoded maintenance secret rather than only serialized env text', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm decoded browser secret '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { selectedMaintenanceSecrets, secretScan } = require('../ui/run-playwright');
    const plaintext = 'owned-browser-secret-$$-$PCM_P0_DOLLAR_PROOF';
    const environment = `PCM_A_IMPORT_CREDENTIAL=${encodeEnvironmentValue(plaintext)}\n`;
    const config = { healthOrganizations: [{ import: { credentialEnv: 'PCM_A_IMPORT_CREDENTIAL' } }] };
    const secrets = selectedMaintenanceSecrets(config, environment, {});
    assert.deepEqual(secrets, [plaintext]);
    const file = path.join(directory, 'attachment.txt');
    fs.writeFileSync(file, 'safe synthetic attachment');
    secretScan(directory, secrets);
    fs.writeFileSync(file, `request diagnostic: ${plaintext}`);
    assert.throws(() => secretScan(directory, secrets), /prohibited secret material/);
});

test('private environment permissions precede secret writes and failed publication preserves the prior file', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm private publication '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, '.env');
    fs.writeFileSync(target, 'previous', { mode: 0o644 });
    const originalWrite = fs.writeFileSync, originalRename = fs.renameSync;
    let privateAtWrite = false;
    fs.writeFileSync = (descriptor, ...rest) => {
        assert.equal(typeof descriptor, 'number');
        assert.equal(fs.fstatSync(descriptor).mode & 0o777, 0o600);
        assert.equal(fs.statSync(target).mode & 0o777, 0o600);
        privateAtWrite = true;
        return originalWrite(descriptor, ...rest);
    };
    try {
        writePrivateEnvironment(target, 'replacement');
        assert.equal(privateAtWrite, true);
        fs.renameSync = () => { throw new Error('owned publication failure'); };
        assert.throws(() => writePrivateEnvironment(target, 'unpublished'), /publication failure/);
    } finally { fs.writeFileSync = originalWrite; fs.renameSync = originalRename; }
    assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
    assert.deepEqual(fs.readdirSync(directory), ['.env']);
});

test('offline Terraform planning has no private provider-cache dependency while real validation still requires it', () => {
    const source = path.resolve(__dirname, '../aws/terraform/baseline');
    const provider = path.join(source, '.terraform/providers');
    const realExists = fs.existsSync;
    fs.existsSync = name => String(name).includes('.terraform') ? false : realExists(name);
    try {
        const result = validateModule('baseline', { dryRun: true });
        assert.equal(result.status, 'planned');
        assert.throws(() => validateModule('baseline'), /provider cache is missing/);
    } finally { fs.existsSync = realExists; }
    assert.ok(provider.endsWith('.terraform/providers'));
});

test('nested public scanner rejects hidden private keys, corrupt archives and unsafe archive paths', () => {
    const result = spawnSync('python3', ['scripts/test_scan_public_package.py'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});
