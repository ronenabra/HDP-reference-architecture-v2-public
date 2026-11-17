'use strict';

/** Metadata-specific plan for the existing stopped checkpoint journal, never a startup converter. */
const fs = require('node:fs');
const path = require('node:path');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const privateBackup = require('../../src/pcm-core/src/private-checkpoint');
const publicFHIR = require('../../src/pcm-core/src/public-fhir');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const { extractLegacy } = require('../../src/pcm-core/src/private-record-extraction');
const { artifacts, inventory } = require('../../src/shared/public-metadata-compatibility');
const { hash } = require('../../src/shared/migration-hash');
const { VERSIONS } = require('../../src/shared/scope-model-versions');
const { assertValidTeamConfig } = require('../../src/shared/team-config-validator');
const { TABLES } = require('../../src/pcm-core/src/private-records');

/** Merge only disjoint or exactly equal legacy records; preserve every existing historical owner. */
function relocate(resources) {
    if (!resources._private) throw new Error('Missing authoritative private/authority checkpoint; reconcile the original live owner before conversion. Public FHIR exports are not backups.');
    const rows = Object.fromEntries(Object.entries(resources).filter(([key]) => key !== '_private'));
    let clean = true;
    for (const values of Object.values(rows)) for (const resource of values) {
        try { publicFHIR.assertPublic(resource); } catch { clean = false; }
    }
    if (clean) return { state: structuredClone(resources), findings: [] };
    const extracted = extractLegacy(rows);
    if (!extracted.valid) throw new Error(extracted.disagreements.map(item => `${item.identity}: ${item.message}; ${item.recovery}`).join('; '));
    const malformedAudit = extracted.inventory.filter(item => item.finding);
    if (malformedAudit.length) throw new Error(`${malformedAudit.map(item => item.identity).join(', ')}: Legacy audit is unrecorded/malformed; preserve original bytes and reconcile exact historical audit before conversion`);
    const state = { ...extracted.publicCandidate, _private: structuredClone(resources._private) };
    // 02's read-only extraction retains legacy field names; 07 publishes the existing runtime owner shape.
    for (const [identity, value] of Object.entries(extracted.privateState.provisioning)) {
        extracted.privateState.provisioning[identity] = { seedTags: value.legacyTags, bookkeeping: value.legacyExtensions };
    }
    for (const table of TABLES) for (const [identity, value] of Object.entries(extracted.privateState[table])) {
        const old = state._private[table][identity];
        if (old && hash(old) !== hash(value)) throw new Error(`${identity}: conflicting existing/legacy ${table}; reconcile original provenance, never select a winning copy`);
        state._private[table][identity] = value;
    }
    state._private.revision = Math.max(state._private.revision, extracted.privateState.revision);
    return { state, findings: extracted.inventory };
}

