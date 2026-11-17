#!/usr/bin/env node
'use strict';

const { DEFAULT_LIMITS } = require('../../src/shared/clinical-import-limits');

/** Explicit, preview-first migration to the PCM-IG-040 v4 configuration boundary. */

const fs = require('fs');
const path = require('path');
const { parseArgs, readJson, writeJson } = require('./lib');
const { buildReferenceHealthOrganizations } = require('../../src/shared/health-organizations');
const { environmentEndpoints, tokenMaximumSeconds, PCM_PATH, LOGGING_EXCEPTION } = require('../../src/shared/pcm-environment');
const { PCM_IG } = require('../../src/shared/pcm-contract');
const { defaultSystemAuthorization } = require('../../src/shared/system-authorization-config');
const { CONFIG_VERSION, assertValidTeamConfig } = require('../../src/shared/team-config-validator');
const { POLICY_VERSION, presetSimulationDefaults, presetSourceDefaults } = require('../../src/shared/conformance-policy');

/** Return a migration copy; this function never rewrites retained team files/state. */
function migrate(config, { environment = config.contract?.environment || 'test', standardSampling = false } = {}) {
    if (config.configVersion !== CONFIG_VERSION) throw new Error('Coordinated scope migration is required; PCM-SCOPE-QUALIFY-05 owns reviewed config/approval/cache migration. No files changed.');
    const next = structuredClone(config);
    next.sandbox ||= {};
    if (standardSampling) {
        if (!next.serviceCatalog) throw new Error('Standard sampling requires an explicitly selected team catalog');
        delete next.sandboxSampler;
        next.sandboxSampling = { sourceIds: next.healthOrganizations.filter(ho => ho.clinicalData?.managed && ho.enabled !== false).map(ho => ho.id) };
        for (const role of ['serviceProvider', 'hospitalBServiceProvider']) next.systemAuthorization.clientEntitlements[next.organizations[role].clientId] = ['sandbox-patient-sample'];
    }
    if (config.configVersion === CONFIG_VERSION) {
        if (environment !== config.contract.environment) throw new Error('Environment changes require a new explicit migration/configuration review');
        assertValidTeamConfig(next, { env: {} });
        return next;
    }
    const logical = environmentEndpoints(environment);
    next.contract.pcmIgVersion = PCM_IG.version;
    next.contract.pcmIgCommit = PCM_IG.commit;
    next.contract.environment = environment;
    next.contract.operational = { oauthBase: logical.oauthBase, fhirBase: logical.fhirBase };
    next.contract.conformanceExceptions = [LOGGING_EXCEPTION];
    for (const [section, key] of [['publicBaseUrls', 'pcmApi'], ['publicBaseUrls', 'pcmMetadata'], ['internalBaseUrls', 'pcmAuth'], ['internalBaseUrls', 'pcmFhir']]) {
        const previous = new URL(next[section][key]);
        if (!['', '/', '/r4', PCM_PATH].includes(previous.pathname) || previous.search || previous.hash || previous.username || previous.password) {
            throw new Error(`Cannot migrate unknown PCM transport alias: ${section}.${key}`);
        }
        next[section][key] = `${previous.origin}${PCM_PATH}`;
    }
    for (const [role, prefix] of [['authenticationOrchestrator', 'authentication-orchestrator'], ['discoveryOrchestrator', 'discovery-orchestrator']]) {
        next.oauthClients[role] = { clientId: `pcm-${prefix}`, name: `PCM ${prefix}` };
        next.certificateRoles[role] = { mtls: { cert: `${prefix}.crt`, key: `${prefix}.key` }, assertion: { cert: `${prefix}-assertion.crt`, key: `${prefix}-assertion.key` } };
    }
    next.systemAuthorization = defaultSystemAuthorization(next);
    next.configVersion = CONFIG_VERSION;
    next.conformance = next.conformance || {};
    const strict = next.conformance.mode === 'strict';
    next.conformance.preset = strict ? 'strict' : (next.conformance.preset || (next.security?.pcmApi?.clientAuth === 'mtls' ? 'connectathon-mtls' : 'connectathon-easy'));
    next.conformance.policyVersion = POLICY_VERSION;
    next.securitySimulation = { global: next.securitySimulation?.global || presetSimulationDefaults(next.conformance.preset), perSource: { ...presetSourceDefaults(next.conformance.preset), ...(next.securitySimulation?.perSource || {}) }, awsCredentialIsolation: true };
    next.securitySimulation.awsCredentialIsolation = true;
    next.security.dsFhirServer ||= {};
    next.security.dsFhirServer.enforceMappedPatients = next.conformance.preset !== 'connectathon-easy';
    for (const ho of next.healthOrganizations || []) {
        delete ho.fixtureSet;
        ho.clinicalData ||= {
            managed: true,
            serverId: ho.id,
            privateFhirBaseUrl: `http://${ho.id}-hapi:8080/fhir`,
            bundleRoot: '/runtime/bundles',
            bootstrap: { policy: 'disabled', bundleReference: '', expectedSource: '' },
            limits: { ...DEFAULT_LIMITS }
        };
    }
    next.legacyDataSource ||= {
        id: 'legacy-ds', enabled: next.conformance.mode !== 'strict', compatibilityOnly: true,
        managedHapi: false, publicFhirBaseUrl: next.publicBaseUrls.referenceDataSource,
        internalFhirBaseUrl: next.internalBaseUrls.referenceDataSource, fixtureResetSupported: true
    };
    next.security.dsFhirServer = { ...(next.security.dsFhirServer || {}), enforceMappedPatients: next.conformance.preset !== 'connectathon-easy' };
    next.security.pcmApi.accessTokenExpiresInSeconds = tokenMaximumSeconds(next);
    next.security.dsGatewayToFhirServer.protocol = 'https';
    next.presence ||= { batch: { maxPatients: 100, maxPayloadBytes: 1048576, timeoutMilliseconds: 30000 } };
    const firstPort = Number(new URL(next.publicBaseUrls?.referenceDataSource || 'https://localhost:8180/fhir').port || 8180);
    next.healthOrganizations ||= buildReferenceHealthOrganizations(next.teamId, firstPort);
    next.publicBaseUrls.healthOrganizations ||= Object.fromEntries(next.healthOrganizations.map(ho => [ho.id, `https://localhost:${ho.gatewayPort}/fhir`]));
    next.internalBaseUrls.healthOrganizations ||= Object.fromEntries(next.healthOrganizations.map(ho => [ho.id, ho.endpoint]));
    next.identityMapping ||= { businessIdOverrides: {} };
    return next;
}

