'use strict';

/** Hash-bound retained-team planning/publication, used only by the explicit migration CLI. */
const fs = require('fs');
const path = require('path');
const { encode, sha256, atomicWrite } = require('../../src/pcm-core/src/migration-checkpoint');
const { assertOperationsIdle, assertConfigurationIdle, fencePath } = require('../../src/shared/migration-maintenance');
const { FHIRStore, RESOURCE_TYPES } = require('../../src/pcm-core/src/fhir/store');
const { hydrate } = require('../../src/pcm-core/src/migration-checkpoint');
const { convertLegacySystemContract, validateSystemContract } = require('../../src/pcm-core/src/fhir/system-contract');
const { SCENARIOS, scenarioOf } = require('../../src/pcm-core/src/fhir/system-policy');
const { DEFAULTS, presenceLimits } = require('../../src/shared/presence-limits');
const { assertValidTeamConfig, structuralErrors } = require('../../src/shared/team-config-validator');
const { jwkThumbprint, signingAlgorithm } = require('../../src/shared/assertion-keys');
const read = file => JSON.parse(fs.readFileSync(file));

/** List every semantic change deterministically, including removed fields and array entries. */
function changes(before, after, location = '') {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
        return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => changes(before[key], after[key], `${location}/${key}`));
    }
    return [{ path: location || '/', ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }];
}

/** Reject path aliases, symlinks and non-local catalogs; publication never rewrites shared files. */
function localFile(root, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Migration requires safe team-local files');
    const file = path.resolve(root, relative);
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep) || fs.lstatSync(file).isSymbolicLink()) throw new Error('Migration refuses escaping/symlinked team files');
    return file;
}

/** Collect only existing client registrations and their approved public-material references. */
function registrations(config) {
    const result = new Map();
    const add = (client, role, fallback) => {
        if (!client?.clientId) return;
        if (result.has(client.clientId)) throw new Error(`Ambiguous registered client ${client.clientId}`);
        const configured = client.assertionCertificates || client.pcmClientAuth?.assertionCertificates || {};
        result.set(client.clientId, { client, files: new Set([fallback || config.certificateRoles?.[role]?.assertion?.cert,
            ...Object.values(configured).flat()].filter(Boolean)) });
    };
    for (const role of ['serviceProvider', 'hospitalBServiceProvider', 'referenceDataSource']) add(config.organizations[role], role);
    for (const [role, client] of Object.entries(config.oauthClients || {})) add(client, role);
    for (const source of config.healthOrganizations || []) add(source, null, source.certificates?.gatewayAssertionCert);
    for (const source of config.organizations.dataSources || []) add(source, null, source.pcmClientAuth?.cert || source.cert);
    return result;
}

/** Validate explicit key approvals against actual registered public files, with no generated/fallback keys. */
function keyMetadata(config, review, certsDirectory, capture, errors) {
    const registered = registrations(config), result = [];
    for (const approval of review.approvedKeys || []) {
        try {
            const registration = registered.get(approval.clientId);
            if (!registration || !registration.files.has(approval.file)) throw new Error(`Unknown client or unregistered approved key: ${approval.clientId}/${approval.file}`);
            const file = localFile(certsDirectory, approval.file), bytes = capture(file);
            if (bytes.includes('PRIVATE KEY')) throw new Error('Approved signing metadata requires public material only');
            const actual = { clientId: approval.clientId, file: approval.file, sha256: sha256(bytes), algorithm: signingAlgorithm(bytes), kid: jwkThumbprint(bytes) };
            if (['sha256', 'algorithm', 'kid'].some(key => actual[key] !== approval[key])) throw new Error(`Approved public key metadata mismatch for ${approval.clientId}/${approval.file}`);
            result.push(actual);
            // Managed source keys are already registered through certificates.gatewayAssertionCert.
            // Do not invent a second configuration namespace on those closed source shapes.
            if (registration.client.certificates) continue;
            registration.client.assertionCertificates ||= {};
            const values = new Set([].concat(registration.client.assertionCertificates[actual.algorithm] || [], approval.file));
            registration.client.assertionCertificates[actual.algorithm] = [...values].sort();
        } catch (error) { errors.push(error.message); }
    }
    for (const [id] of registered) if (!result.some(value => value.clientId === id)) errors.push(`Explicit existing public-key approval required for client ${id}`);
    return result.sort((a, b) => `${a.clientId}/${a.file}`.localeCompare(`${b.clientId}/${b.file}`));
}

