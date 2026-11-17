'use strict';

/** Source/Contract publication through the existing synchronous private configuration boundary. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { getConfiguredDataSources, syncDataSourcesToStore } = require('./data-sources');
const { scenarioOf, updatePolicy, timestamp } = require('./fhir/system-policy');

/** Preview exact source-asset maintenance without extending validity or reviving terminal grants. */
function workflowSourcePlan(store, config, now = Date.now() / 1000, { inspect = false } = {}) {
    const sources = getConfiguredDataSources(config).filter(source => source.institutionType === 'hmo').map(source => `Organization/${source.id}`).sort();
    const updates = [], versions = {}, policies = [], blockers = [];
    for (const contract of store.getAll('Contract').filter(item => ['patient-authentication', 'dependent-discovery'].includes(scenarioOf(item)))) {
        versions[contract.id] = contract.meta?.versionId;
        const validNow = contract.status === 'executed' && now >= timestamp(contract.issued) && now >= timestamp(contract.applies.start)
            && (!contract.applies.end || now <= timestamp(contract.applies.end));
        const existing = (contract.term[0].asset || []).map(asset => asset.context[0].reference.reference).sort();
        policies.push({ id: contract.id, scenario: scenarioOf(contract), status: contract.status, validNow,
            reason: validNow ? 'Current executed Contract; source readiness and client entitlement are checked separately.' : 'Contract is expired, not yet valid or not executed. Explicit replacement required; this view cannot renew it.',
            version: contract.meta?.versionId, before: existing, after: sources, end: contract.applies.end || null });
        if (JSON.stringify(sources) === JSON.stringify(existing)) continue;
        if (!validNow) {
            const message = `Workflow Contract ${contract.id} is not currently executed and valid. Review an explicit replacement; source assets were not changed`;
            if (!inspect) throw new Error(message);
            blockers.push(message); continue;
        }
        const updated = structuredClone(contract);
        updated.term[0].asset = sources.map(reference => ({ context: [{ reference: { reference } }] }));
        try { require('./fhir/system-contract').validateSystemContractUpdate(store, contract, updated, config.organizations.pcm.id); }
        catch (error) {
            if (!inspect) throw error;
            blockers.push(`Workflow Contract ${contract.id}: ${error.message}`); continue;
        }
        updates.push(updated);
    }
    return { sources, versions, updates, policies, blockers, missingScenarios: ['patient-authentication', 'dependent-discovery'].filter(scenario => !policies.some(policy => policy.scenario === scenario)) };
}

/** Back up privately before coupled registration/policy writes; publish config last within the transaction. */
function withWorkflowSourceConfiguration(store, config, publish) {
    // Unit/config-only readers may run before bootstrap; no policy is inferred in an uninitialized graph.
    if (!store.get('Organization', config.organizations.pcm.id)) return publish();
    return store.transaction(() => {
        const before = require('./migration-checkpoint').snapshot(store, { privateState: true });
        syncDataSourcesToStore(store, config, null, { preserveExisting: true });
        const plan = workflowSourcePlan(store, config);
        if (plan.updates.length) {
            const directory = path.join(process.env.STATE_DIR || config.runtime.stateDir, 'workflow-source-backups');
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(path.join(directory, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`),
                JSON.stringify({ teamConfig: JSON.parse(fs.readFileSync(require('./team-config').getConfigPath())), resources: before, versions: plan.versions }), { flag: 'wx', mode: 0o600 });
            for (const updated of plan.updates) updatePolicy(store, updated, config);
        }
        return publish();
    });
}
/** Inspect exact config and existing resource versions without running any workflow. */
function workflowSourceReview(store, config, now) {
    const plan = workflowSourcePlan(store, config, now, { inspect: true });
    const sourceVersions = Object.fromEntries(['Organization', 'Endpoint'].flatMap(type => store.getAll(type)
        .sort((a, b) => a.id.localeCompare(b.id)).map(resource => [`${type}/${resource.id}`, resource.meta?.versionId || null])));
    const review = { revision: config.runtime.revision || 0, ...plan, sourceVersions };
    return { ...review, reviewDigest: crypto.createHash('sha256').update(JSON.stringify({ config, review })).digest('hex') };
}

/** Publish bounded workflow changes under the caller's existing configuration mutex.
 * Reuse the accepted exact-byte source-publication journal with no credential files.
 * A checkpoint uncertainty retains that journal/fence for the existing stopped-worker recovery.
 * @param {object} store Existing public/private resource owner.
 * @param {object} config Validated candidate with its next runtime revision.
 * @param {string} lock Existing configuration mutex directory; never acquire it again.
 * @returns {void} Returns only after configuration and private policy publication commit.
 */
function publishWorkflowConfiguration(store, config, lock) {
    const owner = require('./team-config'), recovery = require('./source-publication-recovery');
    const stateDirectory = process.env.STATE_DIR || config.runtime.stateDir, configPath = owner.getConfigPath();
    const directory = process.env.CERTS_DIR || config.runtime.certsDir;
    const staged = recovery.begin({ lock, configPath, directory, stateDirectory, material: {}, nextConfig: config, sourceId: 'workflow-configuration' });
    try { withWorkflowSourceConfiguration(store, config, () => owner.publishTeamConfig(config)); }
    catch (error) {
        if (fs.existsSync(path.join(stateDirectory, 'pcm-ig-041', 'checkpoint-mutation.json'))) {
            error.statusCode = 503;
            error.message += '; workflow publication is uncertain and fenced. Stop workers, review configuration-mutation/source-publication.json and use the existing recover-mutation command with its exact digest.';
        } else {
            recovery.recover({ stateDirectory, configPath, certsDirectory: directory, workersStopped: true,
                expectedDigest: require('../../shared/migration-hash').hash(staged.journal), retainLock: true });
        }
        throw error;
    }
    fs.rmSync(staged.file);
}
module.exports = { workflowSourcePlan, workflowSourceReview, withWorkflowSourceConfiguration, publishWorkflowConfiguration };
