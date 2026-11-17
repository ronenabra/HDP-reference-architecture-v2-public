'use strict';

/** Portable, closed metadata catalog. Credentials and clinical data remain team-owned. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEFAULT_ROOT = fs.existsSync('/workspace/config/demo-services.schema.json') ? '/workspace' : path.resolve(__dirname, '../..');

/** Read a selected repository/team-relative catalog; reject traversal and escaping symlinks. */
function loadServiceCatalog(config, { teamDirectory = process.env.TEAM_CONFIG_PATH ? path.dirname(process.env.TEAM_CONFIG_PATH) : DEFAULT_ROOT, repositoryRoot = DEFAULT_ROOT, validateClinicalDefinitions = true } = {}) {
    if (!config.serviceCatalog) return null;
    const file = config.serviceCatalog.file;
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new TypeError('serviceCatalog.file must be a safe relative path');
    let selected;
    for (const root of [teamDirectory, repositoryRoot]) {
        const candidate = path.resolve(root, file);
        if (!fs.existsSync(candidate)) continue;
        const real = fs.realpathSync(candidate);
        if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new TypeError('Catalog symlink escapes its configured root');
        selected = real; break;
    }
    if (!selected) throw new TypeError(`Selected service catalog is missing: ${file}`);
    const catalog = JSON.parse(fs.readFileSync(selected, 'utf8'));
    const schemaPath = [path.join(repositoryRoot, 'config/demo-services.schema.json'), '/workspace/config/demo-services.schema.json'].find(file => fs.existsSync(file));
    if (!schemaPath) throw new TypeError('Service catalog schema is missing');
    const errors = require('./team-config-validator').structuralErrors(catalog, JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
    if (errors.length) throw new TypeError(`Invalid service catalog: ${errors.join('; ')}`);
    validateCatalogGraph(catalog, config, { validateClinicalDefinitions });
    return catalog;
}

/** Validate all cross-resource identities, mappings and application ownership before publication. */
function validateCatalogGraph(catalog, config, { validateClinicalDefinitions = true } = {}) {
    const { BUCKET_RESOURCES } = require('./clinical-resource-mapping');
    const unique = (values, label) => { if (new Set(values).size !== values.length) throw new TypeError(`Duplicate catalog ${label}`); };
    unique(catalog.clinicalServices.map(item => item.key), 'key');
    unique(catalog.clinicalServices.map(item => item.key === 'lab-follow-up' ? config.service.catalogIdentifier || item.canonicalIdentifier : item.canonicalIdentifier), 'canonical identifier');
    unique(catalog.systemPolicies.map(item => item.scenario), 'scenario');
    unique(catalog.systemPolicies.map(item => item.serviceIdentifier).filter(Boolean), 'legacy system service identifier');
    unique(catalog.systemPolicies.map(item => item.policyIdentifier), 'policy identifier');
    unique([...catalog.clinicalServices.map(item => item.key === 'lab-follow-up' ? config.service.catalogId || 'service-catalog-1' : `demo-catalog-${item.key}`), ...catalog.systemPolicies.flatMap(item => [item.serviceId, item.policyId].filter(Boolean)), ...config.serviceCatalog.bindings.map(item => item.instanceId)], 'resource ID');
    if (config.sandboxSampling && !catalog.sandboxSampling) throw new TypeError('Selected catalog lacks the entitled local sampler definition');
    if (catalog.sandboxSampling) {
        unique([...catalog.systemPolicies.flatMap(item => [item.serviceId, item.policyId].filter(Boolean)), ...catalog.clinicalServices.map(item => `demo-catalog-${item.key}`), ...config.serviceCatalog.bindings.map(item => item.instanceId), catalog.sandboxSampling.serviceId, catalog.sandboxSampling.policyId], 'local policy resource ID');
    }
    unique(config.serviceCatalog.bindings.map(item => item.instanceIdentifier), 'instance identifier');
    for (const item of catalog.clinicalServices) {
        unique(item.buckets.map(bucket => bucket.code), 'bucket');
        for (const bucket of item.buckets) {
            if (!BUCKET_RESOURCES[bucket.code]) throw new TypeError(`Unmapped catalog bucket ${bucket.code}`);
            for (const coding of bucket.taggedDetails || []) require('./information-buckets').assertSensitivityCoding(coding);
        }
        if (validateClinicalDefinitions && item.serviceGrant) {
            const grant = require('./service-grant').readServiceGrant({ extension: [{ url: require('./service-grant').URL, valueString: JSON.stringify(item.serviceGrant) }] });
            const expectedBuckets = item.buckets.map(bucket => ({ code: bucket.code, history: bucket.historyYears, historyUnit: 'a',
                sensitivity: (bucket.taggedDetails || []).map(coding => `${coding.system}|${coding.code}`) }));
            if (grant.authoring.accessMode !== item.accessMode || grant.authoring.duration !== item.durationMonths || grant.authoring.durationUnit !== 'mo'
                || grant.authoring.allowChanges !== item.allowPatientBucketChange || JSON.stringify(grant.authoring.buckets) !== JSON.stringify(expectedBuckets)) throw new TypeError('Catalog grant authoring differs from definition; create an explicit new definition');
        }
        // Public sampler clients ignore PCM-owned clinical grant/approval definitions.
        const options = validateClinicalDefinitions ? item.approvalScopeOptions || [] : [];
        unique(options.map(option => option.id), 'approval option ID');
        const types = ['Patient', ...new Set(item.buckets.flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.code])))];
        for (const option of options) {
            if (['custom', 'auto-resources', 'auto-buckets'].includes(option.id)) throw new TypeError('Reserved approval option ID');
            if (require('./ui/approval-scopes').scopeWarnings(option.scope, types).length) throw new TypeError(`Invalid authored approval scope: ${option.id}`);
            for (const token of option.scope.split(' ')) {
                const type = token.match(/^patient\/([A-Za-z]+)/)[1];
                for (const match of token.matchAll(/[?&]_security=([^&]+)/g)) {
                    const prefix = require('./pcm-contract').CODE_SYSTEMS.informationBucket + '|';
                    for (const coding of match[1].split(',')) if (coding.startsWith(prefix)) {
                        const bucket = coding.slice(prefix.length);
                        if (type === 'Patient' || !item.buckets.some(value => value.code === bucket) || !BUCKET_RESOURCES[bucket]?.[type]) throw new TypeError('Authored approval scope uses an unrelated bucket/resource');
                    }
                }
            }
        }
    }
    for (const binding of config.serviceCatalog.bindings) {
        if (!catalog.clinicalServices.some(item => item.key === binding.serviceKey)) throw new TypeError('Dangling service catalog binding');
        if (!['serviceProvider', 'hospitalBServiceProvider'].includes(binding.providerRole) || !config.organizations[binding.providerRole]?.id) throw new TypeError('Catalog binding requires a registered Service Provider');
    }
}

/** Derive all explicit supported clinical ceilings for one configured definition. */
function catalogScope(definition) {
    const { BUCKET_RESOURCES } = require('./clinical-resource-mapping');
    return ['Patient', ...new Set(definition.buckets.flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.code])))].map(type => `patient/${type}.rs`).join(' ');
}

/** Hash authored definitions independently of server-managed timestamps and operator state. */
function definitionHash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

module.exports = { catalogScope, definitionHash, loadServiceCatalog, validateCatalogGraph };
