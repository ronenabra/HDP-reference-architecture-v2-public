#!/usr/bin/env node
'use strict';

/** Preview by default; explicit apply backs up and recreates only the selected local team. */
const fs = require('node:fs'), path = require('node:path');
const { parseArgs, repoRoot, requireSafeTeamId, readValidatedTeamConfig, DEFAULT_TEAMS_ROOT } = require('./lib');
const { prepareDoctorProfiles } = require('../../src/shared/doctor-certificate-profiles');
const { applyRenewal } = require('./rotate-team-certificates');

/** Apply the bounded retained-profile transition through accepted offline publication/recovery. */
function main(argv = process.argv) {
    const args = parseArgs(argv); requireSafeTeamId(args['team-id']);
    const teamDir = path.resolve(repoRoot(), args['teams-root'] || DEFAULT_TEAMS_ROOT, args['team-id']);
    require('./runtime-mount-preflight').assertSafeTeamPath(teamDir);
    const configPath = path.join(teamDir, 'team-config.json'), originalConfig = fs.readFileSync(configPath);
    const config = readValidatedTeamConfig(configPath, { checkFiles: true, certsDir: path.join(teamDir, 'certs') });
    const prepared = prepareDoctorProfiles(config, path.join(teamDir, 'certs'));
    console.log(JSON.stringify({ status: prepared.changed ? 'preview' : 'unchanged', teamId: config.teamId,
        scope: prepared.scope, rootChanged: false, credentials: prepared.entries, preserved: prepared.preserved,
        profiles: prepared.config.certificateRoles }));
    if (args.apply === true && prepared.changed) console.log(JSON.stringify(applyRenewal({ teamId: args['team-id'], teamDir, prepared, originalConfig, waitTimeout: args['wait-timeout'] })));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { main };
