'use strict';

/** Finite local presence/OAuth budgets, shared by issuance and source consumers. */
const DEFAULTS = Object.freeze({ maxPatients: 100, maxPayloadBytes: 65536, timeoutMilliseconds: 30000,
    maxRarBytes: 32768, maxFormBytes: 65536, maxEncodedFormBytes: 196608, maxResponseBytes: 262144 });
/** Canonical configuration minima; payload requires the reviewed 1KiB transport floor. */
const CONFIG_MINIMA = Object.freeze({ maxPatients: 2, maxPayloadBytes: 1024, timeoutMilliseconds: 1, maxRarBytes: 1, maxFormBytes: 1, maxEncodedFormBytes: 1, maxResponseBytes: 1 });
const MAXIMA = Object.freeze({ maxPatients: 10000, maxPayloadBytes: 16777216, timeoutMilliseconds: 300000,
    maxRarBytes: 16777216, maxFormBytes: 16777216, maxEncodedFormBytes: 50331648, maxResponseBytes: 16777216 });

/** Resolve one source by its stable ID, current logical resource, organization or client. */
function sourceId(config, selector = {}) {
    if (!Object.values(selector).some(value => value !== undefined && value !== null)) return null;
    const matches = (source, organizationId) => (selector.id && [source.id, organizationId].includes(selector.id))
        || (selector.resource && source.endpoint === selector.resource)
        || (selector.organizationId && organizationId === selector.organizationId)
        || (selector.clientId && source.clientId === selector.clientId);
    const managed = (config.healthOrganizations || []).find(source => matches(source, source.dataSourceOrganization?.id));
    if (managed) return managed.id;
    const custom = (config.organizations?.dataSources || []).find(source => matches(source, source.id));
    if (custom) return custom.id;
    const legacy = { id: 'legacy', endpoint: config.legacyDataSource?.internalFhirBaseUrl,
        clientId: config.organizations?.referenceDataSource?.clientId };
    return selector.id === 'legacy-ds' || matches(legacy, config.organizations?.referenceDataSource?.id) ? 'legacy' : null;
}

/** Overlay global defaults with one source; malformed budgets fail closed. */
function presenceLimits(config = {}, selector = {}) {
    const registered = new Set([...(config.healthOrganizations || []).map(source => source.id), ...(config.organizations?.dataSources || []).map(source => source.id), 'legacy']);
    for (const id of Object.keys(config.presence?.sources || {})) {
        if (!registered.has(id)) throw new TypeError(`Unknown presence source ${id}`);
    }
    const limits = { ...DEFAULTS, ...config.presence?.batch, ...config.presence?.sources?.[sourceId(config, selector)] };
    for (const [key, maximum] of Object.entries(MAXIMA)) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] < (key === 'maxPatients' ? 2 : 1) || limits[key] > maximum) {
            throw new TypeError(`Invalid finite presence limit ${key}`);
        }
    }
    return limits;
}

/** Bound transport before a form reveals its target; source budgets are checked after decoding. */
function transportLimits(config = {}) {
    const values = [presenceLimits(config), ...Object.keys(config.presence?.sources || {}).map(id => presenceLimits(config, { id }))];
    return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, Math.max(...values.map(value => value[key]))]));
}

module.exports = { DEFAULTS, CONFIG_MINIMA, MAXIMA, presenceLimits, sourceId, transportLimits };
