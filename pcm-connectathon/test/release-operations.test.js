'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const { assertLocalOnlyCommand, LOCAL_ONLY_ENV } = require('../aws/scripts/deploy-lib');
const { scanFiles } = require('../../scripts/scan-release-artifacts');
const { classifyStagingOrigin, commandPlan } = require('../scripts/prepare-staging-validation');
const {
    ACTIVE_SERVICES,
    HEALTH_ORGANIZATION_GATEWAYS,
    gatewayRefreshComposeArgs,
    releasePaths,
    requireRunId,
    utcRunId,
    verifyChecksums,
    writeChecksums
} = require('../scripts/run-local-release');

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('release scanner detects every prohibited artifact class and accepts redacted output', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-release-scan-'));
    try {
        const leaking = path.join(directory, 'leaking.log');
        fs.writeFileSync(leaking, [
            '-----BEGIN PRIVATE KEY-----',
            'Bearer unredacted-token',
            'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
            'client_assertion=not-redacted',
            '"access_token":"not-redacted"',
            'patient=000000018',
            'password=local-only-team-a-ho-a-db'
        ].join('\n'));
        const rules = new Set(scanFiles([leaking]).findings.map(finding => finding.rule));
        for (const expected of ['private-key', 'bearer-token', 'jwt', 'oauth-form-secret', 'oauth-json-secret', 'patient-fixture', 'local-fixture-secret']) {
            assert.ok(rules.has(expected), expected);
        }

        const safe = path.join(directory, 'safe.json');
        fs.writeFileSync(safe, [
            JSON.stringify({ authorization: 'Bearer [REDACTED]', token: '[REDACTED]', patient: '[REDACTED]' }),
            'introspectionAuthModesToTest:',
            '  - bearer',
            'clientAssertionAlgorithms:'
        ].join('\n'));
        assert.deepStrictEqual(scanFiles([safe]).findings, []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('local-only guard rejects cloud, remote-state, registry, and publication commands', () => {
    const env = { [LOCAL_ONLY_ENV]: 'true' };
    assert.throws(() => assertLocalOnlyCommand('aws', ['sts', 'get-caller-identity'], env), /AWS CLI/);
    assert.throws(() => assertLocalOnlyCommand('terraform', ['-chdir=x', 'plan'], env), /Terraform plan/);
    assert.throws(() => assertLocalOnlyCommand('terraform', ['-chdir=x', 'init', '-backend-config=remote'], env), /Terraform init/);
    assert.throws(() => assertLocalOnlyCommand('docker', ['push', 'image'], env), /registry/);
    assert.throws(() => assertLocalOnlyCommand('git', ['push', 'origin'], env), /git push/);
    assert.throws(() => assertLocalOnlyCommand('terraform', ['-chdir=x', 'init', '-backend=false'], env), /plugin-dir/);
    assert.doesNotThrow(() => assertLocalOnlyCommand('terraform', ['-chdir=x', 'init', '-backend=false', '-plugin-dir=/local/provider'], env));
    assert.doesNotThrow(() => assertLocalOnlyCommand('terraform', ['-chdir=x', 'validate'], env));
});

test('AWS wrapper refuses even dry-run planning under the autonomous local-only guard', () => {
    const result = spawnSync('node', ['pcm-connectathon/aws/scripts/manage-baseline.js', 'check', '--dry-run'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, [LOCAL_ONLY_ENV]: 'true' }
    });

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /local-only guard refused Terraform init/);
});

test('offline Terraform validator advertises backend-disabled commands only', () => {
    const result = spawnSync('node', ['pcm-connectathon/aws/scripts/validate-terraform-offline.js', '--dry-run'], {
        cwd: repoRoot,
        encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /init -backend=false -input=false -plugin-dir=/);
    assert.match(result.stdout, /"cloudCalls": 0/);
    assert.doesNotMatch(result.stdout, /backend-config|terraform .* plan|^\[dry-run\] aws /m);
});

test('staging preparation accepts explicit non-production HTTPS and rejects unsafe targets', () => {
    assert.strictEqual(classifyStagingOrigin('https://pcm.staging.example').classification, 'explicit-non-production');
    for (const value of [
        'http://pcm.staging.example',
        'https://localhost:4101',
        'https://pcm2m.health.gov.il',
        'https://service.us-east-1.amazonaws.com'
    ]) {
        assert.throws(() => classifyStagingOrigin(value), /must|not|non-production/);
    }

    const plan = commandPlan('/tmp/staging.yaml', '/tmp/staging-report', '/tmp/PCM-Tester');
    assert.match(plan.nonMutating[0], /^\/tmp\/PCM-Tester\//);
    assert.ok(plan.nonMutating.includes('lifecycle,destructive,operator'));
    assert.ok(plan.mutating.includes('--enable-mutating-staging'));
    assert.ok(plan.mutating.includes('--external-authority-reference'));
    assert.ok(plan.mutating.includes('<REQUIRED-EXTERNAL-AUTHORITY-REFERENCE>'));
});

test('local release paths are repository-local, ignored, distinct from secret-bearing work, and checksummed', () => {
    const runId = utcRunId(new Date('2026-08-30T12:34:56Z'));
    assert.strictEqual(runId, '20260830T123456Z');
    assert.strictEqual(requireRunId(runId), runId);
    assert.throws(() => requireRunId('../escape'), /UTC timestamp/);

    const paths = releasePaths(repoRoot, runId);
    assert.strictEqual(paths.evidenceRoot, path.join(repoRoot, 'tmp/release-evidence/pcm-ig-0.4.0', runId));
    assert.strictEqual(paths.workRoot, path.join(repoRoot, 'tmp/release-work', runId));
    assert.ok(read('.gitignore').split(/\r?\n/).includes('tmp/'));

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-checksums-'));
    try {
        const evidenceRoot = path.join(directory, 'evidence');
        fs.mkdirSync(path.join(evidenceRoot, 'strict-1'), { recursive: true });
        fs.writeFileSync(path.join(evidenceRoot, 'strict-1', 'report.json'), '{}\n');
        fs.writeFileSync(path.join(evidenceRoot, 'summary.txt'), 'complete\n');
        const checksumPaths = { evidenceRoot, checksums: path.join(evidenceRoot, 'SHA256SUMS') };
        assert.strictEqual(writeChecksums(checksumPaths), 2);
        assert.strictEqual(verifyChecksums(checksumPaths), 2);
        fs.appendFileSync(path.join(evidenceRoot, 'summary.txt'), 'changed\n');
        assert.throws(() => verifyChecksums(checksumPaths), /checksum mismatch/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('local release workflow owns sandbox sanity and exports a non-conformant SUT descriptor', () => {
    assert.deepStrictEqual(ACTIVE_SERVICES, [
        'pcm-core', 'sp-client', 'ho-postgres',
        'ho-a-adapter', 'ho-b-adapter', 'ho-c-adapter',
        'ho-a-hapi', 'ho-b-hapi', 'ho-c-hapi',
        'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway'
    ]);
    const source = read('pcm-connectathon/scripts/run-local-release.js');
    assert.match(source, /for \(const ho of \['ho-a', 'ho-b', 'ho-c'\]\)/);
    assert.match(source, /CONNECTATHON COMPATIBILITY EVIDENCE — NOT CONFORMANT/);
    assert.match(source, /export-sut-descriptor\.js/);
    assert.doesNotMatch(source, /pcm_tester|pcm-tester\/.venv|runStrict/);
    assert.match(source, /\[LOCAL_ONLY_ENV\]: 'true'/);
    assert.match(source, /create temporary HAPI SBOM inspection container/);
    assert.match(source, /copy HAPI image SBOM/);
    assert.doesNotMatch(source, /--entrypoint', 'cat'/);
});

test('post-import gateway refresh resolves HAPI replacements without touching dependencies', () => {
    assert.deepStrictEqual(HEALTH_ORGANIZATION_GATEWAYS, [
        'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway'
    ]);
    const args = gatewayRefreshComposeArgs({ teamDir: '/repo/tmp/release-work/run/teams/strict-1' });
    assert.deepStrictEqual(args, [
        'compose',
        '-f', 'docker-compose.yml',
        '-f', 'pcm-connectathon/compose.ho.yaml',
        '--env-file', '/repo/tmp/release-work/run/teams/strict-1/.env',
        'up', '--no-build', '--force-recreate', '--no-deps',
        '-d', '--wait', '--wait-timeout', '240',
        'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway'
    ]);
    assert.ok(!args.some(value => /-hapi$/.test(value)));
});

test('operator documentation identifies supported setup, host requirements and packaging', () => {
    const rootReadme = read('README.md');
    const connectathonReadme = read('pcm-connectathon/README.md');
    const usage = read('docs/public-quickstart.md');
    const contributing = read('CONTRIBUTING.md');
    for (const source of [rootReadme, connectathonReadme, usage]) {
        assert.match(source, /bootstrap-local-team\.js/);
    }
    assert.match(rootReadme, /Root Compose alone is not the supported installation/i);
    const version = JSON.parse(read('package.json')).version;
    assert.ok(rootReadme.includes(`**Release ${version}.**`));
    assert.ok(rootReadme.includes(`docs/releases/${version}.md`));
    assert.match(rootReadme, /datasets are distributed separately/i);
    assert.match(connectathonReadme, /clinical grants, filters and patient-context restrictions/i);
    assert.match(rootReadme, /WSL2/);
    assert.match(rootReadme, /Java 17\+/);
    assert.match(connectathonReadme, /create-local-team\.js/);
    assert.match(connectathonReadme, /start-local-team\.js/);
    assert.match(contributing, /public-release\.js/);
    assert.match(contributing, /source manifest and image digests/);
    assert.match(usage, /--volumes/);
    assert.match(usage, /deletes that team's database/);
    assert.doesNotMatch(rootReadme, /defaults to `latest`/i);
    const developmentBrief = 'pcm-connectathon_coding_agent_instructions.md';
    if (fs.existsSync(path.join(repoRoot, developmentBrief))) {
        assert.match(read(developmentBrief), /Historical design brief — not an operator runbook/);
    } else {
        // The public package deliberately excludes private agent instructions;
        // validate that explicit scope decision instead of requiring their bytes.
        const policy = JSON.parse(read('docs/public-release-scope.json'));
        const manifest = JSON.parse(read('PUBLIC_SOURCE_MANIFEST.json'));
        assert.ok(policy.excludeFiles.includes(developmentBrief));
        assert.ok(!manifest.files.some(file => file.path === developmentBrief));
    }
});

test('neutral and retained AWS callers share capture, dry-run and process failure behavior', t => {
    const { run } = require('../scripts/lib');
    assert.equal(run, require('../aws/scripts/deploy-lib').run);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm command root '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    assert.equal(run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'one argument with spaces'], { cwd: directory, capture: true }), 'one argument with spaces');
    const failure = ['-e', 'process.stdout.write("partial output"); process.stderr.write("diagnostic"); process.exit(7)'];
    assert.throws(() => run(process.execPath, failure, { capture: true }), error => {
        assert.equal(error.status, 7);
        assert.equal(error.exitCode, 7);
        assert.equal(error.stdout, 'partial output');
        assert.equal(error.stderr, 'diagnostic');
        return true;
    });
    assert.equal(run(process.execPath, failure, { capture: true, allowFailure: true }), 'partial output');
    run(process.execPath, ['-e', 'require("fs").writeFileSync("unexpected", "side effect")'], { cwd: directory, dryRun: true });
    assert.equal(fs.existsSync(path.join(directory, 'unexpected')), false);
    assert.throws(() => run('aws', ['sts', 'get-caller-identity'], { dryRun: true, env: { [LOCAL_ONLY_ENV]: 'true' } }), /local-only guard/);
});

test('team backup, reset and restore CLIs resolve an explicit root containing spaces', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm lifecycle root '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const teamId = 'explicit-old-root';
    const teamDir = path.join(directory, 'teams', teamId);
    fs.mkdirSync(path.join(teamDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'state/record.json'), '{"retained":true}');
    fs.writeFileSync(path.join(teamDir, 'team-config.json'), '{"fixture":true}');
    const archive = path.join(directory, 'saved team.zip');
    const common = ['--team-id', teamId, '--teams-root', path.join(directory, 'teams')];
    const invoke = (name, args = []) => {
        const result = spawnSync(process.execPath, [`pcm-connectathon/scripts/${name}-team.js`, ...common, ...args], { cwd: repoRoot, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    };
    invoke('backup', ['--out', archive]);
    invoke('reset');
    assert.equal(fs.existsSync(path.join(teamDir, 'state/record.json')), false);
    assert.equal(fs.readFileSync(path.join(teamDir, 'team-config.json'), 'utf8'), '{"fixture":true}');
    invoke('restore', ['--backup', archive]);
    assert.equal(fs.readFileSync(path.join(teamDir, 'state/record.json'), 'utf8'), '{"retained":true}');
});

/** Public documentation keeps standards external and names the actual anonymous sources. */
test('public contract references resolve through the pinned input lock', () => {
    const manifest = JSON.parse(read('docs/external-contract-inputs.json'));
    const references = read('docs/external-references.md');
    assert.ok(references.includes('https://github.com/MohGovIL/Swagger'));
    assert.ok(references.includes('https://simplifier.net/pcm-il'));
    assert.equal(manifest.activeRelease, require('../../src/shared/pcm-contract').PCM_IG.version);
    for (const name of ['openapi.yaml', 'openapi-fhir.yaml', 'openapi-oauth.yaml']) {
        const pin = manifest.files.find(file => file.path === `docs/${name}`);
        assert.ok(pin.url.includes(manifest.swagger.commit));
        assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    }
    assert.doesNotMatch(references, /github\.com\/ronenabra\/PCM-IG/);
});
