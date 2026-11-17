'use strict';

/** Validate and publish the entire catalog graph atomically, preserving retained state. */
const { EXTENSIONS, CODE_SYSTEMS, IDENTIFIER_SYSTEMS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const { loadServiceCatalog, definitionHash } = require('../../shared/service-catalog');
const { addUcumDuration } = require('./fhir/consent-lifecycle');
const HASH_SYSTEM = 'urn:pcm:sandbox:seed-definition';
const SANDBOX_SERVICE = 'urn:pcm:sandbox:full-clinical-access';

/** Build profile-constrained canonicals and explicitly owned application instances. */
function buildCatalogServices(config, shape, now, { catalog = loadServiceCatalog(config) } = {}) {
    if (!catalog) return null;
    const resources = [];
    for (const definition of catalog.clinicalServices) {
        const canonicalId = definition.key === 'lab-follow-up' ? config.service.catalogId || 'service-catalog-1' : `demo-catalog-${definition.key}`;
        let extensions = [
            ...(definition.approvalScopeOptions || []).map(option => ({ url: SANDBOX_EXTENSIONS.approvalScopeOption, extension: [
                { url: 'id', valueString: option.id }, { url: 'label', valueString: option.label }, { url: 'scope', valueString: option.scope }
            ] })),
            { url: EXTENSIONS.serviceBusinessStatus, valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'active' } },
            { url: EXTENSIONS.accessMode, valueCode: definition.accessMode },
            { url: EXTENSIONS.accessDuration, valueDuration: { system: 'http://unitsofmeasure.org', value: definition.durationMonths, code: 'mo' } },
            { url: EXTENSIONS.allowPatientBucketChange, valueBoolean: definition.allowPatientBucketChange },
            ...definition.queries.map(valueString => ({ url: EXTENSIONS.exampleQuery, valueString })),
            ...definition.buckets.map(bucket => ({ url: EXTENSIONS.informationBucket, extension: [
                { url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code: bucket.code }] } },
                { url: 'historyDepth', valueDuration: { system: 'http://unitsofmeasure.org', value: bucket.historyYears, code: 'a' } },
                ...(bucket.taggedDetails || []).map(coding => ({ url: 'taggedDetails', valueCodeableConcept: { coding: [structuredClone(coding)] } }))
            ] }))
        ];
        if (definition.serviceGrant) {
            const { readServiceGrant, URL } = require('../../shared/service-grant');
            const grant = readServiceGrant({ extension: [{ url: URL, valueString: JSON.stringify(definition.serviceGrant) }] });
            const request = require('./service-definition-form').serviceDefinitionDraft(grant.authoring, { now: Date.parse(grant.anchor) / 1000 });
            if (JSON.stringify(readServiceGrant(request)) !== JSON.stringify(grant)) throw new TypeError('Packaged catalog grant differs from its frozen authoring');
            extensions = [{ url: EXTENSIONS.serviceBusinessStatus, valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'active' } }, ...request.extension];
        }
        const build = (kind, id, identifierSystem, value, binding) => {
            const resource = shape(config, kind, id, identifierSystem, value);
            resource.name = definition.name; resource.extraDetails = definition.purpose;
            resource.meta.lastUpdated = now.toISOString();
            resource.meta.tag.push({ system: HASH_SYSTEM, code: definitionHash({ definition, binding, canonicalId, identifierValue: value, provider: binding ? config.organizations[binding.providerRole].id : null }) });
            if (definition.sandboxFullAccess) resource.meta.tag.push({ system: SANDBOX_SERVICE, code: 'true' });
            resource.extension = structuredClone(extensions);
            if (binding) {
                resource.providedBy = { reference: `Organization/${config.organizations[binding.providerRole].id}` };
                resource.extension.push({ url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: `HealthcareService/${canonicalId}` } },
                    { url: EXTENSIONS.approvalWindow, valuePeriod: { start: now.toISOString(), end: addUcumDuration(now, { system: 'http://unitsofmeasure.org', value: 1, code: 'a' }).toISOString() } });
            }
            resource.meta.tag.find(tag => tag.system === HASH_SYSTEM).display = JSON.stringify({ name: resource.name, extraDetails: resource.extraDetails, extension: resource.extension });
            return resource;
        };
        resources.push(build('catalog', canonicalId, IDENTIFIER_SYSTEMS.healthcareServiceCatalog, definition.key === 'lab-follow-up' ? config.service.catalogIdentifier || definition.canonicalIdentifier : definition.canonicalIdentifier));
        for (const binding of config.serviceCatalog.bindings.filter(item => item.serviceKey === definition.key)) {
            resources.push(build('instance', binding.instanceId, IDENTIFIER_SYSTEMS.healthcareServiceInstance, binding.instanceIdentifier, binding));
        }
    }
    return resources;
}

