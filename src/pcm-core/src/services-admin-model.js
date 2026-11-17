'use strict';
/** Protected Services projections and catalog creation over the existing store owners. */
const fs = require('node:fs');
const lifecycle = require('./fhir/healthcare-service-lifecycle');
const participant = require('./fhir/participant-lifecycle');
const command = require('./sandbox-service-command');
const { certPath } = require('./team-config');
const SCHEMA = 'pcm-admin-services/1';
const { BUILTIN_CATALOG_ID } = lifecycle;

/** Resolve one unambiguous credential binding.
 * @param {object} options Store, current configuration and registered providerId.
 * @returns {object} Nonsecret capability, exact configured role or an unavailable reason.
 */
function providerBinding({ store, config, providerId }) {
    const organization = store.get('Organization', providerId);
    if (participant.organizationRole(organization) !== 'service-provider') return { available: false, reason: 'Registered service provider not found.' };
    const matches = Object.entries(config.organizations).filter(([, value]) => value?.id === providerId);
    if (matches.length !== 1 || !matches[0][1].clientId) return { available: false, reason: 'No unambiguous configured provider credentials.' };
    const [role, configured] = matches[0];
    try {
        for (const purpose of ['assertion', 'mtls']) for (const field of ['cert', 'key']) fs.accessSync(certPath(config, role, field, purpose), fs.constants.R_OK);
    } catch { return { available: false, role, reason: 'This provider’s exact certificates or keys are unavailable.' }; }
    return { available: true, role, clientId: configured.clientId, reason: '' };
}

/** Project only nonsecret directory facts; configured roles are credential bindings, not inventory.
 * @param {object} options Store and current configuration.
 * @returns {object[]} Registered provider facts with separate operational/credential capability.
 */
function providers({ store, config }) {
    return store.getAll('Organization').filter(item => participant.organizationRole(item) === 'service-provider')
        .sort((a, b) => a.id.localeCompare(b.id)).map(item => {
            const binding = providerBinding({ store, config, providerId: item.id });
            return { id: item.id, name: item.name || '', version: item.meta.versionId, operational: participant.organizationIsOperational(store, item),
                registered: true, source: 'protected-persisted-fhir', standardCapabilityState: binding.available ? 'configured-not-observed' : 'unavailable', standardManagement: binding.available && participant.organizationIsOperational(store, item),
                credentialRole: binding.role || null, unavailableReason: !participant.organizationIsOperational(store, item) ? 'Provider or parent organization is not operational.' : binding.reason,
                defaults: store.privateRecords.services.getProviderDefaults(item.id) };
        });
}

/** Page a complete local snapshot; later pages must supply the unchanged private revision.
 * @param {object[]} values Entire ordered owner snapshot.
 * @param {object} query Closed offset/limit/revision query strings.
 * @param {number} revision Current private-store revision.
 * @returns {object} Bounded page with exact total and honest completeness.
 */
function page(values, query, revision) {
    const allowed = ['offset', 'limit', 'revision'];
    if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))) throw Object.assign(new Error('Use the inventory paging fields.'), { status: 400 });
    const offset = Number(query.offset || 0), limit = Number(query.limit || 25);
    if (!Number.isSafeInteger(offset) || limit < 1 || limit > 50 || (offset && query.revision === undefined)) throw Object.assign(new Error('A bounded page and its snapshot revision are required.'), { status: 400 });
    if (query.revision !== undefined && Number(query.revision) !== revision) throw Object.assign(new Error('Inventory changed. Refresh from the first page.'), { status: 409 });
    const items = values.slice(offset, offset + limit), nextOffset = offset + items.length < values.length ? offset + items.length : null;
    return { schema: SCHEMA, source: 'protected-owner-inventory', revision, total: values.length, offset, limit, complete: offset === 0 && nextOffset === null, nextOffset, items };
}

/** Project all catalog states without granting discovery visibility or clinical authority.
 * @param {object} options Store, current configuration and optional paging query.
 * @returns {object} Protected catalog page and version-bound creation capability.
 */
function catalogInventory({ store, config, query = {} }) {
    const all = store.getAll('HealthcareService'), records = all.filter(item => lifecycle.serviceKind(item) === 'catalog').sort((a, b) => a.id.localeCompare(b.id));
    return { ...page(records.map(service => ({ id: service.id, version: service.meta.versionId, name: service.name, state: lifecycle.businessStatus(service),
        resourceSource: 'protected-persisted-fhir', definitionSource: 'private-services', active: service.active === true, builtin: service.id === BUILTIN_CATALOG_ID, resource: service,
        definition: store.privateRecords.services.getDefinition(service.id), availability: command.usability(store, service),
        registrationCount: all.filter(item => lifecycle.basedOnId(item) === service.id).length,
        admin: { authority: 'Admin', validationAvailable: config.conformance.preset !== 'strict', ...command.serviceActions({ store, config, service }), csrf: command.csrf('', service.id, service.meta.versionId) } })), query, store.privateState.revision),
        creation: { authority: 'Admin', available: config.conformance.preset !== 'strict', csrf: command.csrf('', 'catalog-create', String(store.privateState.revision)) } };
}

