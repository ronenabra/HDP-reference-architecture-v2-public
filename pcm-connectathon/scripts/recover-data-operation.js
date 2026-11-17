#!/usr/bin/env node
'use strict';
/** Verify a stopped submitted transaction without replaying its POST. */
const path = require('path');
const { readEnvironmentValue } = require('./team-credentials');
const fs = require('fs');
const { DataOperationRegistry, confirmationToken } = require('../../src/pcm-core/src/data-operations');
const { parseArgs, repoRoot, requireSafeTeamId, readValidatedTeamConfig, run, DEFAULT_TEAMS_ROOT } = require('./lib');

function envFileValue(file, name) {
    return readEnvironmentValue(fs.readFileSync(file, 'utf8'), name);
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    requireSafeTeamId(args['team-id']);
    const teamDir = path.resolve(repoRoot(), args['teams-root'] || DEFAULT_TEAMS_ROOT, args['team-id']);
    const config = readValidatedTeamConfig(path.join(teamDir, 'team-config.json'));
    const registry = new DataOperationRegistry({ directory: path.join(teamDir, 'state', 'data-operations') });
    const operation = registry.get(args.operation);
    if (!operation || !config.healthOrganizations.some(ho => ho.clinicalData.serverId === operation.serverId)) throw new Error('unknown managed operation');
    if (args['workers-stopped'] !== true) throw new Error('reconciliation requires --workers-stopped after confirming the worker and HAPI transaction stopped');
    if (!operation.mutationSubmitted) {
        console.log(JSON.stringify(registry.recover(operation.id, { workersStopped: true, reconciled: true })));
        return;
    }
    const ho = config.healthOrganizations.find(item => item.clinicalData.serverId === operation.serverId);
    if (JSON.stringify(ho) !== operation.targetIdentity) throw new Error('managed target configuration changed');
    const credential = envFileValue(path.join(teamDir, '.env'), ho.import.credentialEnv);
    if (credential.length < 32) throw new Error('private import credential unavailable');
    const expectedConfirmation = confirmationToken(operation.serverId, config.teamId);
    if (args.reset && args.confirmation !== expectedConfirmation) throw new Error(`target-scoped reset requires --confirmation ${expectedConfirmation}`);
    const runtimeEnv = { ...process.env, COMPOSE_PROJECT_NAME: args['team-id'], PCM_IMPORT_CREDENTIAL: credential,
        HO_IMPORT_TARGET: ho.id, HO_IMPORT_ENDPOINT: ho.clinicalData.privateFhirBaseUrl,
        PCM_DATA_OPERATION_ID: operation.id, PCM_TARGET_IDENTITY: operation.targetIdentity,
        PCM_WORKERS_STOPPED: 'true', PCM_RECOVERY_RESET: args.reset ? 'true' : 'false',
        PCM_RECOVERY_CONFIRMATION: args.confirmation || '', PCM_EXPECTED_CONFIRMATION: expectedConfirmation };
    const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml',
        '--env-file', path.join(teamDir, '.env'), '--profile', 'import'];
    const output = run('docker', [...compose, 'run', '--rm', '--no-deps', '--entrypoint', 'node',
        '-e', 'PCM_DATA_OPERATION_ID', '-e', 'PCM_TARGET_IDENTITY', '-e', 'PCM_WORKERS_STOPPED',
        '-e', 'PCM_RECOVERY_RESET', '-e', 'PCM_RECOVERY_CONFIRMATION', '-e', 'PCM_EXPECTED_CONFIRMATION',
        '-e', 'HO_IMPORT_ENDPOINT', '-e', `HO_ID=${ho.id}`,
        '-e', `PCM_IMPORT_MAX_BYTES=${ho.clinicalData.limits.maxBytes}`,
        '-e', `PCM_IMPORT_MAX_ENTRIES=${ho.clinicalData.limits.maxEntries}`,
        'clinical-loader', '/clinical-data/reconcile-loader.js'], { cwd: repoRoot(), env: runtimeEnv, capture: true });
    process.stdout.write(output);
}
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