/** Detect business identity collisions independently of resource type aliases. */
function assertIdentities(resources) {
    for (const type of RESOURCE_TYPES) {
        const ids = new Set(), identifiers = new Map();
        for (const resource of resources[type] || []) {
            if (ids.has(resource.id)) throw new Error(`Duplicate logical identity ${type}/${resource.id}`);
            ids.add(resource.id);
            for (const id of resource.identifier || []) {
                const key = `${id.system}|${id.value}`;
                if (identifiers.has(key) && identifiers.get(key) !== resource.id) throw new Error(`Business identity collision ${type}/${key}`);
                identifiers.set(key, resource.id);
            }
        }
    }
}

/** Preview all convertible resources and unresolved mappings; no filesystem mutation occurs here. */
function plan({ configPath, stateDirectory, certsDirectory, reviewPath }) {
    configPath = path.resolve(configPath); stateDirectory = path.resolve(stateDirectory);
    const root = path.join(stateDirectory, 'pcm-ig-041'), inputs = {}, errors = [];
    const capture = file => { const bytes = fs.readFileSync(file); inputs[path.resolve(file)] = sha256(bytes); return bytes; };
    const configBytes = capture(configPath), current = JSON.parse(configBytes), config = structuredClone(current);
    const review = JSON.parse(capture(reviewPath));
    const manifest = JSON.parse(capture(path.join(root, 'manifest.json')));
    const resources = JSON.parse(capture(path.join(root, 'checkpoint.json'))), next = structuredClone(resources);
    const attempt = action => { try { return action(); } catch (error) { errors.push(error.message); } };
    if (manifest.phase !== 'prepared' || manifest.configHash !== sha256(configBytes) || manifest.checkpointHash !== inputs[path.join(root, 'checkpoint.json')]) errors.push('Fresh frozen online checkpoint required; checkpoint/config hash or phase mismatch');
    if (!fs.existsSync(fencePath(stateDirectory))) errors.push('Online checkpoint maintenance fence is missing');
    else capture(fencePath(stateDirectory));
    attempt(() => assertOperationsIdle(stateDirectory));
    attempt(() => assertConfigurationIdle(stateDirectory));
    const operations = path.join(stateDirectory, 'data-operations');
    if (fs.existsSync(operations)) for (const name of fs.readdirSync(operations).sort()) if (fs.statSync(path.join(operations, name)).isFile()) capture(path.join(operations, name));
    if (!['pcm-migration-review/1', 'pcm-scope-migration-review/1', 'pcm-public-metadata-review/1'].includes(review.schema) || review.runtime?.before !== manifest.runtimeId
        || !/^sha256:[a-f0-9]{64}$/.test(review.runtime?.after || '')) errors.push('Explicit matching before/after immutable runtime identities required');
    if (review.schema === 'pcm-public-metadata-review/1') {
        const metadata = require('./public-metadata-migration-plan').metadataPlan({ current, resources, review, stateDirectory, configPath, certsDirectory, capture, errors, attempt });
        attempt(() => assertIdentities(resources)); attempt(() => assertIdentities(metadata.candidate));
        const { candidate, ...details } = metadata;
        const result = { schema: 'pcm-public-metadata-plan/1', configPath, stateDirectory, inputs, runtime: review.runtime, ...details,
            operationNames: fs.existsSync(operations) ? fs.readdirSync(operations).sort() : [], errors: [...new Set(errors)].sort(),
            publications: { [configPath]: configBytes.toString('base64'), [path.join(root, 'checkpoint.json')]: encode(candidate).toString('base64') } };
        result.digest = sha256(encode(result)); return result;
    }
    if (review.schema === 'pcm-scope-migration-review/1') {
        const scope = require('./scope-migration-plan').scopePlan({ current, config, resources, review, stateDirectory, configPath, capture, errors, attempt });
        attempt(() => assertIdentities(resources));
        const result = { schema: 'pcm-scope-migration-plan/1', configPath, stateDirectory, inputs, runtime: review.runtime, ...scope,
            operationNames: fs.existsSync(operations) ? fs.readdirSync(operations).sort() : [], errors: [...new Set(errors)].sort(),
            semanticChanges: changes(current, config, '/config'), publications: { [configPath]: encode(config).toString('base64'),
                [path.join(root, 'checkpoint.json')]: encode(resources).toString('base64') } };
        result.digest = sha256(encode(result)); return result;
    }
    attempt(() => {
        // Retained 0.4.0 inputs are accepted only at this explicit conversion
        // boundary. Ordinary startup remains locked to the active runtime.
        const active = require('../../src/shared/pcm-contract').PCM_IG;
        const baseline = config.contract?.pcmIgVersion === '0.4.0' && config.contract?.pcmIgCommit === 'a19378fd0978ef8e998ffee71ec8e782cf329c2a';
        const current = config.contract?.pcmIgVersion === active.version && config.contract?.pcmIgCommit === active.commit;
        if (!baseline && !current) throw new Error('Unreviewed retained PCM-IG identity');
        config.contract.pcmIgVersion = active.version;
        config.contract.pcmIgCommit = active.commit;
        assertValidTeamConfig(config, { env: {} });
    });
    attempt(() => require('../../src/shared/identity-mapping').getEffectiveBusinessIdOverrides(config));
    const approvedKeys = attempt(() => keyMetadata(config, review, certsDirectory, capture, errors)) || [];
    config.presence ||= {};
    config.presence.batch = { ...DEFAULTS, ...config.presence.batch };
    attempt(() => presenceLimits(config));
    for (const id of Object.keys(config.presence.sources || {})) attempt(() => presenceLimits(config, { id }));
    attempt(() => assertIdentities(resources));
    const store = new FHIRStore(); attempt(() => hydrate(store, resources));
    const memberships = review.sourceMembership || {}, converted = [], serviceIds = new Set();
    for (const scenario of Object.keys(SCENARIOS)) {
        const policies = next.Contract.filter(value => scenarioOf(value) === scenario);
        if (policies.length !== 1) { errors.push(`Expected exactly one normative ${scenario} grant; found ${policies.length}`); continue; }
        const contract = policies[0];
        attempt(() => {
            const sources = memberships[contract.id];
            if (!Array.isArray(sources)) throw new Error(`Explicit reviewed source membership required for ${contract.id}; [] explicitly means no enrolled sources`);
            const eligible = scenario === 'presence-check'
                ? require('../../src/pcm-core/src/data-sources').getConfiguredDataSources(config).filter(source => source.enabled !== false).map(source => source.id)
                : (config.healthOrganizations || []).filter(source => config.systemAuthorization.participatingHmos.includes(source.id)).map(source => source.dataSourceOrganization.id);
            if (sources.some(id => !eligible.includes(id))) throw new Error(`Unreviewed/ineligible source membership for ${contract.id}`);
            let value;
            if (contract.topicReference) {
                const serviceId = contract.topicReference.reference?.replace(/^HealthcareService\//, '');
                const service = store.get('HealthcareService', serviceId);
                value = convertLegacySystemContract({ store, contract, service, pcmOrganizationId: config.organizations.pcm.id, sourceOrganizationIds: sources });
                serviceIds.add(serviceId);
            } else {
                const validated = validateSystemContract(store, contract, config.organizations.pcm.id);
                if (JSON.stringify([...validated.sources].sort()) !== JSON.stringify([...sources].sort())) throw new Error(`Existing explicit sources differ from reviewed mapping for ${contract.id}; use grant maintenance first`);
                value = contract;
            }
            next.Contract[next.Contract.indexOf(contract)] = value; converted.push(contract.id);
        });
    }
    for (const id of Object.keys(memberships)) if (!converted.includes(id)) errors.push(`Unresolved/unknown policy membership mapping ${id}`);
    for (const contract of next.Contract) if (!Object.hasOwn(SCENARIOS, scenarioOf(contract))) attempt(() => {
        if (!require('../../src/pcm-core/src/fhir/sampling-policy').isSamplingPolicy(contract)) throw new Error(`Incompatible local Contract ${contract.id}; review under a new grant before migration`);
        const validated = require('../../src/pcm-core/src/fhir/sampling-policy').validateSamplingPolicy(store, contract, config.organizations.pcm.id);
        const applications = ['serviceProvider', 'hospitalBServiceProvider'].map(role => config.organizations[role]?.clientId);
        if (validated.clients.some(id => !applications.includes(id) || !config.systemAuthorization.clientEntitlements[id]?.includes('sandbox-patient-sample'))
            || validated.sources.some(id => !config.sandboxSampling?.sourceIds.includes(id))) throw new Error(`Incompatible local sampling entitlement/source mapping ${contract.id}; reconcile the retained grant explicitly`);
    });
    const references = (value, reference) => value && typeof value === 'object' && (value.reference === reference || Object.values(value).some(child => references(child, reference)));
    const retired = [], retainedShared = [];
    for (const id of [...serviceIds].sort()) {
        if (Object.values(next).flat().some(resource => !(resource.resourceType === 'HealthcareService' && resource.id === id) && references(resource, `HealthcareService/${id}`))) retainedShared.push(id);
        else { next.HealthcareService = next.HealthcareService.filter(value => value.id !== id); retired.push(id); }
    }
    let catalogPath, catalog, catalogBefore;
    if (config.serviceCatalog) attempt(() => {
        catalogPath = localFile(path.dirname(configPath), config.serviceCatalog.file);
        catalogBefore = JSON.parse(capture(catalogPath));
        catalog = require('./migrate-service-catalog').reconcileRetainedCatalog(catalogBefore, review.catalogReconciliation === true);
        for (const definition of catalog.systemPolicies) {
            const policy = next.Contract.find(item => item.id === definition.policyId);
            if (!policy || scenarioOf(policy) !== definition.scenario || policy.identifier[0].value !== definition.policyIdentifier) throw new Error(`Catalog/Contract identity mismatch for ${definition.policyId}`);
            delete definition.serviceId; delete definition.serviceIdentifier;
        }
        const schema = require('../../config/demo-services.schema.json');
        const invalid = structuralErrors(catalog, schema); if (invalid.length) throw new Error(`Invalid reconciled catalog: ${invalid.join('; ')}`);
        require('../../src/shared/service-catalog').validateCatalogGraph(catalog, config);
    });
    // Clinical service type changes are reviewable exact substitutions, never code/title inference.
    for (const mapping of review.serviceTypes || []) attempt(() => {
        const service = next.HealthcareService.find(value => value.id === mapping.id);
        if (!service || JSON.stringify(service.type) !== JSON.stringify(mapping.before) || !Array.isArray(mapping.after) || mapping.after.length !== 1) throw new Error(`Unresolved explicit service type mapping ${mapping.id}`);
        service.type = structuredClone(mapping.after);
    });
    for (const service of next.HealthcareService) attempt(() => {
        if (require('../../src/pcm-core/src/fhir/system-policy').isSystemService(service)) return;
        for (const ext of service.extension || []) if (ext.url === require('../../src/shared/pcm-contract').EXTENSIONS.informationBucket) {
            if (ext.extension?.some(part => part.url === 'taggedDetail')) {
                if (review.catalogReconciliation !== true || ext.extension.some(part => part.url === 'taggedDetails')) throw new Error(`Ambiguous/unreviewed retained plural tags in ${service.id}`);
                ext.extension.filter(part => part.url === 'taggedDetail').forEach(part => { part.url = 'taggedDetails'; });
            }
        }
        const invalid = require('../../src/shared/pcm-contract').validateSeedResource(service);
        if (invalid.length) throw new Error(`Clinical service ${service.id} requires explicit reconciliation: ${invalid.join('; ')}`);
        const coding = service.type?.[0]?.coding;
        if (coding?.length !== 1 || coding[0].system !== 'http://terminology.hl7.org/CodeSystem/v3-ActCode' || coding[0].code !== 'INFA') throw new Error(`Clinical service ${service.id} requires reviewed exact INFA type reconciliation`);
        for (const ext of service.extension || []) if (ext.url === require('../../src/shared/pcm-contract').EXTENSIONS.informationBucket) require('../../src/shared/information-buckets').parseInformationBucket(ext);
    });
    attempt(() => assertIdentities(next));
    attempt(() => assertValidTeamConfig(config, { env: {} }));
    const result = { schema: 'pcm-migration-plan/1', configPath, stateDirectory, inputs, operationNames: fs.existsSync(operations) ? fs.readdirSync(operations).sort() : [],
        runtime: review.runtime, approvedKeys, retired, retainedShared, errors: [...new Set(errors)].sort(),
        semanticChanges: [...changes(current, config, '/config'), ...changes(resources, next, '/resources'), ...(catalog ? changes(catalogBefore, catalog, '/catalog') : [])],
        publications: { [configPath]: encode(config).toString('base64'), [path.join(root, 'checkpoint.json')]: encode(next).toString('base64'), ...(catalog ? { [catalogPath]: encode(catalog).toString('base64') } : {}) } };
    result.digest = sha256(encode(result));
    return result;
}

/** Recheck the complete reviewed input set, including the reservation directory membership. */
function assertFresh(plan) {
    for (const [file, hash] of Object.entries(plan.inputs)) if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== hash) throw new Error(`Stale preview input ${file}; checkpoint and preview again`);
    for (const [namespace, names] of Object.entries(plan.stateInventories || {})) {
        const directory = path.join(plan.stateDirectory, namespace);
        if (JSON.stringify(fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []) !== JSON.stringify(names)) throw new Error(`Stale ${namespace} membership; checkpoint and preview again`);
    }
    for (const [directory, expected] of Object.entries(plan.directoryInventories || {})) {
        if (require('../../src/shared/migration-hash').hash(require('../../src/shared/public-metadata-compatibility').inventory(directory)) !== require('../../src/shared/migration-hash').hash(expected)) throw new Error(`Stale inventory ${directory}; checkpoint and preview again`);
    }
    assertOperationsIdle(plan.stateDirectory);
    assertConfigurationIdle(plan.stateDirectory);
    const operations = path.join(plan.stateDirectory, 'data-operations');
    if (JSON.stringify(fs.existsSync(operations) ? fs.readdirSync(operations).sort() : []) !== JSON.stringify(plan.operationNames)) throw new Error('Stale operation ledger/reservation set; preview again');
}