/** Enumerate every provider pair in a named group, keeping terminal/multiple bindings distinct.
 * @param {object} options Store/configuration, optional catalogId and paging query.
 * @returns {object} Protected directory or exact catalog/provider pair page.
 */
function providerInventory({ store, config, catalogId, query = {} }) {
    let rows = providers({ store, config });
    if (catalogId) {
        const catalog = store.get('HealthcareService', catalogId);
        if (lifecycle.serviceKind(catalog) !== 'catalog') throw Object.assign(new Error('Catalog definition not found.'), { status: 404 });
        const knownIds = new Set(rows.map(row => row.id));
        const orphanOwners = [...new Set(store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === catalogId && !knownIds.has(lifecycle.ownerId(item))).map(lifecycle.ownerId))];
        for (const id of orphanOwners) rows.push({ id, name: 'Unavailable provider', registered: false, operational: false, standardManagement: false,
            source: 'unresolved-persisted-registration', credentialRole: null, unavailableReason: 'The registration owner is absent from the provider directory.' });
        rows.sort((a, b) => a.id.localeCompare(b.id));
        rows = rows.map(provider => {
            const registrations = store.getAll('HealthcareService').filter(item => lifecycle.basedOnId(item) === catalogId && lifecycle.ownerId(item) === provider.id);
            const connectionPresent = registrations.some(item => lifecycle.businessStatus(item) !== 'cancelled');
            return { ...provider, catalogId, connection: connectionPresent ? 'registered' : 'not-connected', registrationsComplete: true,
                connect: { authority: 'standard-provider-api', available: !connectionPresent && provider.standardManagement && catalog.active === true && lifecycle.businessStatus(catalog) === 'active',
                    reason: connectionPresent ? 'An existing registration must be managed in its own context.' : provider.unavailableReason || (catalog.active !== true ? 'Catalog is not active.' : ''), csrf: command.csrf(provider.credentialRole || '') },
                registrations: registrations.map(service => ({ id: service.id, version: service.meta.versionId, state: lifecycle.businessStatus(service), resource: service,
                    availability: command.usability(store, service),
                    standard: { authority: 'standard-provider-api', available: provider.standardManagement, csrf: command.csrf(provider.credentialRole || '', service.id, service.meta.versionId),
                        actions: provider.standardManagement ? ({ pending: ['cancelled'], active: ['suspended'], suspended: ['active', 'cancelled'] }[lifecycle.businessStatus(service)] || []) : [] },
                    admin: { authority: 'Admin', ...command.serviceActions({ store, config, service }), csrf: command.csrf('', service.id, service.meta.versionId) } })) };
        });
    }
    return { ...page(rows, query, store.privateState.revision), catalogId: catalogId || null };
}

/** Create only a pending catalog; definition, audit and generations share one transaction.
 * @param {object} options Store/configuration, closed definition, expectedRevision and operator/audit.
 * @returns {object} Newly committed pending catalog identity with zero registrations.
 */
function createCatalog({ store, config, definition, expectedRevision, operator, audit, now }) {
    if (config.conformance.preset === 'strict') throw Object.assign(new Error('Private sandbox actions are unavailable in strict mode.'), { status: 403 });
    if (!operator || typeof audit !== 'function') throw new Error('Authenticated operator and audit evidence are required.');
    return store.transaction(() => {
        store.privateRecords.check({ expectedRevision });
        const authored = require('./service-definition-form').serviceDefinitionCommand(definition, { now });
        const resource = lifecycle.createCatalogDefinition({ store, request: authored.resource, privateDefinition: authored.definition });
        const event = store.privateRecords.append('HealthcareService', resource.id, { visibility: 'diagnostic', component: 'pcm-services', operation: 'admin-catalog-create', operator, action: 'create', at: new Date().toISOString() });
        store.afterCommit(() => audit(event));
        return { schema: SCHEMA, id: resource.id, version: resource.meta.versionId, state: lifecycle.businessStatus(resource), registrationCount: 0, serviceGrant: authored.definition.grant, reference: `HealthcareService/${resource.id}`, reviewTarget: resource.id, message: 'Created pending definition — no providers connected. Approve the definition, then explicitly connect providers.' };
    });
}

/** Validate a displayed immutable definition without contacting a provider/source or changing state.
 * @param {object} options Store, exact catalog id and displayed expectedVersion.
 * @returns {object} Version-bound local validation result; never a permission grant.
 */
function validateCatalog({ store, id, expectedVersion }) {
    const resource = store.get('HealthcareService', id);
    if (lifecycle.serviceKind(resource) !== 'catalog') throw Object.assign(new Error('Catalog definition not found.'), { status: 404 });
    if (resource.meta.versionId !== expectedVersion) throw Object.assign(new Error('Catalog changed. Refresh and review.'), { status: 409 });
    command.assertDefinition(resource);
    require('./public-fhir').requireDefinition(store, resource);
    return { schema: SCHEMA, id, version: expectedVersion, definitionValid: true, state: lifecycle.businessStatus(resource), message: 'Definition validated; no registration, approval, token or clinical access was created.' };
}
module.exports = { SCHEMA, BUILTIN_CATALOG_ID, providerBinding, providers, page, catalogInventory, providerInventory, createCatalog, validateCatalog };
