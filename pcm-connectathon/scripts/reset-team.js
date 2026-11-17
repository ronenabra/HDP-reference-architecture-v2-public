#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, requireSafeTeamId, DEFAULT_TEAMS_ROOT } = require('./lib');

const args = parseArgs(process.argv);
const teamId = args['team-id'];
requireSafeTeamId(teamId);

const teamDir = path.resolve(repoRoot(), args['teams-root'] || DEFAULT_TEAMS_ROOT, teamId);
for (const subdir of ['logs', 'state']) {
    fs.rmSync(path.join(teamDir, subdir), { recursive: true, force: true });
    fs.mkdirSync(path.join(teamDir, subdir), { recursive: true });
}

console.log(`Reset logs/state for ${teamId}. Config and certs were preserved.`);