/** Invalidate transient authority without copying any live credentials into backups. */
function invalidate(stateDirectory) {
    for (const name of ['access-tokens', 'oauth-authorization', 'source-presence']) {
        fs.rmSync(path.join(stateDirectory, name), { recursive: true, force: true });
    }
    // Assertion replay reservations and Consent first-use windows survive:
    // deleting either would let old assertions or one-time authority be reused.
}

/** Complete a journaled stopped-runtime publication; each file must still be exactly old or new. */
function recover(stateDirectory, { workersStopped = false, failAfter = Infinity } = {}) {
    if (!workersStopped) throw new Error('Explicit --workers-stopped is required; stop all PCM/SP/adapters/import workers first');
    const root = path.join(stateDirectory, 'pcm-ig-041'), journalPath = path.join(root, 'journal.json'), journal = read(journalPath);
    assertOperationsIdle(stateDirectory);
    assertConfigurationIdle(stateDirectory);
    if (journal.manifest.metadataBoundary) {
        if (!fs.existsSync(journal.manifest.privateBackup) || sha256(fs.readFileSync(journal.manifest.privateBackup)) !== journal.manifest.privateBackupHash) throw new Error('Recovery conflict in private backup; preserve original backup/index and reconcile');
        require('../../src/shared/public-metadata-compatibility').assertArtifacts(journal.manifest.metadataBoundary);
        for (const [directory, expected] of Object.entries(journal.manifest.preservedStateInventories || {})) {
            if (require('../../src/shared/migration-hash').hash(require('../../src/shared/public-metadata-compatibility').inventory(directory)) !== require('../../src/shared/migration-hash').hash(expected)) throw new Error(`Recovery conflict in preserved inventory ${directory}; keep stopped and reconcile`);
        }
        for (const [file, expected] of Object.entries(journal.manifest.metadataRecoveryInputs || {})) {
            if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected) throw new Error(`Recovery conflict at metadata binding ${file}; keep stopped and reconcile`);
        }
    }
    for (const [file, expected] of Object.entries(journal.manifest.preservedStateFiles || {})) {
        if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected) throw new Error(`Recovery conflict in preserved usage/replay state ${file}; keep stopped and reconcile without deleting consumed records`);
    }
    for (const item of journal.files) {
        const hash = fs.existsSync(item.file) ? sha256(fs.readFileSync(item.file)) : null;
        if (![item.beforeHash, item.afterHash].includes(hash)) throw new Error(`Recovery conflict at ${item.file}; keep stopped, preserve current bytes and reconcile against backup ${journal.backupDirectory}`);
    }
    let written = 0;
    for (const item of journal.files) {
        atomicWrite(item.file, Buffer.from(item.bytes, 'base64'));
        if (++written === failAfter) throw new Error('Injected interrupted publication; keep stopped and --recover');
    }
    invalidate(stateDirectory);
    atomicWrite(path.join(root, 'manifest.json'), encode(journal.manifest));
    fs.rmSync(journalPath);
    fs.rmSync(fencePath(stateDirectory), { force: true });
    return { status: journal.manifest.phase, runtimeId: journal.manifest.runtimeId, backupDirectory: journal.backupDirectory,
        ...(journal.manifest.metadataBoundary ? { schema: 'pcm-public-metadata-result/1', digest: journal.manifest.planDigest,
            scope: [...RESOURCE_TYPES, '_private'], privateSchema: journal.manifest.metadataBoundary.privateSchema,
            publicProjectionSchema: journal.manifest.metadataBoundary.publicProjectionSchema, records: journal.manifest.metadataSummary,
            privateBackup: journal.manifest.privateBackup, privateBackupHash: journal.manifest.privateBackupHash } : {}) };
}

