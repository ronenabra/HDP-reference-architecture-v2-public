#!/usr/bin/env node
'use strict';

/** Run the Sprint 29 per-HAPI direct transaction-bundle lifecycle. */

const { readEnvironmentValue } = require('./team-credentials');
const fs = require('fs');
const path = require('path');
const { inspectTransactionBundle, safeBundlePath } = require('../../clinical-data/transaction-bundle');
const { parseArgs, repoRoot, requireSafeTeamId, readValidatedTeamConfig, run, DEFAULT_TEAMS_ROOT } = require('./lib');
const { requireHealthOrganization } = require('../../src/shared/health-organizations');
const { publishOperation, failOperation } = require('../../clinical-data/workflow');
const { operationOwner } = require('../../clinical-data/operation-owner');
const { clinicalDeadlines } = require('../../clinical-data/deadlines');
const { planReadinessState } = require('./readiness-state');

function envFileValue(file, name) {
    return readEnvironmentValue(fs.readFileSync(file, 'utf8'), name);
}

function resolvePlan(config, ho, args) {
    const policy = args.policy || ho.clinicalData.bootstrap.policy;
    if (!['disabled', 'if-empty', 'replace'].includes(policy)) throw new TypeError('--policy must be disabled, if-empty, or replace');
    const reference = args.bundle || ho.clinicalData.bootstrap.bundleReference;
    if (policy !== 'disabled' && !reference) throw new TypeError(`${ho.id} requires an explicit bundle reference for ${policy}`);
    const bundleRoot = path.resolve(args['bundle-root'] || ho.clinicalData.bundleRoot);
    const bundlePath = reference ? safeBundlePath(bundleRoot, reference) : null;
    const inspected = bundlePath ? inspectTransactionBundle(fs.readFileSync(bundlePath), { limits: ho.clinicalData.limits }) : null;
    if (inspected && ho.clinicalData.bootstrap.expectedSource && inspected.source !== ho.clinicalData.bootstrap.expectedSource) throw new TypeError(`${ho.id} expected source ${ho.clinicalData.bootstrap.expectedSource}, received ${inspected.source}`);
    return { policy, bundleRoot, bundlePath, inspected };
}

