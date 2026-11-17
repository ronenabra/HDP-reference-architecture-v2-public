#!/usr/bin/env node
const path = require('path');
const { parseArgs, repoRoot, run, requireSafeTeamId, DEFAULT_TEAMS_ROOT } = require('./lib');

const args = parseArgs(process.argv);
if (!args['team-dir']) requireSafeTeamId(args['team-id']);
const teamDir = path.resolve(repoRoot(), args['team-dir'] || path.join(args['teams-root'] || DEFAULT_TEAMS_ROOT, args['team-id']));
const out = path.resolve(repoRoot(), args.out || 'team-backup.zip');

run('zip', ['-qr', out, '.'], { cwd: teamDir });
console.log(`Wrote ${out}`);
