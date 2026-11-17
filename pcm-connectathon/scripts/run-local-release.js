#!/usr/bin/env node
'use strict';

/**
 * Produce durable, local-only PCM-IG 0.4.0 release evidence.
 *
 * Runtime secrets, generated certificates, databases, and executable tester
 * configs stay below tmp/release-work. Only redacted, reviewable artifacts are
 * written below tmp/release-evidence. The workflow intentionally has no AWS,
 * staging, registry, publication, or Git-remote operation.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, readJson, repoRoot, LOCAL_ONLY_ENV, assertLocalOnlyCommand, run: runCommand } = require('./lib');
const { scanFiles } = require('../../scripts/scan-release-artifacts');

const PCM_IG_RELEASE = '0.4.0';
const EXPECTED_BRANCH = 'codex/pcm-ig-0.3.2-compliance';
const ACTIVE_SERVICES = Object.freeze([
    'pcm-core',
    'sp-client',
    'ho-postgres',
    'ho-a-adapter', 'ho-b-adapter', 'ho-c-adapter',
    'ho-a-hapi', 'ho-b-hapi', 'ho-c-hapi',
    'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway'
]);
const HEALTH_ORGANIZATION_GATEWAYS = Object.freeze([
    'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway'
]);

function utcRunId(date = new Date()) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function requireRunId(runId) {
    if (!/^\d{8}T\d{6}Z$/.test(runId)) {
        throw new TypeError('--run-id must be a UTC timestamp in YYYYMMDDTHHMMSSZ form');
    }
    return runId;
}

function releasePaths(root, runId) {
    requireRunId(runId);
    const evidenceRoot = path.join(root, 'tmp', 'release-evidence', `pcm-ig-${PCM_IG_RELEASE}`, runId);
    const workRoot = path.join(root, 'tmp', 'release-work', runId);
    return {
        evidenceRoot,
        workRoot,
        teamsRoot: path.join(workRoot, 'teams'),
        connectathon: path.join(evidenceRoot, 'connectathon'),
        hapiSupplyChain: path.join(evidenceRoot, 'hapi-supply-chain'),
        commandResults: path.join(evidenceRoot, 'command-results'),
        checksums: path.join(evidenceRoot, 'SHA256SUMS')
    };
}

function writeJson(destination, value) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function relativeTo(root, destination) {
    const relative = path.relative(root, destination);
    return relative || '.';
}

class CommandRecorder {
    constructor(root, destination, baseEnv) {
        this.root = root;
        this.destination = destination;
        this.baseEnv = baseEnv;
        this.records = [];
        this.flush();
    }

    flush() {
        writeJson(this.destination, { localOnly: true, commands: this.records });
    }

    run(label, command, args, options = {}) {
        const env = { ...this.baseEnv, ...(options.env || {}) };
        assertLocalOnlyCommand(command, args, env);
        const startedAt = new Date().toISOString();
        const record = {
            sequence: this.records.length + 1,
            label,
            command,
            args,
            cwd: relativeTo(this.root, options.cwd || this.root),
            environmentKeys: [...new Set(options.environmentKeys || [])].sort(),
            startedAt,
            completedAt: null,
            exitCode: null
        };
        this.records.push(record);
        this.flush();

        const capture = Boolean(options.capture);
        let output;
        let failure;
        try {
            output = runCommand(command, args, { cwd: options.cwd || this.root, env,
                capture, maxBuffer: 64 * 1024 * 1024 });
            record.exitCode = 0;
        } catch (error) {
            failure = error;
            record.exitCode = error.exitCode ?? 1;
            if (error.cause) record.error = String(error.cause.message || error.cause);
        }
        record.completedAt = new Date().toISOString();
        this.flush();
        if (failure && !options.allowFailure) throw failure;
        return capture ? String(output || failure?.stdout || '') : '';

    }
}

function requireCleanCandidate(root) {
    const branch = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
    if (branch.status !== 0) throw new Error('could not determine the current Git branch');
    if (branch.stdout.trim() !== EXPECTED_BRANCH) {
        throw new Error(`local release must run on ${EXPECTED_BRANCH}`);
    }
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: root,
        encoding: 'utf8'
    });
    if (status.status !== 0) throw new Error('could not inspect the Git working tree');
    if (status.stdout.trim()) {
        throw new Error('local release requires a clean working tree; commit the sprint implementation first');
    }
}

function ensureNewRoots(paths) {
    for (const destination of [paths.evidenceRoot, paths.workRoot]) {
        if (fs.existsSync(destination)) {
            throw new Error(`refusing to overwrite existing release path: ${destination}`);
        }
    }
    for (const destination of [
        paths.connectathon,
        paths.hapiSupplyChain,
        paths.commandResults,
        paths.teamsRoot
    ]) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    }
}

function copyRequired(source, destination) {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`required release artifact was not generated: ${source}`);
    }
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o600);
}

function validateBom(bomPath) {
    const bom = readJson(bomPath);
    if (bom.bomFormat !== 'CycloneDX' || typeof bom.specVersion !== 'string') {
        throw new Error('HAPI BOM is not valid CycloneDX JSON');
    }
    if (bom.metadata?.component?.name !== 'pcm-ho-fhir-security') {
        throw new Error('HAPI BOM does not identify pcm-ho-fhir-security');
    }
    const testArtifacts = (bom.components || []).filter(component =>
        /(?:^|[-_.])(junit|assertj|mockito)(?:[-_.]|$)/i.test(String(component.name || ''))
    );
    if (testArtifacts.length) throw new Error('HAPI BOM unexpectedly includes test-scope components');
    return { bomFormat: bom.bomFormat, specVersion: bom.specVersion, components: (bom.components || []).length };
}

function collectHapiSupplyChain(root, paths, recorder) {
    const hapiDir = path.join(root, 'src', 'ho-fhir-server');
    recorder.run('HAPI clean verify and CycloneDX generation', './mvnw', [
        '--batch-mode', '--no-transfer-progress', 'clean', 'verify'
    ], { cwd: hapiDir });
    recorder.run('HAPI third-party license inventory', './mvnw', [
        '--batch-mode', '--no-transfer-progress',
        'org.codehaus.mojo:license-maven-plugin:2.6.0:add-third-party'
    ], { cwd: hapiDir });
    recorder.run('HAPI runtime dependency tree', './mvnw', [
        '--batch-mode', '--no-transfer-progress', 'dependency:tree',
        '-Dscope=runtime', '-DoutputFile=target/dependency-tree.txt'
    ], { cwd: hapiDir });

    const bom = path.join(hapiDir, 'target', 'bom.json');
    const license = path.join(hapiDir, 'target', 'generated-sources', 'license', 'THIRD-PARTY.txt');
    const dependencies = path.join(hapiDir, 'target', 'dependency-tree.txt');
    const copiedBom = path.join(paths.hapiSupplyChain, 'pcm-ho-fhir.cdx.json');
    copyRequired(bom, copiedBom);
    copyRequired(license, path.join(paths.hapiSupplyChain, 'THIRD-PARTY.txt'));
    copyRequired(dependencies, path.join(paths.hapiSupplyChain, 'dependency-tree.txt'));
    copyRequired(
        path.join(hapiDir, 'UPSTREAM-PINS.md'),
        path.join(paths.hapiSupplyChain, 'UPSTREAM-PINS.md')
    );
    return { copiedBom, validation: validateBom(copiedBom) };
}

function teamId(runId, suffix) {
    return `pcm-rel-${runId.toLowerCase().replace(/[tz]/g, '')}-${suffix}`;
}

function teamEnvironment(baseEnv) {
    return {
        ...baseEnv,
        TEAM_ADMIN_PASSWORD: crypto.randomBytes(32).toString('hex')
    };
}

function createAndStartTeam({ root, paths, recorder, runId, suffix, mode, build }) {
    const id = teamId(runId, suffix);
    const env = teamEnvironment(recorder.baseEnv);
    const shared = ['--team-id', id, '--teams-root', paths.teamsRoot];
    recorder.run(`create ${mode} team ${suffix}`, 'node', [
        'pcm-connectathon/scripts/create-local-team.js',
        ...shared,
        '--mode', mode,
        '--port-index', '0',
        '--quiet-secrets'
    ], { env, environmentKeys: ['TEAM_ADMIN_PASSWORD'] });
    const team = {
        id,
        env,
        shared,
        teamDir: path.join(paths.teamsRoot, id),
        configPath: path.join(paths.teamsRoot, id, 'team-config.json'),
        certsDir: path.join(paths.teamsRoot, id, 'certs')
    };
    try {
        recorder.run(`start ${mode} team ${suffix}`, 'node', [
            'pcm-connectathon/scripts/start-local-team.js',
            ...shared,
            ...(build ? [] : ['--no-build'])
        ], { env, environmentKeys: ['TEAM_ADMIN_PASSWORD'] });
    } catch (error) {
        stopTeam(recorder, team, true);
        throw error;
    }
    return team;
}

function importAllHealthOrganizations(root, recorder, team) {
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        recorder.run(`import ${team.id} ${ho}`, 'node', [
            'pcm-connectathon/scripts/run-clinical-import.js',
            ...team.shared,
            '--ho', ho
        ], { env: team.env, environmentKeys: ['TEAM_ADMIN_PASSWORD'] });
    }
    recorder.run(`wait for ${team.id} after imports`, 'node', [
        'pcm-connectathon/scripts/start-local-team.js',
        ...team.shared,
        '--no-build'
    ], { env: team.env, environmentKeys: ['TEAM_ADMIN_PASSWORD'] });
    // A shared image tag can move when Compose builds identical HAPI services
    // concurrently. The post-import reconciliation may therefore recreate a
    // HAPI container while leaving its NGINX gateway running with the old
    // container address. Recreate only the gateways after HAPI health has been
    // established so NGINX resolves every upstream against the final topology.
    recorder.run(`refresh ${team.id} gateways after imports`, 'docker',
        gatewayRefreshComposeArgs(team), {
            env: { ...team.env, COMPOSE_PROJECT_NAME: team.id },
            environmentKeys: ['TEAM_ADMIN_PASSWORD']
        });
}

function gatewayRefreshComposeArgs(team) {
    return [
        'compose',
        '-f', 'docker-compose.yml',
        '-f', 'pcm-connectathon/compose.ho.yaml',
        '--env-file', path.join(team.teamDir, '.env'),
        'up', '--no-build', '--force-recreate', '--no-deps',
        '-d', '--wait', '--wait-timeout', '240',
        ...HEALTH_ORGANIZATION_GATEWAYS
    ];
}

function stopTeam(recorder, team, allowFailure = false) {
    recorder.run(`stop ${team.id} and remove volumes`, 'node', [
        'pcm-connectathon/scripts/stop-local-team.js',
        ...team.shared,
        '--volumes'
    ], {
        env: team.env,
        environmentKeys: ['TEAM_ADMIN_PASSWORD'],
        allowFailure
    });
}

function runSanity(recorder, team, destination) {
    recorder.run(`run ${team.id} sanity`, 'node', [
        'pcm-connectathon/scripts/run-sanity-check.js',
        '--config', team.configPath,
        '--certs-dir', team.certsDir,
        '--output', destination
    ], { env: team.env, environmentKeys: ['TEAM_ADMIN_PASSWORD'] });
}

function runConnectathon({ root, paths, recorder, runId }) {
    const reportDir = paths.connectathon;
    let team;
    let failed = false;
    try {
        team = createAndStartTeam({
            root, paths, recorder, runId, suffix: 'connectathon', mode: 'connectathon', build: true
        });
        importAllHealthOrganizations(root, recorder, team);
        runSanity(recorder, team, path.join(reportDir, 'sanity.json'));
        writeJson(path.join(reportDir, 'classification.json'), {
            label: 'CONNECTATHON COMPATIBILITY EVIDENCE — NOT CONFORMANT',
            conformanceClaim: false
        });
        recorder.run('export secret-free SUT descriptor', 'node', [
            'pcm-connectathon/scripts/export-sut-descriptor.js',
            '--team-config', team.configPath,
            '--output', path.join(reportDir, 'sut-descriptor.json')
        ]);
        return team;
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        if (team) stopTeam(recorder, team, failed);
    }
}

function collectSourceIdentity(root, recorder) {
    const commit = recorder.run('record candidate commit', 'git', ['rev-parse', 'HEAD'], { capture: true }).trim();
    const branch = recorder.run('record candidate branch', 'git', ['branch', '--show-current'], { capture: true }).trim();
    const dirty = recorder.run('record candidate dirty-tree state', 'git', [
        'status', '--porcelain', '--untracked-files=all'
    ], { capture: true }).trim();
    const lock = readJson(path.join(root, 'docs', 'pcm-ig.lock.json'));
    return {
        candidate: { commit, branch, dirty: Boolean(dirty), porcelain: dirty || null },
        pcmIg: {
            release: lock.release,
            repository: lock.source?.repository,
            commit: lock.source?.commit,
            branchAtReview: lock.source?.branchAtReview
        }
    };
}

function collectImages(root, paths, recorder, team, sourceBom) {
    const composeJson = recorder.run('resolve active Compose service images', 'docker', [
        'compose',
        '-f', 'docker-compose.yml',
        '-f', 'pcm-connectathon/compose.ho.yaml',
        '--env-file', path.join(team.teamDir, '.env'),
        'config', '--format', 'json',
        ...ACTIVE_SERVICES
    ], { capture: true, env: { COMPOSE_PROJECT_NAME: team.id } });
    const parsed = JSON.parse(composeJson);
    const imageNames = [...new Set(ACTIVE_SERVICES.map(service => parsed.services?.[service]?.image).filter(Boolean))].sort();
    const inspected = JSON.parse(recorder.run('inspect resolved local images', 'docker', [
        'image', 'inspect', ...imageNames
    ], { capture: true }));
    const images = inspected.map(image => ({
        names: image.RepoTags || [],
        id: image.Id,
        repoDigests: image.RepoDigests || [],
        created: image.Created
    }));
    writeJson(path.join(paths.commandResults, 'resolved-images.json'), {
        services: Object.fromEntries(ACTIVE_SERVICES.map(service => [service, parsed.services[service].image])),
        images
    });

    const embeddedBom = path.join(paths.hapiSupplyChain, 'pcm-ho-fhir.image.cdx.json');
    const sbomContainer = recorder.run('create temporary HAPI SBOM inspection container', 'docker', [
        'create', '--pull=never', 'pcm-ho-fhir:0.4.0'
    ], { capture: true }).trim();
    if (!/^[a-f0-9]{12,64}$/.test(sbomContainer)) {
        throw new Error('Docker did not return a valid temporary HAPI container id');
    }
    try {
        recorder.run('copy HAPI image SBOM', 'docker', [
            'cp', `${sbomContainer}:/app/sbom/pcm-ho-fhir.cdx.json`, embeddedBom
        ]);
    } finally {
        recorder.run('remove temporary HAPI SBOM inspection container', 'docker', [
            'rm', sbomContainer
        ], { allowFailure: true });
    }
    fs.chmodSync(embeddedBom, 0o600);
    validateBom(embeddedBom);
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceBom)).digest('hex');
    const imageHash = crypto.createHash('sha256').update(fs.readFileSync(embeddedBom)).digest('hex');
    writeJson(path.join(paths.hapiSupplyChain, 'sbom-provenance.json'), {
        cleanVerifyArtifact: path.basename(sourceBom),
        runtimeImageArtifact: path.basename(embeddedBom),
        imagePath: '/app/sbom/pcm-ho-fhir.cdx.json',
        cleanVerifySha256: sourceHash,
        runtimeImageSha256: imageHash,
        byteIdenticalAcrossIndependentBuilds: sourceHash === imageHash,
        note: 'Both BOMs are validated; CycloneDX timestamps and serial numbers may differ across independent lifecycle builds.'
    });
}

function filesUnder(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap(entry => {
            const child = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`release evidence must not contain symlinks: ${child}`);
            if (entry.isDirectory()) return filesUnder(child);
            return entry.isFile() ? [child] : [];
        });
}

function writeChecksums(paths) {
    const lines = filesUnder(paths.evidenceRoot)
        .filter(file => file !== paths.checksums)
        .map(file => {
            const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
            return `${digest}  ${path.relative(paths.evidenceRoot, file).split(path.sep).join('/')}`;
        });
    fs.writeFileSync(paths.checksums, `${lines.join('\n')}\n`, { mode: 0o600 });
    return lines.length;
}

function verifyChecksums(paths) {
    const lines = fs.readFileSync(paths.checksums, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/);
        if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
        const destination = path.resolve(paths.evidenceRoot, match[2]);
        const relative = path.relative(paths.evidenceRoot, destination);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('checksum path escapes evidence root');
        const actual = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
        if (actual !== match[1]) throw new Error(`checksum mismatch: ${match[2]}`);
    }
    return lines.length;
}

function finalizeEvidence(paths, sourceIdentity, bomValidation) {
    writeJson(path.join(paths.evidenceRoot, 'release-summary.json'), {
        status: 'complete',
        localOnly: true,
        pcmIgRelease: PCM_IG_RELEASE,
        sourceIdentity,
        hapiBom: bomValidation,
        runs: {
            connectathon: 'CONNECTATHON COMPATIBILITY EVIDENCE — NOT CONFORMANT'
        },
        evidenceRetention: 'repository-local; survives ordinary restart; removable by manual deletion or git clean -fdx',
        externalOperations: 'none'
    });

    const scanPath = path.join(paths.commandResults, 'artifact-scan.json');
    writeJson(scanPath, { status: 'pending' });
    const scan = scanFiles([paths.evidenceRoot]);
    if (scan.findings.length) {
        writeJson(scanPath, { status: 'fail', ...scan });
        throw new Error(`release evidence scanner found ${scan.findings.length} prohibited artifact(s)`);
    }
    writeJson(scanPath, { status: 'pass', ...scan });
    const checksummedFiles = writeChecksums(paths);
    const verifiedFiles = verifyChecksums(paths);
    if (checksummedFiles !== verifiedFiles) throw new Error('not every evidence file was checksum-verified');
    return { scannedFiles: scan.scannedFiles, checksummedFiles };
}

function printPlan(root, runId) {
    const paths = releasePaths(root, runId);
    console.log(JSON.stringify({
        runId,
        localOnly: true,
        evidenceRoot: paths.evidenceRoot,
        workRoot: paths.workRoot,
        phases: [
            'source and local test gates',
            'HAPI supply-chain generation',
            'connectathon team, imports, and sandbox-owned sanity (not conformant)',
            'secret-free SUT descriptor export',
            'secret scan and checksums'
        ],
        prohibited: ['AWS', 'staging', 'remote Terraform', 'registry publication', 'Git remote mutation']
    }, null, 2));
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    const root = repoRoot();
    const runId = requireRunId(String(args['run-id'] || utcRunId()));
    if (args['print-plan']) {
        printPlan(root, runId);
        return;
    }

    requireCleanCandidate(root);
    const paths = releasePaths(root, runId);
    ensureNewRoots(paths);
    const baseEnv = { ...process.env, [LOCAL_ONLY_ENV]: 'true' };
    const recorder = new CommandRecorder(
        root,
        path.join(paths.commandResults, 'commands.json'),
        baseEnv
    );
    writeJson(path.join(paths.evidenceRoot, 'evidence-contract.json'), {
        schemaVersion: 1,
        runId,
        pcmIgRelease: PCM_IG_RELEASE,
        localOnly: true,
        retainedDirectories: ['connectathon', 'hapi-supply-chain', 'command-results'],
        secretBearingWorkRoot: paths.workRoot
    });

    const sourceIdentity = collectSourceIdentity(root, recorder);
    recorder.run('verify root and workspace JavaScript tests', 'npm', ['test']);
    recorder.run('verify repository whitespace', 'git', ['diff', '--check']);
    const hapi = collectHapiSupplyChain(root, paths, recorder);

    const connectathonTeam = runConnectathon({ root, paths, recorder, runId });
    collectImages(root, paths, recorder, connectathonTeam, hapi.copiedBom);
    const finalized = finalizeEvidence(paths, sourceIdentity, hapi.validation);

    console.log(JSON.stringify({
        status: 'complete',
        evidenceRoot: paths.evidenceRoot,
        workRoot: paths.workRoot,
        ...finalized
    }, null, 2));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Local release failed: ${String(error.message || error)}`);
        process.exitCode = 1;
    }
}

module.exports = {
    ACTIVE_SERVICES,
    HEALTH_ORGANIZATION_GATEWAYS,
    PCM_IG_RELEASE,
    filesUnder,
    finalizeEvidence,
    gatewayRefreshComposeArgs,
    releasePaths,
    requireRunId,
    utcRunId,
    validateBom,
    verifyChecksums,
    writeChecksums
};