/** Preview additions and definition conflicts without overwriting operator decisions. */
function previewCatalog(store, proposed) {
    const additions = [], conflicts = [], versions = {};
    for (const resource of proposed) {
        const key = `${resource.resourceType}/${resource.id}`;
        const current = store.get(resource.resourceType, resource.id);
        versions[key] = current?.meta?.versionId || null;
        const identity = resource.identifier?.[0];
        if (store.getAll(resource.resourceType).some(item => item.id !== resource.id && item.identifier?.some(value => value.system === identity?.system && value.value === identity?.value))) {
            conflicts.push({ key, reason: 'Business identity already belongs to another resource' }); continue;
        }
        if (!current) {
            const lifecycle = require('./fhir/healthcare-service-lifecycle');
            const providerId = lifecycle.ownerId(resource);
            if (lifecycle.basedOnId(resource) === lifecycle.BUILTIN_CATALOG_ID && providerId
                && store.privateRecords.services.getProviderDefaults(providerId).services[lifecycle.BUILTIN_CATALOG_ID]?.initialized) continue;
            additions.push(resource); continue;
        }
        const retainedHash = store.privateRecords.provisioning.get(current.resourceType, current.id)?.seedTags?.find(tag => tag.system === HASH_SYSTEM)?.code;
        const proposedHash = require('./public-fhir').splitProduced(resource).provisioning?.seedTags?.find(tag => tag.system === HASH_SYSTEM)?.code;
        if (retainedHash !== proposedHash) conflicts.push({ key, reason: 'Changed definition or legacy/operator resource requires explicit reconciliation' });
    }
    const lifecycle = require('./fhir/healthcare-service-lifecycle');
    const builtin = proposed.find(item => item.id === lifecycle.BUILTIN_CATALOG_ID);
    const current = builtin && store.get('HealthcareService', builtin.id);
    const grant = builtin && require('../../shared/service-grant').readServiceGrant(builtin);
    const previous = current && store.privateRecords.services.getDefinition(current.id);
    const fullAccessMigration = previous?.status === 'ok' && previous.grant.scope !== 'patient/*.rs' && grant?.scope === 'patient/*.rs'
        ? { schema: 'pcm-full-access-review/1', target: builtin.id, previousScope: previous.grant.scope, newScope: grant.scope,
            digest: require('../../shared/migration-hash').hash({ checkpoint: require('./migration-checkpoint').snapshot(store, { privateState: true }),
                grant, versions: require('../../shared/scope-model-versions').VERSIONS }),
            consequence: 'Creates a new built-in definition version. Existing approvals remain exact; new broad approval must be explicit. Restore refuses later restrictions.' } : null;
    return { additions, conflicts, versions, fullAccessMigration };
}

/** Publish additions only after full validation; retained definitions are never silently rewritten. */
function publishCatalog(store, proposed) {
    const plan = previewCatalog(store, proposed);
    if (plan.conflicts.length) throw new TypeError(`Catalog reconciliation required: ${plan.conflicts.map(item => item.key).join(', ')}`);
    return store.transaction(() => plan.additions.map(resource => require('./public-fhir').publishNewResource(store, resource)));
}