/** Capture exact scoped bytes before creating a write-ahead journal, then publish through recovery. */
function publish({ stateDirectory, publications, manifest, backupDirectory, workersStopped, failAfter }) {
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const files = Object.entries(publications).map(([file, bytes], index) => {
        const original = fs.readFileSync(file), backup = path.join(backupDirectory, `${index}.bytes`);
        if (fs.existsSync(backup)) {
            if (!fs.readFileSync(backup).equals(original)) throw new Error(`Conflicting migration backup ${backup}`);
        } else atomicWrite(backup, original);
        return { file, beforeHash: sha256(original), afterHash: sha256(Buffer.from(bytes, 'base64')), bytes, backup };
    });
    const root = path.join(stateDirectory, 'pcm-ig-041');
    const manifestBackup = path.join(backupDirectory, 'manifest.bytes'), manifestBytes = fs.readFileSync(path.join(root, 'manifest.json'));
    if (fs.existsSync(manifestBackup)) {
        if (!fs.readFileSync(manifestBackup).equals(manifestBytes)) throw new Error('Conflicting migration manifest backup');
    } else atomicWrite(manifestBackup, manifestBytes);
    const journal = { schema: 'pcm-migration-journal/1', files, manifest, backupDirectory };
    atomicWrite(path.join(backupDirectory, 'index.json'), encode(journal));
    atomicWrite(path.join(root, 'journal.json'), encode(journal));
    return recover(stateDirectory, { workersStopped, failAfter });
}

