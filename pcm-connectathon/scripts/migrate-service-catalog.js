#!/usr/bin/env node
'use strict';
/** Preview/apply a retained team's catalog selection with byte-exact configuration backup. */
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, readValidatedTeamConfig } = require('./lib');
const { loadServiceCatalog } = require('../../src/shared/service-catalog');
const { assertValidTeamConfig } = require('../../src/shared/team-config-validator');

/** Keep the retained default service identity while adding explicit application registrations. */
function planCatalogMigration(current) {
    if (current.serviceCatalog) throw new TypeError('Team already selected an external catalog; use the runtime reconciliation preview');
    const definitions = require('../../config/demo-services.json');
    const config = structuredClone(current);
    config.serviceCatalog = { file: 'catalog/demo-services.json', bindings: definitions.clinicalServices.flatMap(definition =>
        ['serviceProvider', 'hospitalBServiceProvider'].filter(role => config.organizations[role]).map(providerRole => ({
            application: providerRole === 'serviceProvider' ? 'doctor' : 'doctor-b', providerRole, serviceKey: definition.key,
            instanceId: providerRole === 'serviceProvider' && definition.key === 'lab-follow-up' ? current.service.id : `demo-${providerRole === 'serviceProvider' ? 'doctor' : 'doctor-b'}-${definition.key}`,
            instanceIdentifier: providerRole === 'serviceProvider' && definition.key === 'lab-follow-up' ? current.service.instanceIdentifier || 'PCM-HS-INST-0001' : `PCM-DEMO-${providerRole.toUpperCase()}-${definition.key.toUpperCase()}`
        }))) };
    config.runtime.revision++;
    assertValidTeamConfig(config, { env: {} });
    return { config, preservedService: current.service, requiresRuntimeReconciliation: true };
}

/** Save backup and selected portable catalog before publishing the validated config. */
function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (!args.config) throw new TypeError('--config is required');
    const configPath = path.resolve(args.config);
    const plan = planCatalogMigration(readValidatedTeamConfig(configPath));
    console.log(JSON.stringify({ applied: Boolean(args.apply), ...plan }, null, 2));
    if (!args.apply) return plan;
    require('../../src/shared/migration-maintenance').assertAvailable(process.env.STATE_DIR || args.state || plan.config.runtime.stateDir);
    const backupPath = `${configPath}.catalog-backup-${Date.now()}`;
    fs.writeFileSync(backupPath, fs.readFileSync(configPath), { flag: 'wx', mode: 0o600 });
    const catalogPath = path.join(path.dirname(configPath), plan.config.serviceCatalog.file);
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot(), 'config/demo-services.json'), catalogPath, fs.constants.COPYFILE_EXCL);
    loadServiceCatalog(plan.config, { teamDirectory: path.dirname(configPath) });
    const temporary = `${configPath}.catalog-tmp`;
    fs.writeFileSync(temporary, JSON.stringify(plan.config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, configPath);
    return plan;
}
if (require.main === module) main();
module.exports = { main, planCatalogMigration };

/** Reconcile retained singular/object sensitivity metadata only under explicit operator review. */
function reconcileRetainedCatalog(current, reviewed) {
    const catalog = structuredClone(current);
    for (const service of catalog.clinicalServices || []) for (const bucket of service.buckets || []) {
        if (bucket.taggedDetail !== undefined || (bucket.taggedDetails !== undefined && !Array.isArray(bucket.taggedDetails))) {
            if (!reviewed || (bucket.taggedDetail !== undefined && bucket.taggedDetails !== undefined)) throw new Error('Retained plural catalog mapping requires explicit unambiguous catalogReconciliation review');
            bucket.taggedDetails = [].concat(bucket.taggedDetails || bucket.taggedDetail);
            delete bucket.taggedDetail;
        }
    }
    return catalog;
}
module.exports.reconcileRetainedCatalog = reconcileRetainedCatalog;
