#!/usr/bin/env node
'use strict';

/** Preview/apply a complete local leaf renewal through the existing controlled recreation path. */
const fs = require('node:fs'), path = require('node:path');
const { parseArgs, repoRoot, requireSafeTeamId, readValidatedTeamConfig, DEFAULT_TEAMS_ROOT } = require('./lib');
const { prepareRenewal } = require('../../src/shared/certificate-renewal');
const { publishFiles } = require('../../src/shared/role-credentials');
const { applyReconfiguration } = require('./reconfigure-local-team');

/** Prepare a private recoverable backup, then publish only the previously validated leaf graph. */
function applyRenewal({ teamId, teamDir, prepared, originalConfig, execute, root = repoRoot(), waitTimeout }) {
    const directory = path.join(teamDir, 'certs'), configPath = path.join(teamDir, 'team-config.json'), envPath = path.join(teamDir, '.env');
    const environment = fs.readFileSync(envPath, 'utf8');
    if (prepared.rotateKeys && require('./team-credentials').readEnvironmentValue(environment, 'LOCAL_JWT_KEY_ID')) {
        throw new Error('Explicit LOCAL_JWT_KEY_ID prevents automatic key rotation; review the private adapter/native key ID configuration before applying. No listeners or credentials were changed');
    }
    const previous = Object.fromEntries(Object.keys(prepared.material).map(name => [name, fs.readFileSync(path.join(directory, name))]));
    let backup;
    applyReconfiguration({ teamId, configPath, envPath, root, waitTimeout, ...(execute ? { execute } : {}),
        plan: { config: prepared.config, environment: fs.readFileSync(envPath, 'utf8') },
        publishCredentials() {
            if (!fs.readFileSync(configPath).equals(originalConfig)
                || Object.entries(previous).some(([name, bytes]) => !fs.readFileSync(path.join(directory, name)).equals(bytes))) {
                throw new Error('Configuration or credentials changed after preparation; refresh the preview');
            }
            backup = path.join(teamDir, 'credential-backups', `leaves-${Date.now()}-${require('node:crypto').randomBytes(4).toString('hex')}`);
            fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(backup, 'team-config.json'), originalConfig, { mode: 0o600 });
            fs.writeFileSync(path.join(backup, 'environment'), fs.readFileSync(envPath), { mode: 0o600 });
            fs.mkdirSync(path.join(backup, 'certs'), { mode: 0o700 });
            publishFiles(path.join(backup, 'certs'), previous);
            publishFiles(directory, prepared.material);
        },
        restoreCredentials() { if (backup) publishFiles(directory, previous); }
    });
    return { status: 'renewed', scope: prepared.scope, rootChanged: false, rotateKeys: prepared.rotateKeys, backup };
}

/** Preview by default; --apply authorizes stop/backup/publication/recreation for exactly this local team. */
function main(argv = process.argv) {
    const args = parseArgs(argv); requireSafeTeamId(args['team-id']);
    if (args['rotate-root']) throw new Error('This action renews registered team-owned leaves only; root replacement is unsupported and no files were changed');
    const teamDir = path.resolve(repoRoot(), args['teams-root'] || DEFAULT_TEAMS_ROOT, args['team-id']);
    require('./runtime-mount-preflight').assertSafeTeamPath(teamDir);
    const configPath = path.join(teamDir, 'team-config.json'), originalConfig = fs.readFileSync(configPath);
    const config = readValidatedTeamConfig(configPath, { checkFiles: true, certsDir: path.join(teamDir, 'certs') });
    const prepared = prepareRenewal(config, path.join(teamDir, 'certs'), { rotateKeys: args['rotate-keys'] === true });
    console.log(JSON.stringify({ status: 'preview', teamId: config.teamId, scope: prepared.scope, rootChanged: false,
        rotateKeys: prepared.rotateKeys, credentials: prepared.entries, preserved: prepared.preserved }));
    if (args.apply === true) console.log(JSON.stringify(applyRenewal({ teamId: args['team-id'], teamDir, prepared, originalConfig, waitTimeout: args['wait-timeout'] })));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { applyRenewal, main };