/** Apply only the exact recomputed preview digest after an explicit stopped-runtime boundary. */
function apply(options) {
    if (!options.workersStopped) throw new Error('Explicit --workers-stopped is required after online checkpoint');
    const root = path.join(options.stateDirectory, 'pcm-ig-041'), manifest = read(path.join(root, 'manifest.json'));
    if (fs.existsSync(path.join(root, 'journal.json'))) throw new Error('Interrupted publication; keep workers stopped and use --recover');
    if (manifest.phase === 'applied' && manifest.planDigest === options.expectedDigest) return { status: 'no-further-work', runtimeId: manifest.runtimeId };
    const preview = plan(options);
    if (preview.digest !== options.expectedDigest) throw new Error('Stale preview digest; review all changes/errors in a fresh preview');
    if (preview.errors.length) throw new Error(`Unresolved migration: ${preview.errors.join('; ')}`);
    assertDrained(options.stoppedAt);
    assertFresh(preview);
    const backupDirectory = path.join(root, `backup-${preview.digest}`);
    if (preview.metadataBoundary) {
        const owner = new FHIRStore(); hydrate(owner, JSON.parse(Buffer.from(preview.publications[path.join(root, 'checkpoint.json')], 'base64')));
        const envelope = require('../../src/pcm-core/src/private-checkpoint').exportPrivateCheckpoint(owner, preview.compatibility);
        fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        atomicWrite(path.join(backupDirectory, 'private-checkpoint.json'), encode(envelope));
    }
    return publish({ ...options, publications: preview.publications, backupDirectory, manifest: { schema: 'pcm-migration/1', phase: 'applied',
        runtimeId: preview.runtime.after, priorRuntimeId: preview.runtime.before, planDigest: preview.digest, credentialEpoch: require('crypto').randomUUID(),
        checkpointHash: sha256(Buffer.from(preview.publications[path.join(root, 'checkpoint.json')], 'base64')),
        configHash: sha256(Buffer.from(preview.publications[preview.configPath], 'base64')), approvedKeys: preview.approvedKeys, backupDirectory,
        ...(preview.scopeBoundary ? { scopeBoundary: preview.scopeBoundary, preservedStateFiles: preview.preservedStateFiles, preservedStateHash: preview.preservedStateHash,
            appliedConsentHash: sha256(encode(JSON.parse(Buffer.from(preview.publications[path.join(root, 'checkpoint.json')], 'base64')).Consent)) } : {}),
        ...(preview.metadataBoundary ? { metadataBoundary: preview.metadataBoundary, preservedStateFiles: preview.preservedStateFiles,
            preservedStateInventories: preview.directoryInventories,
            metadataRecoveryInputs: Object.fromEntries(Object.entries(preview.inputs).filter(([file]) => !Object.hasOwn(preview.publications, file)
                && ![options.reviewPath, path.join(root, 'manifest.json'), fencePath(options.stateDirectory)].includes(file))),
            metadataSummary: Object.fromEntries(['changed', 'unchanged', 'rejected'].map(outcome => [outcome, preview.inventory.filter(item => item.outcome === outcome).length])),
            privateBackupHash: sha256(fs.readFileSync(path.join(backupDirectory, 'private-checkpoint.json'))),
            privateBackup: path.join(backupDirectory, 'private-checkpoint.json') } : {}),
        appliedConfigHash: sha256(Buffer.from(preview.publications[preview.configPath], 'base64')),
        appliedPolicyHash: authorityHash(JSON.parse(Buffer.from(preview.publications[path.join(root, 'checkpoint.json')], 'base64'))) } });
}

