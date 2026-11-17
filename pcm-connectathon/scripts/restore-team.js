#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, run, requireSafeTeamId, DEFAULT_TEAMS_ROOT } = require('./lib');

const args = parseArgs(process.argv);
if (!args['team-dir']) requireSafeTeamId(args['team-id']);
const teamDir = path.resolve(repoRoot(), args['team-dir'] || path.join(args['teams-root'] || DEFAULT_TEAMS_ROOT, args['team-id']));
const backup = path.resolve(repoRoot(), args.backup || '');
if (!args.backup) throw new Error('usage: restore-team.js --team-dir teams/team-a --backup team-a-backup.zip');
if (!fs.existsSync(backup)) throw new Error(`backup not found: ${backup}`);

const list = run('unzip', ['-Z1', backup], { capture: true });
for (const entry of list.split('\n').filter(Boolean)) {
    if (entry.startsWith('/') || entry.includes('..') || path.isAbsolute(entry)) {
        throw new Error(`unsafe backup path: ${entry}`);
    }
}

fs.mkdirSync(teamDir, { recursive: true });
run('unzip', ['-oq', backup, '-d', teamDir]);
console.log(`Restored ${backup} into ${teamDir}`);
