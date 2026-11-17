#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { planTeamCredentials } = require('./team-credentials');
const { parseArgs, repoRoot, requireSafeTeamId, assertUniquePorts, portSet, run, DEFAULT_TEAMS_ROOT } = require('./lib');

const args = parseArgs(process.argv);
const teamId = args['team-id'];
requireSafeTeamId(teamId);

const root = repoRoot();
const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
const teamDir = path.join(teamsRoot, teamId);
const preset = args.preset || (args.mode === 'strict' ? 'strict' : 'connectathon-easy');
if (!['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict'].includes(preset)) throw new Error('--preset must be connectathon-easy, connectathon-balanced, connectathon-mtls, or strict');
const portIndex = Number(args['port-index'] || 0);
const ports = portSet(args, portIndex);
const explicitAdmin = args['team-admin-password'] ?? args['admin-password'] ?? process.env.TEAM_ADMIN_PASSWORD;
const credentials = planTeamCredentials(teamDir, preset, {
    ...process.env, ...(explicitAdmin !== undefined ? { TEAM_ADMIN_PASSWORD: explicitAdmin } : {})
});
const adminPassword = explicitAdmin ?? credentials.values.TEAM_ADMIN_PASSWORD;
// A retained value is raw Compose text; only actual new plaintext may cross process.env.
const creationEnvironment = { ...process.env };
if (explicitAdmin !== undefined || !credentials.retained) creationEnvironment.TEAM_ADMIN_PASSWORD = adminPassword;
else delete creationEnvironment.TEAM_ADMIN_PASSWORD;

assertUniquePorts({
    sp_port: ports.sp,
    pcm_ui_port: ports.pcmUi,
    pcm_api_port: ports.pcmApi,
    pcm_metadata_port: ports.pcmMetadata,
    ds_gateway_port: ports.ds,
    ds_gateway_b_port: ports.ds + 1,
    ds_gateway_c_port: ports.ds + 2,
    legacy_ds_gateway_port: ports.dsLegacy,
    ds_gateway_http_port: ports.dsHttp
});

if (fs.existsSync(teamDir) && !args.force) {
    throw new Error(`${path.relative(root, teamDir)} already exists; pass --force to overwrite team config/env`);
}

run('node', [
    'pcm-connectathon/scripts/create-team.js',
    '--team-id', teamId,
    '--teams-root', teamsRoot,
    '--sp-port', String(ports.sp),
    '--pcm-ui-port', String(ports.pcmUi),
    '--pcm-api-port', String(ports.pcmApi),
    '--pcm-metadata-port', String(ports.pcmMetadata),
    '--ds-port', String(ports.ds),
    '--ds-http-port', String(ports.dsHttp),
    '--preset', preset,
    ...(args.environment ? ['--environment', args.environment] : []),
    ...(args['doctor-base-url'] ? ['--doctor-base-url', args['doctor-base-url']] : []),
    '--generate-certs', 'true',
    '--pcm-api-host', 'localhost',
    '--sp-host', 'localhost',
    '--ds-host', 'localhost'
], { cwd: root, env: creationEnvironment });

console.log(`Local team ready: ${path.relative(root, teamDir)} (${preset} preset)`);
console.log(`SP UI: ${args['doctor-base-url'] || `http://localhost:${ports.sp}`}`);
console.log(`PCM Admin/UI: http://localhost:${ports.pcmUi}`);
console.log(`PCM API: https://localhost:${ports.pcmApi}`);
console.log(`PCM metadata: https://localhost:${ports.pcmMetadata}`);
console.log(`HO A FHIR: https://localhost:${ports.ds}/fhir`);
console.log(`HO B FHIR: https://localhost:${ports.ds + 1}/fhir`);
console.log(`HO C FHIR: https://localhost:${ports.ds + 2}/fhir`);
console.log(`Legacy Node DS FHIR: https://localhost:${ports.dsLegacy}/fhir (compatibility source)`);
console.log(`Trust: import ${path.relative(root, path.join(teamDir, 'certs', 'rootCA.crt'))} and use the Service Provider mTLS certificate.`);
if (args['quiet-secrets']) {
    console.log('Admin password: supplied through the team environment (value not printed)');
} else if (credentials.retained && explicitAdmin === undefined) {
    console.log('Admin password: existing value preserved in the private team environment');
} else {
    console.log(`Admin password: ${adminPassword}`);
}
