#!/usr/bin/env node
'use strict';

/** Canonical clean-checkout connectathon bootstrap. */

const path = require('path');
const fs = require('fs');
const { parseArgs, repoRoot, run, requireSafeTeamId, readValidatedTeamConfig, writeJson, portSet, DEFAULT_TEAMS_ROOT } = require('./lib');
const { repairRuntimeMounts } = require('./runtime-mount-preflight');
const { planTeamCredentials } = require('./team-credentials');
const { configureWorkflowFixtures } = require('./configure-system-workflow-fixtures');
const { checkPorts, readinessWaitTimeout, readinessEnvironment } = require('./lifecycle');
const { inspectTransactionBundle, safeBundlePath } = require('../../clinical-data/transaction-bundle');

/**
 * Build the command vectors used to replace or clean up one local team.
 *
 * @param {object} options
 * @param {string} options.teamId
 * @param {string} options.teamsRoot
 * @param {number} options.portIndex
 * @param {string} options.preset
 * @param {boolean} [options.force]
 * @param {boolean} [options.volumes]
 * @param {boolean} [options.existingTeam]
 * @returns {{commonArgs: string[], stopArgs: string[]|null, createArgs: string[], cleanupCommand: string[]}}
 */
function buildBootstrapPlan({ teamId, teamsRoot, portIndex, preset, environment, doctorBaseUrl, force = false, volumes = false, existingTeam = false }) {
    if (volumes && !force) throw new TypeError('--volumes requires --force when used with bootstrap-local-team.js');
    const commonArgs = ['--team-id', teamId, '--teams-root', teamsRoot];
    return {
        commonArgs,
        stopArgs: existingTeam && force
            ? ['pcm-connectathon/scripts/stop-local-team.js', ...commonArgs, ...(volumes ? ['--volumes'] : [])]
            : null,
        createArgs: [
            'pcm-connectathon/scripts/create-local-team.js',
            ...commonArgs,
            '--port-index', String(portIndex),
            '--preset', preset,
            ...(environment ? ['--environment', environment] : []),
            ...(doctorBaseUrl ? ['--doctor-base-url', doctorBaseUrl] : []),
            '--quiet-secrets',
            ...(force ? ['--force'] : [])
        ],
        cleanupCommand: [
            'node',
            'pcm-connectathon/scripts/stop-local-team.js',
            ...commonArgs,
            ...(volumes ? ['--volumes'] : [])
        ]
    };
}

/** Apply an explicit producer-bundle mapping to one disposable team config. */
function configureClinicalBootstrap(configPath, args) {
    const mappingRequested = ['ho-a', 'ho-b', 'ho-c'].some(id => args[`${id}-bundle`] || args[`${id}-source`]);
    if (!mappingRequested) return readValidatedTeamConfig(configPath);
    if (!args['bundle-root']) throw new TypeError('explicit clinical bootstrap requires --bundle-root');
    const config = readValidatedTeamConfig(configPath);
    // Validate all mappings and producer bytes before changing the mounted projection.
    const selections = config.healthOrganizations.map(ho => {
        const bundleReference = args[`${ho.id}-bundle`];
        const expectedSource = args[`${ho.id}-source`];
        if (!bundleReference || !expectedSource) throw new TypeError(`explicit clinical bootstrap requires --${ho.id}-bundle and --${ho.id}-source`);
        return { ho, bundleReference, expectedSource };
    }).map(selection => {
        const bytes = fs.readFileSync(safeBundlePath(path.resolve(args['bundle-root']), selection.bundleReference));
        const inspected = inspectTransactionBundle(bytes, { limits: selection.ho.clinicalData.limits });
        if (inspected.source !== selection.expectedSource) throw new TypeError(`${selection.ho.id}: selected bootstrap source mismatch`);
        return { ...selection, bytes };
    });
    const mountedRoot = path.join(path.dirname(configPath), 'bundles');
    fs.mkdirSync(mountedRoot, { recursive: true });
    const mountedReal = fs.realpathSync(mountedRoot);
    for (const { ho, bundleReference, expectedSource, bytes } of selections) {
        const destination = path.resolve(mountedRoot, bundleReference);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const parent = fs.realpathSync(path.dirname(destination));
        if (parent !== mountedReal && !parent.startsWith(mountedReal + path.sep)) throw new TypeError('runtime bundle projection escapes mounted root');
        const pending = `${destination}.bootstrap-${process.pid}`;
        try { fs.writeFileSync(pending, bytes); fs.renameSync(pending, destination); }
        finally { fs.rmSync(pending, { force: true }); }
        ho.clinicalData.bootstrap = {
            policy: args['bootstrap-policy'] || 'if-empty', bundleReference, expectedSource
        };
    }
    writeJson(configPath, config);
    return readValidatedTeamConfig(configPath);
}

/** Install only an explicitly supplied qualification population before runtime/sanity startup. */
function configurePresenceEligibility(configPath, eligibilityFile) {
    const config = readValidatedTeamConfig(configPath);
    config.systemAuthorization.presenceEligiblePatients = JSON.parse(fs.readFileSync(eligibilityFile, 'utf8'));
    require('../../src/shared/team-config-validator').assertValidTeamConfig(config, { env: {} });
    writeJson(configPath, config);
    return config;
}

