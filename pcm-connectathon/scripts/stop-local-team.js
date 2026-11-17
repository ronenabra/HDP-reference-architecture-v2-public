#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, requireSafeTeamId, run, DEFAULT_TEAMS_ROOT } = require('./lib');

const args = parseArgs(process.argv);
const teamId = args['team-id'];
requireSafeTeamId(teamId);

const root = repoRoot();
const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
const envPath = path.join(teamsRoot, teamId, '.env');
if (!fs.existsSync(envPath)) {
    throw new Error(`${path.relative(root, envPath)} does not exist`);
}

const composeArgs = [
    'compose',
    '-f', 'docker-compose.yml',
    '-f', 'pcm-connectathon/compose.ho.yaml',
    '--env-file', envPath,
    '--profile', 'legacy-diagnostic',
    '--profile', 'legacy-node-rollback',
    '--profile', 'import',
    'down'
];
if (args.volumes) composeArgs.push('--volumes');

run('docker', composeArgs, {
    cwd: root,
    env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: teamId
    }
});

console.log(`Stopped local Compose project ${teamId}`);

console.log(`Retained host bind directories: ${path.join(teamsRoot, teamId, 'logs')} and ${path.join(teamsRoot, teamId, 'state')}. --volumes removes Compose volumes only; use start-local-team.js --force to repair retained runtime access.`);