/** Require each legacy Endpoint trust copy to match its exact configured source owner. */
function assertTrust(resources, config) {
    const sources = require('../../src/pcm-core/src/data-sources').getConfiguredDataSources(config);
    const url = require('../../src/shared/pcm-contract').EXTENSIONS.dataSourceServerTrust;
    for (const endpoint of resources.Endpoint) for (const extension of (endpoint.extension || []).filter(item => item.url === url)) {
        const matches = sources.filter(source => source.endpointId === endpoint.id && source.id === endpoint.managingOrganization?.reference?.replace(/^Organization\//, '') && source.endpoint === endpoint.address);
        if (matches.length !== 1) throw new Error(`Endpoint/${endpoint.id}: legacy trust has no exact configured source/address owner`);
        const trust = matches[0].serverTrust || {}, seen = new Set(), old = {};
        for (const part of extension.extension || []) {
            const valueKeys = Object.keys(part).filter(key => key.startsWith('value'));
            if (!['mode', 'caCert', 'certThumbprint'].includes(part.url) || seen.has(part.url) || valueKeys.length !== 1) throw new Error(`Endpoint/${endpoint.id}: ambiguous legacy trust field`);
            seen.add(part.url); old[part.url] = part[valueKeys[0]];
        }
        const expected = { mode: trust.mode || 'team-root-ca', ...(trust.caCert ? { caCert: trust.caCert } : {}), ...(trust.certThumbprint ? { certThumbprint: trust.certThumbprint } : {}) };
        if (hash(old) !== hash(expected)) throw new Error(`Endpoint/${endpoint.id}: legacy/config trust disagreement; reconcile the configuration owner explicitly`);
    }
}

/** Bind actual owner files and all component versions; preview exposes identities/hashes, never snapshots/secrets. */
function metadataPlan({ current, resources, review, stateDirectory, configPath, certsDirectory, capture, errors, attempt }) {
    if (review.schema !== 'pcm-public-metadata-review/1' || review.optIn !== true || review.restartAll !== true) errors.push('Explicit metadata review, optIn and restartAll are required');
    if (!['relocate', 'restore', 'full-access'].includes(review.action)) errors.push('Choose explicit action relocate, restore or full-access');
    if (Object.keys(review).some(key => !['schema', 'optIn', 'restartAll', 'action', 'runtime', 'repositoryRoot', 'components', 'scopeVersions', 'privateSchema', 'publicProjectionSchema', 'records', 'bindings', 'backupPath', 'reviewedBackupHash', 'fullAccessReview', 'asOf'].includes(key))) errors.push('Unknown metadata review field');
    attempt(() => {
        for (const file of [configPath, stateDirectory, path.join(stateDirectory, 'pcm-ig-041/manifest.json'), path.join(stateDirectory, 'pcm-ig-041/checkpoint.json')]) {
            const stat = fs.lstatSync(file);
            if (fs.realpathSync(file) !== path.resolve(file) || stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error(`Aliased metadata owner path ${file}; preserve original files and reconcile`);
        }
    });
    attempt(() => assertValidTeamConfig(current, { env: {} }));
    if (review.privateSchema !== 'pcm-private-state/1' || review.publicProjectionSchema !== publicFHIR.SCHEMA) errors.push('Unsupported private/public schema; use a compatible component set');
    attempt(() => require('../../src/shared/scope-model-versions').assertScopeVersions(review.scopeVersions));
    const repositoryRoot = path.resolve(review.repositoryRoot || path.join(__dirname, '../..'));
    const components = attempt(() => artifacts(repositoryRoot, capture)) || {};
    if (hash(components) !== hash(review.components || {})) errors.push('Review the measured complete five-component source artifacts');
    if (review.runtime?.after !== components.pcm) errors.push('Target PCM runtime must equal the measured source artifact');
    const inventories = {}, directoryInventories = {}, preservedStateFiles = {};
    const collect = (key, directory) => {
        const value = inventory(directory, capture); directoryInventories[directory] = value; inventories[key] = value; return value;
    };
    if (!certsDirectory) errors.push('Explicit certificate inventory directory required');
    else attempt(() => collect('certificates', path.resolve(certsDirectory)));
    // Inventory complete state namespaces: original hashed usage keys, replay and operation reservations survive.
    for (const name of ['first-use-windows', 'assertion-replay', 'data-operations']) attempt(() => {
        const directory = path.join(stateDirectory, name), files = collect(name, directory);
        for (const [relative, digest] of Object.entries(files)) if (digest) preservedStateFiles[path.join(directory, relative)] = digest;
    });
    const catalog = {};
    if (current.serviceCatalog?.file) attempt(() => {
        const relative = current.serviceCatalog.file;
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Catalog must remain team-local');
        const file = path.resolve(path.dirname(configPath), relative);
        if (fs.realpathSync(file) !== file) throw new Error('Aliased catalog refused');
        catalog[relative] = checkpoint.sha256(capture(file));
    });
    if (certsDirectory) attempt(() => {
        const visit = (value, material = false) => {
            if (material && typeof value === 'string' && !Object.hasOwn(inventories.certificates || {}, value)) throw new Error(`Configured certificate material missing from inventory: ${value}`);
            if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, material || /^(?:cert|key|caCert|rootCaCert|assertionCertificates|certificates)$|(?:Cert|Certificate)$|(?:Server|Mtls|Assertion|Signing|Private)Key$/i.test(key));
        }; visit(current);
    });
    const bindings = { config: checkpoint.sha256(capture(configPath)), certificates: hash(inventories.certificates || {}), catalog: hash(catalog),
        firstUse: hash(inventories['first-use-windows'] || {}), operations: hash(inventories['data-operations'] || {}) };
    if (hash(bindings) !== hash(review.bindings || {})) errors.push('Review exact config/certificate/catalog/usage/operation bindings');
    const compatibility = { privateSchema: 'pcm-private-state/1', publicProjectionSchema: publicFHIR.SCHEMA, components, scopeVersions: VERSIONS, bindings };
    const before = new FHIRStore(); attempt(() => checkpoint.hydrate(before, resources));
    let candidate, findings = [], candidateValidated = false, requiredFullAccessReview = null;
    attempt(() => {
        assertTrust(resources, current);
        if (review.action === 'restore') {
            const backup = JSON.parse(capture(path.resolve(review.backupPath)));
            if (review.reviewedBackupHash !== backup.hash) throw new Error('Review the exact private backup hash before restore');
            candidate = checkpoint.snapshot(privateBackup.validateCandidate(backup, compatibility), { privateState: true });
        } else if (review.action === 'full-access') {
            if (!Number.isFinite(Date.parse(review.asOf)) || new Date(review.asOf).toISOString() !== review.asOf) throw new Error('Review a canonical asOf timestamp for the new full-access definition version.');
            const isolated = new FHIRStore({ clock: () => new Date(review.asOf) }); checkpoint.hydrate(isolated, resources);
            const selected = JSON.parse(capture(path.join(repositoryRoot, 'config/demo-services.json')));
            require('../../src/shared/service-catalog').validateCatalogGraph(selected, current);
            const retainedCatalog = JSON.parse(capture(path.resolve(path.dirname(configPath), current.serviceCatalog.file)));
            const builtin = value => value.clinicalServices.find(item => item.key === 'sandbox-full-access');
            if (hash(builtin(retainedCatalog)) !== hash(builtin(selected))) throw new Error('While workers are stopped, explicitly install the reviewed packaged built-in catalog entry before full-access checkpoint preview; no startup catalog conversion is allowed.');
            const catalogOwner = require('../../src/pcm-core/src/catalog-bootstrap');
            const builtinId = require('../../src/pcm-core/src/fhir/healthcare-service-lifecycle').BUILTIN_CATALOG_ID;
            const proposed = catalogOwner.buildCatalogServices(current, require('../../src/pcm-core/src/bootstrap').serviceShape,
                new Date('2026-11-08T00:00:00Z'), { catalog: selected }).filter(item => item.id === builtinId);
            const preview = catalogOwner.previewCatalog(isolated, proposed);
            requiredFullAccessReview = preview.fullAccessMigration;
            if (!requiredFullAccessReview || review.fullAccessReview !== requiredFullAccessReview.digest) throw new Error('Review the exact full-access definition transition digest; old approvals never widen.');
            catalogOwner.reconcileCatalog(isolated, proposed, preview.versions, () => {}, { fullAccessReview: review.fullAccessReview,
                offlineReview: { workersStopped: true, stateDirectory, repositoryRoot, components } });
            const lifecycle = require('../../src/pcm-core/src/fhir/healthcare-service-lifecycle');
            for (const provider of isolated.getAll('Organization').filter(item => require('../../src/pcm-core/src/fhir/participant-lifecycle').organizationRole(item) === 'service-provider')) {
                if (isolated.privateRecords.services.getProviderDefaults(provider.id).services[builtinId]?.initialized) continue;
                const registrations = isolated.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === builtinId && lifecycle.ownerId(item) === provider.id);
                // Retained absence cannot prove that no deliberate detach occurred. Preserve it conservatively.
                if (!registrations.length) lifecycle.recordProviderDefault(isolated, provider.id, 'disconnected');
                else lifecycle.enrollProviderDefault({ store: isolated, provider });
            }
            candidate = checkpoint.snapshot(isolated, { privateState: true });
        } else { const result = relocate(resources); candidate = result.state; findings = result.findings; }
        for (const [type, values] of Object.entries(candidate).filter(([key]) => key !== '_private')) for (const value of values) {
            try { publicFHIR.assertPublic(value); }
            catch { throw new Error(`${type}/${value.id}: private metadata remains in the public candidate; preserve original bytes and reconcile this record`); }
        }
        const isolated = new FHIRStore(); checkpoint.hydrate(isolated, candidate);
        privateBackup.assertRestrictionsPreserved(before, isolated);
        publicFHIR.assertRetainedCompatibility(isolated);
        const sampling = require('../../src/pcm-core/src/fhir/sampling-policy');
        for (const contract of candidate.Contract.filter(sampling.isSamplingPolicy)) sampling.validateSamplingPolicy(isolated, contract, current.organizations.pcm.id);
        // Restore cannot undo a later status/source/validity change even if an event was never recorded.
        if (review.action === 'restore' && hash(resources) !== hash(candidate)) throw new Error('Unsafe restore: later public/private state differs; preserve current restrictions and review a compatible backup');
        candidateValidated = true;
    });
    // An invalid atomic candidate rejects the whole publication, never reports partially accepted rows.
    if (!candidateValidated) candidate = undefined;
    const records = [];
    for (const [type, values] of Object.entries(resources).filter(([key]) => key !== '_private')) for (const value of values) {
        const identity = `${type}/${value.id}`, after = candidate?.[type]?.find(item => item.id === value.id);
        records.push({ identity, version: value.meta?.versionId, beforeHash: hash(value), afterHash: after ? hash(after) : null,
            outcome: !after ? 'rejected' : hash(value) === hash(after) ? 'unchanged' : 'changed' });
    }
    const requiredReview = [...records, { identity: '_private', version: resources._private?.revision, beforeHash: hash(resources._private || null),
        afterHash: candidate ? hash(candidate._private) : null, outcome: !candidate ? 'rejected' : hash(resources._private) === hash(candidate._private) ? 'unchanged' : 'changed' }];
    if (hash(review.records || []) !== hash(requiredReview)) errors.push('Review every changed/unchanged/rejected record identity, version and exact hash');
    return { candidate: candidate || resources, inventory: requiredReview, requiredReview, findings: findings.map(({ identity, finding }) => ({ identity, ...(finding ? { finding } : {}) })),
        requiredFullAccessReview, compatibility, directoryInventories, preservedStateFiles, measuredComponents: components, measuredBindings: bindings,
        metadataBoundary: { schema: 'pcm-public-metadata-boundary/1', repositoryRoot, components, privateSchema: 'pcm-private-state/1', publicProjectionSchema: publicFHIR.SCHEMA, scopeVersions: VERSIONS } };
}
module.exports = { metadataPlan, relocate, assertTrust };