/** Conservative rollback guard: later authority changes require explicit restriction-preserving recovery. */
function authorityHash(resources) { return sha256(encode(Object.fromEntries(['Contract', 'Organization', 'Endpoint', 'HealthcareService'].map(type => [type, resources[type]])))); }

/** Wait beyond the existing private JWT's 30-second maximum without rotating approved certificates. */
function assertDrained(stoppedAt) {
    const instant = require('../../src/pcm-core/src/fhir/system-policy').timestamp(stoppedAt);
    if (Date.now() / 1000 - instant < 31) throw new Error('Keep all team workers stopped for at least 31 seconds before publication; pass their actual --stopped-at timestamp to expire old private JWTs');
}

/** Restore matching old config/policy while retaining current Consent decisions and invalidating credentials. */
function rollback({ configPath, stateDirectory, workersStopped = false, stoppedAt, failAfter }) {
    if (!workersStopped) throw new Error('Stop all team workers after a fresh online checkpoint, then pass --workers-stopped');
    const root = path.join(stateDirectory, 'pcm-ig-041'), prepared = read(path.join(root, 'manifest.json'));
    const manifest = prepared.phase === 'prepared' ? prepared.previous : prepared;
    if (prepared.phase !== 'prepared' || !fs.existsSync(fencePath(stateDirectory)) || manifest?.phase !== 'applied') throw new Error('Rollback requires a fresh online checkpoint of the applied runtime');
    if (manifest?.metadataBoundary) throw new Error('Metadata rollback requires --public-metadata with action restore, exact reviewed private backup and compatible artifacts. Generic legacy rollback cannot restore private authority safely; resume-current is available.');
    assertOperationsIdle(stateDirectory);
    const current = read(path.join(root, 'checkpoint.json'));
    if (manifest.scopeBoundary) {
        const { assertScopeVersions } = require('../../src/shared/scope-model-versions');
        try { assertScopeVersions(manifest.scopeBoundary.beforeVersions); } catch { throw new Error('UNSAFE RESTORE: prior runtime has an incompatible scope boundary; resume-current or review a restriction-preserving compatible rollback artifact.'); }
        if (sha256(encode(current.Consent)) !== manifest.appliedConsentHash) throw new Error('UNSAFE RESTORE: post-cutover Consent decision/source/revocation changed; preserve current decisions and resume-current.');
    }
    if (manifest.appliedConfigHash !== sha256(fs.readFileSync(configPath)) || manifest.appliedPolicyHash !== authorityHash(current)) {
        const applied = read(path.join(manifest.backupDirectory, 'index.json'));
        const baseline = JSON.parse(Buffer.from(applied.files.find(item => item.file === path.join(root, 'checkpoint.json')).bytes, 'base64'));
        const differences = ['Contract', 'Organization', 'Endpoint', 'HealthcareService'].flatMap(type => changes(baseline[type], current[type], `/${type}`)).map(item => item.path);
        if (manifest.appliedConfigHash !== sha256(fs.readFileSync(configPath))) differences.push('/config');
        throw new Error(`UNSAFE RESTORE at ${differences.join(', ')}: later grant revocation, source removal, validity shortening or other authority/config change would be undone. Keep the current runtime/checkpoint; cancel maintenance with --resume-current, or create and review a compatible old-runtime snapshot retaining every restriction. Never copy old policy bytes over the current checkpoint.`);
    }
    assertDrained(stoppedAt);
    const backup = read(path.join(manifest.backupDirectory, 'index.json')), publications = {};
    for (const item of backup.files) {
        const bytes = fs.readFileSync(item.backup);
        if (sha256(bytes) !== item.beforeHash) throw new Error(`Corrupt byte-exact backup ${item.backup}`);
        if (item.file === path.join(root, 'checkpoint.json')) {
            const prior = JSON.parse(bytes); prior.Consent = current.Consent;
            publications[item.file] = encode(prior).toString('base64');
        } else publications[item.file] = bytes.toString('base64');
    }
    const configHash = sha256(Buffer.from(publications[path.resolve(configPath)], 'base64'));
    return publish({ stateDirectory, publications, workersStopped, failAfter, backupDirectory: path.join(root, `rollback-${manifest.planDigest}`),
        manifest: { schema: 'pcm-migration/1', phase: 'rolled-back', runtimeId: manifest.priorRuntimeId, configHash, checkpointHash: sha256(Buffer.from(publications[path.join(root, 'checkpoint.json')], 'base64')), priorPlanDigest: manifest.planDigest, ...(manifest.scopeBoundary ? { scopeBoundary: { ...manifest.scopeBoundary, artifacts: { ...manifest.scopeBoundary.artifacts, pcm: manifest.priorRuntimeId } } } : {}), credentialEpoch: require('crypto').randomUUID() } });
}

/** Resume the frozen current runtime after a rejected/abandoned apply; no old bytes or credentials return. */
function resumeCurrent({ stateDirectory, workersStopped = false }) {
    if (!workersStopped) throw new Error('Stop workers before resuming the reviewed current checkpoint');
    const root = path.join(stateDirectory, 'pcm-ig-041'), file = path.join(root, 'manifest.json'), prepared = read(file);
    if (prepared.phase !== 'prepared' || fs.existsSync(path.join(root, 'journal.json'))) throw new Error('Cannot resume an interrupted publication; use --recover');
    assertOperationsIdle(stateDirectory);
    const manifest = prepared.previous || { schema: 'pcm-migration/1', phase: 'rolled-back', runtimeId: prepared.runtimeId, configHash: prepared.configHash };
    manifest.checkpointHash = prepared.checkpointHash;
    atomicWrite(file, encode(manifest)); invalidate(stateDirectory); fs.rmSync(fencePath(stateDirectory), { force: true });
    return { status: 'resumed-current', runtimeId: manifest.runtimeId };
}

module.exports = { plan, apply, rollback, recover, resumeCurrent, changes, registrations, authorityHash, assertIdentities };
