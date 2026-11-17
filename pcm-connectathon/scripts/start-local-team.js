#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, readValidatedTeamConfig, repoRoot, requireSafeTeamId, run, DEFAULT_TEAMS_ROOT } = require('./lib');
const { buildEffectivePolicy, effectivePolicyReport } = require('../../src/shared/conformance-policy');
const { composeBase, composeUpArgs, readinessWaitTimeout, readinessEnvironment } = require('./lifecycle');
const { planReadinessState } = require('./readiness-state');
const { prepareHapiLogMounts } = require('./hapi-log-preflight');
const { checkRuntimeMounts, repairRuntimeMounts } = require('./runtime-mount-preflight');

/** Start a validated local team; force repairs only after an offline stop.
 * @param {string[]} argv CLI argument vector.
 * @returns {void}
 */
function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (args['no-build'] && args.pull) throw new TypeError('--no-build and --pull cannot be combined');
    readinessWaitTimeout(args['wait-timeout']); // Reject invalid explicit input before reading any team files.
    const teamId = args['team-id'];
    requireSafeTeamId(teamId);

    const root = repoRoot();
    const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
    const envPath = path.join(teamsRoot, teamId, '.env');
    if (!fs.existsSync(envPath)) {
        throw new Error(`${path.relative(root, envPath)} does not exist; run create-local-team.js first`);
    }
    const envText = fs.readFileSync(envPath, 'utf8');
    const readiness = planReadinessState(envText, args['wait-timeout']);
    const waitTimeout = readiness.waitTimeout;
    const envValue = name => envText.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] || '';
    const configPath = path.join(teamsRoot, teamId, 'team-config.json');
    const config = readValidatedTeamConfig(configPath, { checkFiles: true, certsDir: path.join(teamsRoot, teamId, 'certs') });
    const policy = buildEffectivePolicy(config, { PCM_CONFORMANCE_MODE: envValue('PCM_CONFORMANCE_MODE') });
    if (policy.exposure.adminAuthentication === 'required' && !envValue('TEAM_ADMIN_PASSWORD')) {
        throw new Error('strict mode requires TEAM_ADMIN_PASSWORD before any listener starts');
    }

    const teamDir = path.join(teamsRoot, teamId);
    const uid = Number(envValue('LOCAL_UID') || 1000), gid = Number(envValue('LOCAL_GID') || 1000);
    if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('LOCAL_UID and LOCAL_GID must be nonnegative integers');
    if (args.force) {
        // Stop before ownership changes so active writers and operation state stay coherent.
        run('node', ['pcm-connectathon/scripts/stop-local-team.js', '--team-id', teamId, '--teams-root', teamsRoot], { cwd: root });
        repairRuntimeMounts(teamDir, uid, gid, run);
    }
    checkRuntimeMounts(teamDir, uid, gid);
    prepareHapiLogMounts(teamDir, config.healthOrganizations, uid, gid);

    // Persist before Compose so later independent imports/restarts use the same health configuration.
    if (readiness.environment !== envText) fs.writeFileSync(envPath, readiness.environment);

    console.log(JSON.stringify({ teamId, effectivePolicy: effectivePolicyReport(policy) }, null, 2));

    if (args['no-build']) {
        const imagesText = run('docker', [...composeBase(envPath), 'config', '--images'], {
            cwd: root,
            capture: true,
            env: { ...process.env, COMPOSE_PROJECT_NAME: teamId }
        });
        const images = [...new Set(imagesText.split(/\s+/).filter(Boolean))];
        const missing = images.filter(image => {
            try {
                run('docker', ['image', 'inspect', image], { cwd: root, capture: true, forwardOutput: false });
                return false;
            } catch (error) {
                return true;
            }
        });
        if (missing.length) throw new Error(`--no-build requires these local images (no pull attempted): ${missing.join(', ')}; rerun without --no-build to build, or pass --pull without --no-build to opt into pulls`);
    }
    const composeArgs = composeUpArgs(envPath, {
        config,
        noBuild: Boolean(args['no-build']),
        pull: Boolean(args.pull),
        foreground: Boolean(args.foreground),
        waitTimeout
    });

    run('docker', composeArgs, {
        cwd: root,
        env: {
            ...readinessEnvironment(process.env, waitTimeout),
            COMPOSE_PROJECT_NAME: teamId
        }
    });

    if (!args.foreground) {
        console.log(`Started local Compose project ${teamId}`);
    }
}

if (require.main === module) {
    try { main(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