/** Validate a dry-run by default; explicit writes preserve an exact scoped backup. */
function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (args['pcm-ig-041'] || args['scope-model'] || args['public-metadata']) return candidateMigration(args);
    if (!args.config) throw new TypeError('--config is required');
    const target = path.resolve(args.config);
    const original = fs.readFileSync(target);
    const migrated = migrate(JSON.parse(original), { ...(args.environment ? { environment: args.environment } : {}), standardSampling: args['standard-sampling'] === true || args['standard-sampling'] === 'true' });
    assertValidTeamConfig(migrated, { env: {} });
    let catalogChange;
    if (args['standard-sampling']) {
        const file = migrated.serviceCatalog.file;
        if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Migration requires a team-local catalog');
        const catalogPath = path.resolve(path.dirname(target), file);
        if (!fs.realpathSync(catalogPath).startsWith(fs.realpathSync(path.dirname(target)) + path.sep)) throw new Error('Migration requires a team-local catalog');
        const bytes = fs.readFileSync(catalogPath), catalog = JSON.parse(bytes);
        delete catalog.sandboxSampler;
        catalog.sandboxSampling = readJson(path.resolve(__dirname, '../../config/demo-services.json')).sandboxSampling;
        require('../../src/shared/service-catalog').validateCatalogGraph(catalog, migrated);
        catalogChange = { path: catalogPath, bytes, catalog };
    }
    if (args.write) {
        require('../../src/shared/migration-maintenance').assertAvailable(process.env.STATE_DIR || args.state || migrated.runtime.stateDir);
        if (JSON.stringify(migrated) === JSON.stringify(JSON.parse(original)) && (!catalogChange || JSON.stringify(catalogChange.catalog) === JSON.stringify(JSON.parse(catalogChange.bytes)))) return;
        const backup = `${target}.${args['standard-sampling'] ? 'pre-standard-sampling' : 'pre-pcm-ig-040'}.json`;
        if (fs.existsSync(backup) && !fs.readFileSync(backup).equals(original)) {
            throw new Error(`Refusing to overwrite a different migration backup: ${backup}`);
        }
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
        if (catalogChange) {
            const backup = `${catalogChange.path}.pre-standard-sampling.json`;
            if (fs.existsSync(backup) && !fs.readFileSync(backup).equals(catalogChange.bytes)) throw new Error('Refusing to overwrite a different catalog backup');
            if (!fs.existsSync(backup)) fs.writeFileSync(backup, catalogChange.bytes, { flag: 'wx', mode: 0o600 });
            writeJson(catalogChange.path, catalogChange.catalog);
        }
        writeJson(target, migrated);
    } else console.log(JSON.stringify(catalogChange ? { config: migrated, catalog: catalogChange.catalog } : migrated, null, 2));
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { migrate, main };

