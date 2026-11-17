#!/usr/bin/env node
'use strict';

/** Populate one explicitly selected local synthetic installation using packaged images. */
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { argumentsMap, execute, verifyImageManifest, verifySource } = require('./public-release');
const { requireSafeTeamId } = require('../pcm-connectathon/scripts/lib');
const { loadCiDataset } = require('../pcm-connectathon/scripts/full-coverage');

/** Resolve supported install inputs and check all source/image identities before startup. */
function installPlan(root, args, inspect = reference => JSON.parse(execute('docker', ['image', 'inspect', reference]))[0]) {
    const teamId = args['team-id'];
    requireSafeTeamId(teamId);
    const preset = args.preset || 'connectathon-easy';
    if (!['strict', 'connectathon-easy', 'connectathon-balanced', 'connectathon-mtls'].includes(preset)) throw new Error('unknown preset');
    if (args['password-free-admin'] && preset === 'strict') throw new Error('strict cannot use password-free Admin');
    const source = verifySource(root, { allowGenerated: true });
    const manifest = JSON.parse(fs.readFileSync(path.resolve(args['image-manifest'])));
    verifyImageManifest(root, manifest);
    for (const image of manifest.images) {
        const actual = inspect(image.reference);
        if (actual.Id !== image.id || actual.Os !== 'linux' || actual.Architecture !== 'amd64') throw new Error(`missing/mismatched local image: ${image.reference}; load the exact package first`);
    }
    const teamsRoot = path.resolve(root, args['teams-root'] || 'tmp/public-teams');
    if (fs.existsSync(path.join(teamsRoot, teamId))) throw new Error('team already exists; use start-local-team.js for restart, or choose a new team ID');
    const argv = ['pcm-connectathon/scripts/bootstrap-local-team.js', '--team-id', teamId,
        '--teams-root', teamsRoot, '--preset', preset, '--environment', args.environment || 'production', '--no-build'];
    if (args['port-index'] !== undefined) argv.push('--port-index', String(args['port-index']));
    if (args['wait-timeout'] !== undefined) argv.push('--wait-timeout', String(args['wait-timeout']));
    let dataset = null;
    if (args.populated) {
        dataset = loadCiDataset(path.join(root, 'clinical-data/ci/manifest.json'));
        argv.push('--bundle-root', dataset.root, '--require-clinical',
            ...dataset.bundles.flatMap(bundle => [`--${bundle.serverId}-bundle`, bundle.file, `--${bundle.serverId}-source`, bundle.source]));
    }
    return { teamId, preset, teamsRoot, argv, dataset, version: manifest.version, hapiVersion: manifest.hapiVersion,
        passwordFree: Boolean(args['password-free-admin']), sourceTree: source.sourceTree };
}

/** Start a fresh local install; credentials remain in private generated state, never CLI arguments. */
function main(argv = process.argv.slice(2)) {
    const root = path.resolve(__dirname, '..'), args = argumentsMap(argv), plan = installPlan(root, args);
    const environment = { ...process.env, VERSION: plan.version, PCM_HAPI_VERSION: plan.hapiVersion,
        TEAM_ADMIN_PASSWORD: plan.passwordFree ? '' : process.env.TEAM_ADMIN_PASSWORD || randomBytes(32).toString('base64url'),
        PCM_AUTONOMOUS_LOCAL_ONLY: 'true' };
    if (plan.dataset) {
        const eligible = [...new Map(plan.dataset.bundles.flatMap(bundle => bundle.inspected.patients)
            .map(patient => [`${patient.idSystem}|${patient.idValue}`, { system: patient.idSystem, value: patient.idValue }])).values()];
        const directory = path.join(plan.teamsRoot, '.fixture-inputs');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${plan.teamId}.presence-eligibility.json`);
        fs.writeFileSync(file, JSON.stringify(eligible), { mode: 0o600 });
        plan.argv.push('--presence-eligibility-file', file);
    }
    console.log('LOCAL SYNTHETIC SANDBOX: all presets retain full non-AWS diagnostics. Protect generated state.');
    if (plan.preset === 'connectathon-easy') console.log('Easy relaxes authentication and transport simulations; clinical grants and patient-context restrictions remain enforced. It is not production security.');
    if (plan.passwordFree) console.log('Password-free Admin explicitly selected: anyone reaching the local UI can use its management actions.');
    execute(process.execPath, plan.argv, { cwd: root, env: environment, stdio: 'inherit' });
    console.log(`Install complete. Admin password, if enabled, is in ${path.join(plan.teamsRoot, plan.teamId, '.env')} (mode 0600); do not share it.`);
    return { status: 'pass', teamId: plan.teamId, preset: plan.preset, sourceTree: plan.sourceTree };
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { installPlan, main };
