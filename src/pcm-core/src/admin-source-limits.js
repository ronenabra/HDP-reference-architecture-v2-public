'use strict';

/** Bounded Admin projection and edits of the existing canonical budget configuration. */
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, CONFIG_MINIMA: PRESENCE_MINIMA, MAXIMA, presenceLimits, sourceId } = require('../../shared/presence-limits');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');
const { getConfiguredDataSources } = require('./data-sources');
const { CONFIG_MINIMA } = require('../../shared/clinical-import-limits');
const QUERY_FIELDS = require('../../shared/clinical-query-limits').FIELDS;
const { clinicalQueryLimits } = require('../../shared/clinical-query-limits');
const FIELDS = Object.freeze([
    ['maxPatients', 'Patients per presence batch', 'patients', 1],
    ['maxPayloadBytes', 'Batch payload', 'MB', 1000000],
    ['timeoutMilliseconds', 'Presence timeout', 'seconds', 1000],
    ['maxRarBytes', 'Authorization details', 'MB', 1000000],
    ['maxFormBytes', 'Decoded OAuth form', 'MB', 1000000],
    ['maxEncodedFormBytes', 'Encoded OAuth form', 'MB', 1000000],
    ['maxResponseBytes', 'OAuth response', 'MB', 1000000]
].map(([key, label, unit, scale]) => Object.freeze({ key, label, unit, scale,
    minimum: PRESENCE_MINIMA[key], maximum: MAXIMA[key] })));
const UPLOAD_FIELDS = Object.freeze([
    { key: 'maxBytes', label: 'Upload size', unit: 'MB', scale: 1000000, minimum: CONFIG_MINIMA.maxBytes, maximum: Number.MAX_SAFE_INTEGER },
    { key: 'maxEntries', label: 'Entries per upload', unit: 'entries', scale: 1, minimum: CONFIG_MINIMA.maxEntries, maximum: Number.MAX_SAFE_INTEGER }
]);

/** Render an exact scaled decimal without rounding.
 * @param {number} raw Validated nonnegative raw integer.
 * @param {number} scale Decimal unit divisor.
 * @returns {string} Exact human-editable decimal.
 */
function displayValue(raw, scale = 1) {
    const digits = String(scale).length - 1, value = BigInt(raw);
    return `${value / BigInt(scale)}${digits ? `.${String(value % BigInt(scale)).padStart(digits, '0')}`.replace(/0+$/, '').replace(/\.$/, '') : ''}`;
}

/** Convert a unit-labelled decimal exactly.
 * @param {string} value Submitted decimal in the displayed unit.
 * @param {object} field Canonical bounds, key and unit scale.
 * @returns {number} Validated safe raw integer; invalid precision throws.
 */
function parseValue(value, field) {
    const invalid = message => Object.assign(new TypeError(message), { field: field.key });
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 30) throw invalid(`${field.label}: enter a finite decimal in ${field.unit}.`);
    const [whole, fraction = ''] = value.split('.'), digits = String(field.scale).length - 1;
    if (fraction.slice(digits).replace(/0/g, '')) throw invalid(`${field.label}: use exact whole ${field.scale === 1000 ? 'milliseconds' : field.scale === 1000000 ? 'bytes' : field.unit}.`);
    const raw = BigInt(whole) * BigInt(field.scale) + BigInt((fraction.slice(0, digits).padEnd(digits, '0')) || '0');
    if (raw < BigInt(field.minimum) || raw > BigInt(field.maximum)) throw invalid(`${field.label}: enter ${displayValue(field.minimum, field.scale)}–${displayValue(field.maximum, field.scale)} ${field.unit}.`);
    return Number(raw);
}

/** Resolve exact registered UI identity to its private budget identity.
 * @param {object} config Validated current team configuration.
 * @param {string} id Exact registered Organization ID.
 * @returns {object} Registered source and stable budget ID; missing sources throw404.
 */
function registeredSource(config, id) {
    const source = getConfiguredDataSources(config, { includeDisabled: true }).find(item => item.id === id);
    if (!source) throw Object.assign(new Error('Registered data source not found; refresh Sources.'), { statusCode: 404 });
    const budgetId = sourceId(config, { id: source.healthOrganizationId || source.id });
    if (!budgetId) throw new TypeError('Registered source has no budget identity.');
    return { source, budgetId };
}

/** Refuse edits during active/uncertain work, preserving captured target identities.
 * @param {DataOperationRegistry} registry Existing target reservation owner.
 * @param {string} serverId Exact managed target.
 * @returns {void} Throws409 while any active, uncertain or initializing owner remains.
 */
