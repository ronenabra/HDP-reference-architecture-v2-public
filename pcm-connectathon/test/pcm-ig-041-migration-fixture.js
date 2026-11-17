'use strict';

/** Disposable retained-team fixture builder; generated private keys never leave process memory. */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { buildTeamConfig } = require('../../test-support/team-config');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const migration = require('../scripts/pcm-ig-041-migration');
const { jwkThumbprint, signingAlgorithm } = require('../../src/shared/assertion-keys');
const beforeId = `sha256:${'1'.repeat(64)}`, afterId = `sha256:${'2'.repeat(64)}`;

/** Create an isolated complete v4 team with synthetic legacy pairs and preserved local state. */
function fixture(t, { preset = 'connectathon-easy', environment = 'test', catalog = false, customSampling = false, empty = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm04108-'));
    t?.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json'), stateDirectory = path.join(directory, 'state'), certsDirectory = path.join(directory, 'certs'), reviewPath = path.join(directory, 'review.json');
    fs.mkdirSync(stateDirectory); fs.mkdirSync(certsDirectory);
    const config = buildTeamConfig({ contract: { environment } }, preset);
    config.contract.pcmIgVersion = '0.4.0'; config.contract.pcmIgCommit = 'a19378fd0978ef8e998ffee71ec8e782cf329c2a';
    config.runtime.stateDir = stateDirectory; config.runtime.certsDir = certsDirectory;
    config.presence.sources = { 'ho-a': { maxPatients: 150, maxResponseBytes: 300000 }, legacy: { maxPatients: 120 } };
    config.systemAuthorization.participatingHmos = empty ? [] : ['ho-a'];
    config.security.pcmApi.accessTokenExpiresInSeconds = environment === 'production' ? 17 : 4000;
    if (catalog || customSampling) {
        config.serviceCatalog = { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: config.service.id, instanceIdentifier: config.service.instanceIdentifier || 'PCM-HS-INST-0001' }] };
        const definition = structuredClone(require('../../config/demo-services.json'));
        // Historical normative-migration fixture predates exact service grants.
        for (const item of definition.clinicalServices) delete item.serviceGrant;
        if (customSampling) {
            config.sandboxSampling = { sourceIds: ['ho-a'] };
            config.systemAuthorization.clientEntitlements[config.organizations.serviceProvider.clientId] = ['sandbox-patient-sample'];
            definition.sandboxSampling.name = 'Explicit custom retained sampler';
            definition.sandboxSampling.serviceId = 'custom-sampling-service'; definition.sandboxSampling.policyId = 'custom-sampling-policy';
        }
        fs.mkdirSync(path.join(directory, 'config')); fs.writeFileSync(path.join(directory, config.serviceCatalog.file), checkpoint.encode(definition));
    }
    fs.writeFileSync(configPath, checkpoint.encode(config));
    const store = new FHIRStore();
    const previous = process.env.TEAM_CONFIG_PATH; process.env.TEAM_CONFIG_PATH = configPath;
    try {
        for (const resource of require('../../src/pcm-core/src/bootstrap').buildSeedResources(config)) store.add(resource);
        require('../../src/pcm-core/src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
        // Even this historical normative-migration graph retains the current sampler's private owner;
        // a public-resource copy alone is not a complete custom-policy checkpoint.
        for (const resource of require('../../src/pcm-core/src/fhir/sampling-policy').samplingResourceDrafts(config)) require('../../src/pcm-core/src/public-fhir').publishNewResource(store, resource);
    } finally { if (previous) process.env.TEAM_CONFIG_PATH = previous; else delete process.env.TEAM_CONFIG_PATH; }
    const sourceMembership = {};
    for (const suffix of ['presence', 'patient-authentication', 'dependent-discovery']) {
        // Historical examples are not publicly packaged. This explicitly synthetic graph
        // retains permission fields so conversion/rollback tests still exercise real migration logic.
        const { contract, service } = require('../../test-support/legacy-system-policy').legacyPair(
            suffix, `Organization/${config.organizations.pcm.id}`);
        store.add(service); store.add(contract);
        sourceMembership[contract.id] = empty ? [] : [config.healthOrganizations[0].dataSourceOrganization.id];
    }
    store.add({ resourceType: 'Consent', id: 'retained-consent', status: 'inactive', patient: { identifier: { system: 'urn:fixture', value: 'only-synthetic' } }, extension: [{ url: 'urn:retained-decision', valueString: 'revoked' }] });
    const approvedKeys = [];
    for (const [clientId, registration] of migration.registrations(config)) {
        const file = [...registration.files][0];
        if (!fs.existsSync(path.join(certsDirectory, file))) {
            const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: clientId.includes('authentication') ? 'secp384r1' : 'prime256v1' });
            fs.writeFileSync(path.join(certsDirectory, file), publicKey.export({ type: 'spki', format: 'pem' }));
        }
        const bytes = fs.readFileSync(path.join(certsDirectory, file));
        approvedKeys.push({ clientId, file, sha256: checkpoint.sha256(bytes), algorithm: signingAlgorithm(bytes), kid: jwkThumbprint(bytes) });
    }
    const review = { schema: 'pcm-migration-review/1', runtime: { before: beforeId, after: afterId }, sourceMembership, approvedKeys, catalogReconciliation: true };
    fs.writeFileSync(reviewPath, checkpoint.encode(review));
    fs.mkdirSync(path.join(stateDirectory, 'data-operations'));
    fs.writeFileSync(path.join(stateDirectory, 'data-operations', 'completed-import.json'), checkpoint.encode({ id: 'old-import', phase: 'succeeded', status: 'completed', kind: 'import', serverId: 'ho-a', createdAt: '2026-01-01T00:00:00Z', result: 'verified', submittedOutcome: 'accepted' }));
    for (const namespace of ['assertion-replay', 'first-use-windows']) {
        fs.mkdirSync(path.join(stateDirectory, namespace));
        fs.writeFileSync(path.join(stateDirectory, namespace, 'retained-reservation.json'), checkpoint.encode({ expiresAt: 2200000000, startedAt: 1700000000, syntheticReservation: namespace }));
    }
    fs.mkdirSync(path.join(directory, 'clinical')); fs.writeFileSync(path.join(directory, 'clinical', 'Patient.json'), '{"resourceType":"Patient","id":"preserved-only-synthetic"}\n');
    checkpoint.prepare({ store, configPath, stateDirectory, runtimeId: beforeId });
    const options = { configPath, stateDirectory, certsDirectory, reviewPath, workersStopped: true, stoppedAt: new Date(Date.now() - 60000).toISOString() };
    return { directory, config, store, review, options, root: path.join(stateDirectory, 'pcm-ig-041') };
}

/** Hash a disposable tree without following symlinks; used to prove preview and unrelated-state preservation. */
function treeHashes(directory) {
    const values = {};
    const walk = current => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) walk(file); else values[path.relative(directory, file)] = checkpoint.sha256(fs.readFileSync(file));
    } };
    walk(directory); return values;
}

module.exports = { fixture, treeHashes, beforeId, afterId };
