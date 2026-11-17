'use strict';

/** Scope-specific inventory for the existing checkpoint migration owner; never infer historical grants. */
const fs = require('fs'), path = require('path');
const { encode, sha256 } = require('../../src/pcm-core/src/migration-checkpoint');
const { readServiceGrant } = require('../../src/shared/service-grant');
const { readApprovalSnapshot } = require('../../src/shared/consent-scope-snapshot');
const { VERSIONS, assertScopeVersions } = require('../../src/shared/scope-model-versions');
const { REQUIRED_AUTHORIZATION_CONTROLS, POLICY_VERSION } = require('../../src/shared/conformance-policy');
const { CONFIG_VERSION, assertValidTeamConfig } = require('../../src/shared/team-config-validator');

/** Bind all regular files and directory membership, including opaque hashed usage keys. */
function inventoryDirectory(directory, capture, errors) {
    if (!fs.existsSync(directory)) return [];
    if (fs.lstatSync(directory).isSymbolicLink()) { errors.push(`Unsafe state directory ${directory}`); return []; }
    return fs.readdirSync(directory).sort().map(name => {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) { errors.push(`Unresolved state entry ${file}`); return { name, unusable: true }; }
        const bytes = capture(file);
        let record; try { record = JSON.parse(bytes); } catch { /* Opaque or corrupt bytes remain inventoried and invalidated/preserved. */ }
        return { name, sha256: sha256(bytes), record };
    });
}