/** Explicit candidate checkpoint migration; preview is the default and writes no plan/config/state. */
function candidateMigration(args) {
    if (args.help) {
        console.log('Checkpoint migration; active PCM-IG lock remains unchanged\n' +
            'Metadata: --public-metadata uses pcm-public-metadata-review/1 (relocate, restore or explicit full-access with asOf/transition digest), measured five-component artifacts and private backups; see retained-team-migration.md.\n' +
            'Scope cutover: use --scope-model with pcm-scope-migration-review/1; see retained-team-migration.md.\n' +
            'First POST /admin/migration/checkpoint on a checkpoint-capable runtime; then stop every team worker.\n' +
            'Preview (no writes): --pcm-ig-041 --config FILE --state DIR --certs DIR --review FILE\n' +
            'Apply: add --apply --expected-digest SHA256 --workers-stopped --stopped-at FULL_TIMESTAMP (at least 31 seconds ago)\n' +
            'Interrupted apply/rollback: --pcm-ig-041 --config FILE --state DIR --recover --workers-stopped\n' +
            'Rollback: fresh online checkpoint, stop, then --pcm-ig-041 --config FILE --state DIR --rollback --workers-stopped --stopped-at FULL_TIMESTAMP\n' +
            'Unsafe restore: --pcm-ig-041 --config FILE --state DIR --resume-current --workers-stopped\n' +
            'See pcm-connectathon/retained-team-migration.md for review mappings, bridge, downtime and recovery.');
        return;
    }
    const migration = require('./pcm-ig-041-migration');
    if (!args.config || !args.state) throw new Error('--config and --state are required');
    const options = { configPath: path.resolve(args.config), stateDirectory: path.resolve(args.state),
        certsDirectory: args.certs && path.resolve(args.certs), reviewPath: args.review && path.resolve(args.review),
        workersStopped: args['workers-stopped'] === true, stoppedAt: args['stopped-at'], expectedDigest: args['expected-digest'] };
    let result;
    if (args.recover) result = migration.recover(options.stateDirectory, options);
    else if (args.rollback) result = migration.rollback(options);
    else if (args['resume-current']) result = migration.resumeCurrent(options);
    else {
        if ((!args['scope-model'] && !options.certsDirectory) || !options.reviewPath) throw new Error('--certs and --review are required for preview/apply');
        if (args.apply) result = migration.apply(options);
        else {
            const { publications, ...preview } = migration.plan(options);
            result = preview;
        }
    }
    // Legacy plans include private semantic diffs. Metadata preview carries hashes/identities only.
    console.log(JSON.stringify(result, null, 2)); return result;
}