async function main(argv = process.argv) {
    const args = parseArgs(argv);
    const waitTimeout = readinessWaitTimeout(args['wait-timeout']);
    const runtimeEnvironment = readinessEnvironment(process.env, waitTimeout);
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14).toLowerCase();
    const teamId = args['team-id'] || `event-${stamp}`;
    requireSafeTeamId(teamId);
    const root = repoRoot();
    const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
    const force = args.force === true;
    const volumes = args.volumes === true;
    const teamDir = path.join(teamsRoot, teamId);
    const existingTeam = fs.existsSync(teamDir);
    if (volumes && !force) throw new TypeError('--volumes requires --force when used with bootstrap-local-team.js');

    const commonArgs = ['--team-id', teamId, '--teams-root', teamsRoot];
    if (existingTeam && force) {
        // Validate retained secrets before even stopping or repairing the selected project.
        planTeamCredentials(teamDir, args.preset || 'connectathon-easy', runtimeEnvironment);
        const envPath = path.join(teamDir, '.env');
        if (!fs.existsSync(envPath)) {
            throw new Error(`${path.relative(root, teamDir)} cannot be force-recreated safely because its .env file is missing`);
        }
        console.log(JSON.stringify({ phase: 'replace-stop', teamId, volumes }));
        run('node', [
            'pcm-connectathon/scripts/stop-local-team.js',
            ...commonArgs,
            ...(volumes ? ['--volumes'] : [])
        ], { cwd: root, env: runtimeEnvironment });
    }

    if (existingTeam && force) {
        // Replacement uses the current host identity, as create-team.js does.
        repairRuntimeMounts(teamDir, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000, run);
    }

    let portIndex = args['port-index'] === undefined ? 0 : Number(args['port-index']);
    let ports;
    while (portIndex <= 99) {
        ports = portSet({}, portIndex);
        const probes = await checkPorts([ports.sp, ports.pcmUi, ports.pcmApi, ports.pcmMetadata, ports.ds, ports.ds + 1, ports.ds + 2, ports.dsLegacy, ports.dsHttp]);
        if (probes.every(probe => probe.available)) break;
        if (args['port-index'] !== undefined) {
            const conflicts = probes.filter(probe => !probe.available).map(probe => probe.port);
            throw new Error(`requested port set is unavailable: ${conflicts.join(', ')}; choose another --port-index`);
        }
        portIndex += 1;
    }
    if (portIndex > 99) throw new Error('no free connectathon port set found from indexes 0 through 99');
    const plan = buildBootstrapPlan({ teamId, teamsRoot, portIndex, preset: args.preset || 'connectathon-easy', environment: args.environment, doctorBaseUrl: args['doctor-base-url'], force, volumes, existingTeam });
    const common = plan.commonArgs;
    console.log(JSON.stringify({ phase: 'create', teamId, preset: args.preset || 'connectathon-easy', portIndex }));
    run('node', plan.createArgs, { cwd: root, env: runtimeEnvironment });
    configureClinicalBootstrap(path.join(teamDir, 'team-config.json'), args);
    if (args['presence-eligibility-file']) {
        const configPath = path.join(teamDir, 'team-config.json');
        configurePresenceEligibility(configPath, args['presence-eligibility-file']);
    }
    if (args['system-workflow-fixtures']) {
        const configPath = path.join(teamDir, 'team-config.json');
        writeJson(configPath, configureWorkflowFixtures(readValidatedTeamConfig(configPath)));
    }
    try {
        console.log(JSON.stringify({ phase: 'start', teamId }));
        const startArgs = ['pcm-connectathon/scripts/start-local-team.js', ...common, '--wait-timeout', String(waitTimeout)];
        if (args['no-build']) startArgs.push('--no-build');
        if (args.pull) startArgs.push('--pull');
        run('node', startArgs, { cwd: root, env: runtimeEnvironment });
        if (args['empty-sanity-output']) {
            console.log(JSON.stringify({ phase: 'fresh-empty-sanity', teamId }));
            run('node', ['pcm-connectathon/scripts/run-sanity-check.js', '--no-fixture-setup', '--config', path.join(teamDir, 'team-config.json'),
                '--certs-dir', path.join(teamDir, 'certs'), '--team-env', path.join(teamDir, '.env'), '--output', args['empty-sanity-output']],
            { cwd: root, env: runtimeEnvironment });
        }
        console.log(JSON.stringify({ phase: 'clinical-data-bootstrap', teamId }));
        run('node', [
            'pcm-connectathon/scripts/run-clinical-import.js', ...common, '--all',
            ...(args['bundle-root'] ? ['--bundle-root', path.resolve(args['bundle-root'])] : [])
        ], { cwd: root, env: runtimeEnvironment });
        console.log(JSON.stringify({ phase: 'sanity', teamId }));
        run('node', [
            'pcm-connectathon/scripts/run-sanity-check.js', ...(args['bundle-root'] ? ['--fixture-root', args['bundle-root']] : []),
            '--config', path.join(teamDir, 'team-config.json'),
            '--certs-dir', path.join(teamDir, 'certs'),
            '--team-env', path.join(teamDir, '.env'),
            ...(args['require-clinical'] ? ['--require-clinical'] : []),
            ...(args['sanity-output'] ? ['--output', args['sanity-output']] : [])
        ], { cwd: root, env: runtimeEnvironment });
    } catch (error) {
        console.error(`Bootstrap stopped: ${error.message}`);
        console.error(`Diagnostics: docker compose -p ${teamId} ps && docker compose -p ${teamId} logs`);
        console.error(`Cleanup: ${plan.cleanupCommand.join(' ')}`);
        throw error;
    }
    console.log(`Doctor: http://localhost:${ports.sp}`);
    console.log(`Patient/Admin: http://localhost:${ports.pcmUi}`);
    console.log(`Evidence/work directory: ${path.relative(root, teamsRoot)}/${teamId}`);
    console.log(`Cleanup: ${plan.cleanupCommand.join(' ')}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { buildBootstrapPlan, configureClinicalBootstrap, configurePresenceEligibility, main };