module.exports = { HASH_SYSTEM, SANDBOX_SERVICE, buildCatalogServices, previewCatalog, publishCatalog };

/** Include the separately entitled local pair in protected catalog preview/reconciliation. */
function proposedCatalog(config) {
    return [...require('./bootstrap').buildSeedDrafts(config).filter(item => item.resourceType === 'HealthcareService'),
        ...require('./fhir/system-policy').buildSystemPolicyDrafts(config),
        ...require('./fhir/sampling-policy').samplingResourceDrafts(config)];
}
module.exports.proposedCatalog = proposedCatalog;

/** Apply an explicitly reviewed definition plan with optimistic concurrency and a restorable backup. */
function reconcileCatalog(store, proposed, expectedVersions, writeBackup, { fullAccessReview, offlineReview } = {}) {
    const plan = previewCatalog(store, proposed);
    if (JSON.stringify(expectedVersions) !== JSON.stringify(plan.versions)) throw new TypeError('Catalog version conflict; refresh the preview');
    if (plan.conflicts.some(item => item.reason === 'Business identity already belongs to another resource')) {
        throw new TypeError('Catalog business identity collision; resolve the existing resource before reconciliation');
    }
    if (plan.fullAccessMigration && fullAccessReview !== plan.fullAccessMigration.digest) throw new TypeError('Review the exact full-access migration preview digest before applying; existing approvals cannot be widened.');
    if (plan.fullAccessMigration) {
        const fs = require('node:fs');
        if (!offlineReview?.workersStopped || !offlineReview.stateDirectory || !fs.existsSync(require('../../shared/migration-maintenance').fencePath(offlineReview.stateDirectory))) throw new TypeError('Full-access definition changes require the coordinated stopped checkpoint migration owner, never live catalog reconciliation.');
        const { artifacts } = require('../../shared/public-metadata-compatibility'), { hash } = require('../../shared/migration-hash');
        if (!offlineReview.repositoryRoot || hash(offlineReview.components) !== hash(artifacts(offlineReview.repositoryRoot))) throw new TypeError('Review all five current source artifacts before full-access migration.');
        require('../../shared/migration-maintenance').assertOperationsIdle(offlineReview.stateDirectory);
        require('../../shared/migration-maintenance').assertConfigurationIdle(offlineReview.stateDirectory);
    }
    // Versioned creation grants cannot be rewritten by seed/config reconciliation.
    // Legacy definitions retain their explicit pre-existing reconciliation path.
    const { URL: grantUrl, readServiceGrant } = require('../../shared/service-grant');
    const permissionUrls = new Set([grantUrl, SANDBOX_EXTENSIONS.approvalScopeOption,
        require('../../shared/service-confidentiality-policy').URL, require('../../shared/service-master-data').URL,
        EXTENSIONS.accessMode, EXTENSIONS.accessDuration, EXTENSIONS.informationBucket, EXTENSIONS.allowPatientBucketChange]);
    const permissions = resource => JSON.stringify({ category: resource.category, type: resource.type,
        extension: (resource.extension || []).filter(item => permissionUrls.has(item.url)).map(item => JSON.stringify(item)).sort() });
    for (const resource of proposed) {
        const current = store.get(resource.resourceType, resource.id);
        if (current?.resourceType === 'HealthcareService' && store.privateRecords.services.getDefinition(current.id).status === 'ok'
            && (permissions(current) !== permissions(require('./public-fhir').splitProduced(resource).resource)
                || JSON.stringify(store.privateRecords.services.getDefinition(current.id).grant) !== JSON.stringify(readServiceGrant(resource)))) {
            const canonicalId = require('./fhir/healthcare-service-lifecycle').basedOnId(current) || current.id;
            if (plan.fullAccessMigration && canonicalId === plan.fullAccessMigration.target) continue;
            throw new TypeError('A versioned service grant requires a new service definition; catalog reconciliation cannot change its permissions or provenance.');
        }
    }
    const backup = require('./migration-checkpoint').snapshot(store, { privateState: true });
    // The caller must durably save the backup before the first write.
    writeBackup(backup);
    return store.transaction(() => proposed.filter(draft => store.get(draft.resourceType, draft.id) || plan.additions.some(item => item.resourceType === draft.resourceType && item.id === draft.id)).map(draft => {
        const { resource, provisioning, definition } = require('./public-fhir').splitProduced(draft);
        const save = value => {
            const committed = store.update(value);
            if (plan.fullAccessMigration?.target === committed.id && definition) store.privateRecords.services.createDefinition({ serviceId: committed.id, ...definition, expectedRevision: store.privateState.revision, expectedVersions: { [`HealthcareService/${committed.id}`]: committed.meta.versionId } });
            if (provisioning) store.privateRecords.provisioning.put({ type: committed.resourceType, id: committed.id, value: provisioning,
                expectedRevision: store.privateState.revision, expectedVersions: { [`${committed.resourceType}/${committed.id}`]: committed.meta.versionId } });
            return committed;
        };
        const current = store.get(resource.resourceType, resource.id);
        if (!current) return require('./public-fhir').publishNewResource(store, draft);
        if (JSON.stringify(current.identifier) !== JSON.stringify(resource.identifier)) throw new TypeError('Catalog reconciliation cannot replace a business identity');
        if (current.providedBy?.reference !== resource.providedBy?.reference) throw new TypeError('Catalog reconciliation cannot reassign provider ownership');
        const meta = { ...current.meta, ...resource.meta,
            ...(current.meta?.security ? { security: current.meta.security } : {}),
            tag: [...(current.meta?.tag || []), ...(resource.meta?.tag || [])]
                .filter((tag, index, all) => all.findIndex(value => value.system === tag.system && value.code === tag.code) === index) };
        if (current.resourceType === 'Contract') {
            if (!require('./fhir/sampling-policy').isSamplingPolicy(current)) {
                // Catalog refresh cannot migrate retained legacy grants or widen their
                // current source list. Explicit retained-team conversion belongs to 041-08.
                require('./fhir/system-policy').validatePolicy(store, current, current.author?.reference?.slice('Organization/'.length));
                const refreshed = { ...current, meta, title: resource.title, extension: resource.extension,
                    term: [{ ...current.term[0], text: resource.term[0].text }] };
                require('./fhir/system-policy').validatePolicy(store, refreshed, current.author.reference.slice('Organization/'.length));
                return save(refreshed);
            }
            // The labelled local pair retains its original lifecycle and validity.
            return save({ ...current, ...resource, meta, status: current.status, issued: current.issued, applies: current.applies });
        }
        const preserved = new Set([EXTENSIONS.approvalWindow, EXTENSIONS.serviceBusinessStatus]);
        const baselineText = store.privateRecords.provisioning.get(current.resourceType, current.id)?.seedTags?.find(tag => tag.system === HASH_SYSTEM)?.display;
        const baseline = baselineText ? JSON.parse(baselineText) : null;
        const groups = (value, url) => (value?.extension || []).filter(item => item.url === url);
        const urls = new Set([...(resource.extension || []), ...(current.extension || [])].map(item => item.url));
        const extension = [...urls].flatMap(url => preserved.has(url) || !baseline
            || JSON.stringify(groups(current, url)) !== JSON.stringify(groups(baseline, url))
            ? groups(current, url) : groups(resource, url));
        return save({ ...current, ...resource, meta, active: current.active,
            name: !baseline || current.name !== baseline.name ? current.name : resource.name,
            extraDetails: !baseline || current.extraDetails !== baseline.extraDetails ? current.extraDetails : resource.extraDetails,
            extension });
    }));
}
module.exports.reconcileCatalog = reconcileCatalog;