/** Return exact before/after projections and explicit consequences without changing resource bytes. */
function scopePlan({ current, config, resources, review, stateDirectory, configPath, capture, errors, attempt }) {
    for (const file of [configPath, stateDirectory]) if (fs.lstatSync(file).isSymbolicLink()) errors.push(`Scope migration refuses symlinked config/state ${file}`);
    if (review.schema !== 'pcm-scope-migration-review/1' || review.restartAll !== true) errors.push('Explicit scope review/1 and restartAll attestation required');
    if (Object.keys(review).some(key => !['schema', 'runtime', 'restartAll', 'versions', 'beforeVersions', 'artifacts', 'retiredControls', 'records', 'asOf'].includes(key))) errors.push('Unknown scope review field; no inferred approval or implicit mappings are accepted');
    const asOf = Date.parse(review.asOf);
    if (!Number.isFinite(asOf) || new Date(asOf).toISOString() !== review.asOf) errors.push('Explicit canonical asOf review timestamp required for eligibility projection');
    attempt(() => assertScopeVersions(review.versions));
    if (review.beforeVersions !== undefined) {
        attempt(() => assertScopeVersions(review.beforeVersions));
        if (current.configVersion !== VERSIONS.config || current.conformance?.policyVersion !== VERSIONS.policy) errors.push('Compatible beforeVersions cannot be asserted over a legacy configuration boundary');
    }
    if (Object.keys(review.artifacts || {}).sort().join(',') !== 'adapter,doctor,hapi,pcm') errors.push('Exactly four component artifact attestations are required');
    for (const component of ['pcm', 'doctor', 'adapter', 'hapi']) {
        if (!/^sha256:[a-f0-9]{64}$/.test(review.artifacts?.[component] || '')) errors.push(`Immutable ${component} artifact required`);
    }
    if (review.artifacts?.pcm !== review.runtime?.after) errors.push('PCM artifact must equal the checkpoint target runtime');
    if (!['pcm-team-config/4', CONFIG_VERSION].includes(config.configVersion)) errors.push('Only explicitly reviewed config4/config5 scope cutover is supported; reconcile older contracts first');
    const controls = [];
    const strip = (value, prefix) => {
        for (const key of REQUIRED_AUTHORIZATION_CONTROLS) if (Object.hasOwn(value || {}, key)) {
            if (typeof value[key] !== 'boolean') errors.push(`Invalid historical control ${prefix}/${key}`);
            controls.push({ path: `${prefix}/${key}`, before: value[key], after: 'required true; no longer configurable' }); delete value[key];
        }
    };
    strip(config.securitySimulation?.global, '/securitySimulation/global');
    for (const [source, value] of Object.entries(config.securitySimulation?.perSource || {})) strip(value, `/securitySimulation/perSource/${source}`);
    if (Object.hasOwn(config.sandbox || {}, 'grantFullClinicalAccess')) {
        controls.push({ path: '/sandbox/grantFullClinicalAccess', before: config.sandbox.grantFullClinicalAccess, after: 'removed; new explicit approval required for broad access' });
        delete config.sandbox.grantFullClinicalAccess;
    }
    config.configVersion = CONFIG_VERSION; config.conformance.policyVersion = POLICY_VERSION;
    if (config.security?.dsFhirServer && config.security.dsFhirServer.enforceMappedPatients !== true) {
        controls.push({ path: '/security/dsFhirServer/enforceMappedPatients', before: config.security.dsFhirServer.enforceMappedPatients, after: true });
        config.security.dsFhirServer.enforceMappedPatients = true;
    }
    if (review.beforeVersions !== undefined && controls.length) errors.push('Compatible rollback attestation cannot preserve retired controls; omit beforeVersions and use forward-only cutover');
    if (JSON.stringify(review.retiredControls) !== JSON.stringify(controls)) errors.push('Exact retiredControls review required; copy the ordered preview inventory and review authority consequences');
    attempt(() => assertValidTeamConfig(config, { env: {} }));
    const inventory = [];
    // A current checkpoint already owns its private authority. Legacy readers below
    // are confined to this explicit migration preview, never a runtime fallback.
    let owner;
    if (resources._private) attempt(() => {
        owner = new (require('../../src/pcm-core/src/fhir/store').FHIRStore)();
        require('../../src/pcm-core/src/migration-checkpoint').hydrate(owner, resources);
    });
    const add = (kind, id, before, classification, consequence, after = before) => inventory.push({ key: `${kind}/${id}`, classification, before, after, consequence });
    for (const service of resources.HealthcareService) {
        let grant; try { grant = owner ? owner.privateRecords.services.getDefinition(service.id).grant : readServiceGrant(service); } catch (error) { errors.push(`${service.id}: ${error.message}`); }
        add('HealthcareService', service.id, service, grant && Object.entries(grant.diagnostics).every(([axis, value]) => axis === 'issues' || ['valid', 'supported'].includes(value)) ? 'lossless' : 'unusable', grant
            ? 'Exact saved definition preserved; no regeneration or new approval.'
            : 'Legacy inputs are not an exact final grant. Retain for historical linkage; create a new definition for future service-default approvals.');
    }
    for (const consent of resources.Consent) {
        let snapshot; try { snapshot = owner ? owner.privateRecords.approvals.getDecision(consent.id).snapshot : readApprovalSnapshot(consent); } catch (error) { errors.push(`${consent.id}: ${error.message}`); }
        add('Consent', consent.id, consent, snapshot ? snapshot.usable ? 'lossless' : 'unusable' : 'renewed-approval', snapshot
            ? 'Exact decision and validity preserved; present lifecycle/source/usage checks still apply.'
            : 'No exact historical grant can be inferred. Existing record remains unchanged and cannot authorize clinical access; request and approve a new Consent explicitly.');
    }
    const stateInventories = {};
    for (const namespace of ['access-tokens', 'first-use-windows', 'assertion-replay', 'oauth-authorization', 'source-presence']) {
        const entries = inventoryDirectory(path.join(stateDirectory, namespace), capture, errors);
        stateInventories[namespace] = entries.map(item => item.name);
        for (const item of entries) add(namespace, item.name, item, ['first-use-windows', 'assertion-replay'].includes(namespace) ? 'lossless' : 'unusable', namespace === 'first-use-windows'
            ? 'Preserve original bytes and deadline. Hashed keys cannot establish client ownership; legacy Consent/source records continue denying tuple access. Never rename/delete/reset usage.'
            : namespace === 'assertion-replay' ? 'Preserve replay consumption unchanged.' : 'Invalidate on explicit apply/restart; do not infer Consent-wide approval from an issued token sample.',
        ['first-use-windows', 'assertion-replay'].includes(namespace) ? item : null);
    }
    if (config.serviceCatalog) attempt(() => {
        const relative = config.serviceCatalog.file;
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Scope migration requires a team-local catalog');
        const file = path.resolve(path.dirname(configPath), relative);
        if (fs.lstatSync(file).isSymbolicLink() || !fs.realpathSync(file).startsWith(fs.realpathSync(path.dirname(configPath)) + path.sep)) throw new Error('Scope migration refuses escaping catalogs');
        const catalog = JSON.parse(capture(file));
        // A retained catalog is evidence, never a template for rewriting decided resources.
        for (const definition of catalog.clinicalServices || []) {
            const grant = definition.serviceGrant ? readServiceGrant({ extension: [{ url: require('../../src/shared/service-grant').URL, valueString: JSON.stringify(definition.serviceGrant) }] }) : null;
            add('catalog', definition.key, definition, grant ? 'lossless' : 'unusable', 'Definition retained without reload conversion. New packaged definitions require explicit installation and new approvals.');
        }
    });
    const templatePath = path.resolve(__dirname, '../../config/service-templates.json');
    const templates = JSON.parse(capture(templatePath));
    for (const template of templates.templates) add('template', template.key, template, 'lossless', 'Authoring recipe only; creates a new definition at an explicit creation event, never migrates retained approval.');
    for (const item of inventory.filter(value => value.key.startsWith('Consent/'))) {
        const consent = item.before, period = consent.provision?.period;
        item.eligibility = { evaluatedAt: review.asOf, before: 'Historical runtime decision not reconstructed',
            after: item.classification !== 'lossless' ? 'unusable: new explicit Consent approval required'
                : consent.status !== 'active' ? 'inactive: terminal/non-active state preserved'
                    : Date.parse(period?.start) > asOf || Date.parse(period?.end) <= asOf ? 'inactive: outside unchanged approval validity'
                        : 'exact snapshot retained; current source/service/client/usage eligibility must still pass; migration creates no token' };
    }
    const requiredReview = inventory.map(item => ({ key: item.key, sha256: sha256(encode(item.before)), classification: item.classification }));
    if (JSON.stringify(review.records) !== JSON.stringify(requiredReview)) errors.push('Exact records review required; acknowledge every classification/hash without supplying inferred grants');
    const preservedStateFiles = Object.fromEntries(inventory.filter(item => ['first-use-windows', 'assertion-replay'].includes(item.key.split('/')[0])).map(item => [path.join(stateDirectory, item.key), item.before.sha256]));
    return { preservedStateFiles, inventory, retiredControls: controls, requiredReview, stateInventories,
        scopeBoundary: { versions: VERSIONS, artifacts: review.artifacts, beforeVersions: review.beforeVersions || null },
        preservedStateHash: sha256(encode(Object.fromEntries(inventory.filter(item => ['first-use-windows', 'assertion-replay'].includes(item.key.split('/')[0])).map(item => [item.key, item.before])))) };
}
module.exports = { scopePlan, inventoryDirectory };