function assertUploadIdle(registry, serverId) {
    const operation = registry.list(serverId).find(item => !['succeeded', 'failed'].includes(item.phase) || item.needsReconciliation);
    if (operation) throw Object.assign(new Error(`Upload limits are blocked by operation ${operation.id}. Finish or reconcile its captured contract before editing; do not retry the import.`), { statusCode: 409, activeOperationId: operation.id });
    for (const file of [registry.lockFile(serverId), registry.reconciliationFile(serverId), path.join(registry.directory, `mutation-${serverId}`)]) {
        if (fs.existsSync(file)) throw Object.assign(new Error('Upload limits are blocked by a target reservation. Review stopped-worker recovery before editing.'), { statusCode: 409 });
    }
}

/** Change only this form's owned budgets using the shared full config validator.
 * @param {object} config Validated current configuration.
 * @param {object} body Unit-labelled scalar form values and expected revision.
 * @param {object} options Optional source/managed target and reservation registry.
 * @returns {object} Independent validated candidate; input config remains untouched.
 */
function editLimits(config, body, { id, serverId, registry, clinical = false } = {}) {
    if (String(body?.expectedRevision) !== String(config.runtime.revision || 0)) throw Object.assign(new Error('Limits changed. Refresh the saved limits and review your draft before saving.'), { statusCode: 409 });
    const next = structuredClone(config);
    const fields = clinical ? QUERY_FIELDS : serverId ? UPLOAD_FIELDS : FIELDS;
    if (clinical && id && !next.healthOrganizations.some(ho => ho.id === registeredSource(next, id).source.healthOrganizationId)) throw new TypeError('Clinical query controls apply only to managed HAPI sources.');
    const block = clinical ? (next.clinicalQuery ||= {}) : next.presence;
    const allowed = new Set(['adminForm', 'expectedRevision', ...fields.flatMap(field => [field.key, ...(id ? [`mode.${field.key}`] : [])])]);
    if (Object.keys(body).some(key => !allowed.has(key))) throw new TypeError('Only this limits form’s fields may be saved.');
    let target;
    if (serverId) {
        const ho = next.healthOrganizations.find(item => item.clinicalData.serverId === serverId);
        if (!ho) throw Object.assign(new Error('Managed source not found.'), { statusCode: 404 });
        assertUploadIdle(registry, serverId); target = ho.clinicalData.limits;
    } else if (id) {
        const { budgetId } = registeredSource(next, id);
        block.sources ||= {};
        // Registered FHIR IDs may equal Object prototype names; create an own row.
        if (!Object.hasOwn(block.sources, budgetId)) Object.defineProperty(block.sources, budgetId, { value: {}, enumerable: true, writable: true, configurable: true });
        target = block.sources[budgetId];
    } else target = clinical ? (block.defaults ||= {}) : block.batch;
    for (const field of fields) {
        const mode = body[`mode.${field.key}`];
        if (id && mode === 'inherit') delete target[field.key];
        else {
            if (id && mode !== 'custom') throw new TypeError(`${field.label}: choose Inherit or Custom.`);
            target[field.key] = parseValue(body[field.key], field);
        }
    }
    if (id && !Object.keys(target).length) delete block.sources[registeredSource(next, id).budgetId];
    assertValidTeamConfig(next, { env: process.env });
    return next;
}

/** Project saved values/origins separately from drafts and adoption observations.
 * @param {object} config Validated current configuration.
 * @param {object} source Optional exact registered source for overrides.
 * @returns {object[]} Unit-labelled saved values, bounds and origin per field.
 */
function limitRows(config, source) {
    const id = source ? registeredSource(config, source.id).budgetId : null;
    const effective = presenceLimits(config, id ? { id } : {});
    return FIELDS.map(field => ({ ...field, raw: effective[field.key], value: displayValue(effective[field.key], field.scale),
        defaultValue: displayValue(config.presence.batch[field.key] ?? DEFAULTS[field.key], field.scale),
        custom: id ? Object.hasOwn(config.presence.sources?.[id] || {}, field.key) : false,
        origin: id && Object.hasOwn(config.presence.sources?.[id] || {}, field.key) ? `Source override (${id})` : Object.hasOwn(config.presence.batch, field.key) ? 'Shared default' : 'Built-in default' }));
}
/** Project exact clinical units and origins independently of presence/import forms. */
function queryRows(config, source) {
    const id = source ? registeredSource(config, source.id).budgetId : null;
    const effective = clinicalQueryLimits(config, id ? { id } : {});
    const shared = clinicalQueryLimits(config);
    return QUERY_FIELDS.map(field => ({ ...field, raw: effective[field.key], value: String(effective[field.key]),
        defaultValue: String(shared[field.key]), custom: id ? Object.hasOwn(config.clinicalQuery?.sources?.[id] || {}, field.key) : false,
        origin: id && Object.hasOwn(config.clinicalQuery?.sources?.[id] || {}, field.key) ? `Source override (${id})`
            : Object.hasOwn(config.clinicalQuery?.defaults || {}, field.key) ? 'Shared default' : 'Built-in default' }));
}
module.exports = { QUERY_FIELDS, queryRows, FIELDS, UPLOAD_FIELDS, displayValue, parseValue, registeredSource, assertUploadIdle, editLimits, limitRows };
