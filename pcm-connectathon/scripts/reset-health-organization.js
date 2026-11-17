#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs, repoRoot, requireSafeTeamId, readValidatedTeamConfig, run, DEFAULT_TEAMS_ROOT } = require('./lib');
const { requireHealthOrganization } = require('../../src/shared/health-organizations');
const { publishOperation, failOperation } = require('../../clinical-data/workflow');
const { operationOwner } = require('../../clinical-data/operation-owner');

/** Return separate commands because CREATE DATABASE cannot run in a transaction block. */
function resetDatabaseStatements(database, owner) {
    return [
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`,
        `CREATE DATABASE ${database} OWNER ${owner};`,
        `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${owner};`
    ];
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    const teamId = args['team-id'];
    const hoId = args.ho;
    requireSafeTeamId(teamId);
    if (!args.yes) throw new Error('HO reset is destructive; pass --yes after confirming the named local HO');
    const root = repoRoot();
    const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
    const teamDir = path.join(teamsRoot, teamId);
    const ho = requireHealthOrganization(readValidatedTeamConfig(path.join(teamDir, 'team-config.json')), hoId);
    const envFile = path.join(teamDir, '.env');
    const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', envFile];
    const runtime = { cwd: root, env: { ...process.env, COMPOSE_PROJECT_NAME: teamId } };
    const owner = operationOwner({ stateDir: path.join(teamDir, 'state'), serverId: hoId, kind: 'reset', details: { targetIdentity: JSON.stringify(ho) } });
    const { registry, operation } = owner;
    registry.transition(operation.id, 'resetting');
    let failure;
    try {
        run('docker', [...compose, 'stop', `${hoId}-gateway`, `${hoId}-adapter`, `${hoId}-hapi`], runtime);
        registry.transition(operation.id, 'resetting', { mutationSubmitted: true, inventoryInvalidated: true });
        for (const statement of resetDatabaseStatements(ho.database.name, ho.database.user)) {
            run('docker', [...compose, 'exec', '-T', 'ho-postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'pcm_cluster_admin', '-d', 'postgres', '-c', statement], runtime);
        }
        const runtimePaths = [
            `/runtime/team/state/${hoId}-adapter`,
            `/runtime/team/state/import/${ho.import.stateNamespace}`,
            `/runtime/team/logs/${hoId}-adapter`,
            `/runtime/team/logs/${hoId}-gateway`
        ];
        // Container-mapped UIDs may own runtime artifacts. A networkless,
        // profile-only helper clears and recreates only these validated paths.
        run('docker', [
            ...compose, '--profile', 'maintenance', 'run', '--rm', '--no-deps', '--user', '0:0',
            '--entrypoint', 'rm', 'ho-reset-helper', '-rf', ...runtimePaths
        ], runtime);
        run('docker', [
            ...compose, '--profile', 'maintenance', 'run', '--rm', '--no-deps', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            '--entrypoint', 'mkdir', 'ho-reset-helper', '-p', ...runtimePaths
        ], runtime);
        console.log(`Reset only ${teamId}/${hoId}; the other HO databases and team configuration were preserved.`);
        registry.transition(operation.id, 'resetting', { resetVerifiedAt: new Date().toISOString() });
    } catch (error) { failure = error; }
    finally {
        try { run('docker', [...compose, 'start', `${hoId}-hapi`, `${hoId}-adapter`, `${hoId}-gateway`], runtime); }
        catch (error) { failure ||= error; }
        if (!owner.inherited) {
            if (failure) failOperation(registry, operation, failure);
            else {
                try {
                    registry.transition(operation.id, 'verifying', { verifiedCounts: {} });
                    publishOperation(registry, operation);
                } catch (error) { failOperation(registry, operation, error); throw error; }
            }
        }
    }
    if (failure) throw failure;
}

if (require.main === module) main();

module.exports = { main, resetDatabaseStatements };