function runTarget({ root, teamId, teamsRoot, config, ho, args }) {
    const plan = resolvePlan(config, ho, args);
    if (plan.policy === 'disabled') {
        console.log(JSON.stringify({ phase: 'skipped', reason: 'bootstrap-disabled', serverId: ho.id, policy: plan.policy }));
        return;
    }
    const teamDir = path.join(teamsRoot, teamId);
    const envFile = path.join(teamDir, '.env');
    // Reuse the persisted startup budget for the private HAPI process before reserving work.
    const { waitTimeout } = planReadinessState(fs.readFileSync(envFile, 'utf8'));
    const credential = envFileValue(envFile, ho.import.credentialEnv);
    const databasePassword = envFileValue(envFile, ho.database.passwordEnv);
    if (credential.length < 32 || !databasePassword) throw new TypeError(`${ho.id} import/database credentials are incomplete`);
    const owner = operationOwner({ stateDir: path.join(teamDir, 'state'), serverId: ho.id, kind: plan.policy === 'replace' ? 'replace' : 'bootstrap', details: {
        targetIdentity: JSON.stringify(ho), sha256: plan.inspected.sha256, bytes: plan.inspected.bytes,
        entries: plan.inspected.entries, source: plan.inspected.source, version: plan.inspected.version,
        counts: plan.inspected.counts, deadlines: clinicalDeadlines()
    } });
    const { registry, operation } = owner;
    const uploadDir = path.join(teamDir, 'state', 'data-uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const savedUpload = path.join(uploadDir, `${operation.id}.json`);
    fs.copyFileSync(plan.bundlePath, savedUpload);
    if (inspectTransactionBundle(fs.readFileSync(savedUpload), { limits: ho.clinicalData.limits }).sha256 !== operation.sha256) {
        registry.transition(operation.id, 'failed', { diagnostics: ['saved upload checksum changed before mutation'] });
        throw new Error('saved upload checksum changed before mutation');
    }
    registry.transition(operation.id, 'validating');
    const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', envFile, '--profile', 'import'];
    const runtimeEnv = {
        ...owner.env, COMPOSE_PROJECT_NAME: teamId, PCM_IMPORT_CREDENTIAL: credential,
        CLINICAL_DATA_CONNECT_UPLOAD_TIMEOUT_MS: String(operation.deadlines.connectUploadMs),
        CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: String(operation.deadlines.transactionWaitMs),
        CLINICAL_DATA_VERIFICATION_TIMEOUT_MS: String(operation.deadlines.verificationMs),
        HO_IMPORT_TARGET: ho.id, HO_IMPORT_DB_NAME: ho.database.name, HO_IMPORT_DB_USER: ho.database.user,
        HO_IMPORT_DB_PASSWORD: databasePassword, HO_IMPORT_PROTOCOL: config.security.dsGatewayToFhirServer.protocol
    };
    console.log(JSON.stringify({ phase: 'validating', serverId: ho.id, policy: plan.policy, source: plan.inspected.source, sha256: plan.inspected.sha256, entries: plan.inspected.entries, counts: plan.inspected.counts }));
    let failure;
    try {
        const currentHo = requireHealthOrganization(readValidatedTeamConfig(path.join(teamDir, 'team-config.json')), ho.id);
        if (JSON.stringify(currentHo) !== operation.targetIdentity) throw new Error('operation target configuration changed');
        if (inspectTransactionBundle(fs.readFileSync(savedUpload), { limits: ho.clinicalData.limits }).sha256 !== operation.sha256) throw new Error('queued upload checksum changed');
        if (plan.policy === 'replace') run('node', ['pcm-connectathon/scripts/reset-health-organization.js', '--team-id', teamId, '--teams-root', teamsRoot, '--ho', ho.id, '--yes'], { cwd: root, env: runtimeEnv });
        run('docker', [...compose, 'stop', `${ho.id}-gateway`, `${ho.id}-hapi`], { cwd: root, env: runtimeEnv });
        run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', String(waitTimeout), 'clinical-import-hapi'], { cwd: root, env: runtimeEnv });
        const output = run('docker', [...compose, 'run', '--rm', '--no-deps', '-e', 'PCM_DATA_OPERATION_ID', '-e', 'PCM_DATA_OPERATION_TOKEN',
            '-e', 'CLINICAL_DATA_CONNECT_UPLOAD_TIMEOUT_MS', '-e', 'CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS', '-e', 'CLINICAL_DATA_VERIFICATION_TIMEOUT_MS',
            '-v', `${savedUpload}:/runtime/upload/bundle.json:ro`,
            '-e', `HO_ID=${ho.id}`, '-e', `HO_IMPORT_ENDPOINT=${config.security.dsGatewayToFhirServer.protocol}://clinical-import-hapi:8080/fhir`,
            '-e', 'PCM_TRANSACTION_BUNDLE=/runtime/upload/bundle.json', '-e', `PCM_TRANSACTION_BUNDLE_NAME=${path.basename(plan.bundlePath)}`,
            '-e', `PCM_IMPORT_MAX_BYTES=${ho.clinicalData.limits.maxBytes}`, '-e', `PCM_IMPORT_MAX_ENTRIES=${ho.clinicalData.limits.maxEntries}`,
            '-e', `PCM_IMPORT_POLICY=${plan.policy}`,
            '-e', `PCM_IMPORT_STATE_DIR=/runtime/import-state/${ho.import.stateNamespace}`, 'clinical-loader'], { cwd: root, env: runtimeEnv, capture: true });
        process.stdout.write(output);
        const result = registry.get(operation.id);
        if (result?.phase !== 'verifying' || result.sha256 !== operation.sha256
            || !['verified', 'skipped'].includes(result.result)) throw new Error('loader left no matching verified ledger result');
    } catch (error) {
        failure = error;
        run('docker', [...compose, 'logs', '--no-color', '--tail', '120', 'clinical-import-hapi'], { cwd: root, env: runtimeEnv, allowFailure: true });
        throw error;
    } finally {
        try {
            run('docker', [...compose, 'rm', '-f', '-s', 'clinical-import-hapi'], { cwd: root, env: runtimeEnv });
            run('docker', [...compose, 'start', `${ho.id}-hapi`, `${ho.id}-gateway`], { cwd: root, env: runtimeEnv });
        } catch (error) {
            failure ||= error;
            registry.transition(operation.id, registry.get(operation.id).phase, { needsReconciliation: true });
        }
        if (failure) failOperation(registry, operation, failure);
        else {
            try {
                const completed = registry.get(operation.id);
                const published = publishOperation(registry, operation);
                try {
                    if (completed.legacyMarker) {
                        const marker = path.join(teamDir, 'state', 'import', ho.import.stateNamespace, `${operation.sha256}.json`);
                        fs.unlinkSync(marker);
                    }
                    fs.unlinkSync(savedUpload);
                } catch (error) {
                    registry.write({ ...published, diagnostics: [...(published.diagnostics || []), `Verified cleanup failed: ${error.message}`] });
                }
                console.log(JSON.stringify({ phase: published.phase, operationId: published.id, serverId: published.serverId, result: published.result }));
            } catch (error) { failOperation(registry, operation, error); throw error; }
        }
        if (failure) throw failure;
    }
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    const teamId = args['team-id'];
    requireSafeTeamId(teamId);
    const root = repoRoot();
    const teamsRoot = path.resolve(root, args['teams-root'] || DEFAULT_TEAMS_ROOT);
    const config = readValidatedTeamConfig(path.join(teamsRoot, teamId, 'team-config.json'));
    const targets = args.all ? config.healthOrganizations : [requireHealthOrganization(config, args.ho)];
    for (const ho of targets) runTarget({ root, teamId, teamsRoot, config, ho, args });
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, resolvePlan, runTarget };
