'use strict';

/** Compile requested ceilings into complete immutable permission alternatives. */
const { CODE_SYSTEMS, EXTENSIONS } = require('../../shared/pcm-contract');
const { basedOnId } = require('./fhir/healthcare-service-lifecycle');
const { parseScopeCeiling, RequestError } = require('./rar-request');

// This local mapping is deliberately closed. Unknown buckets/resources require an
// explicit mapping before they can authorize data; example queries are not grants.
const { BUCKET_RESOURCES } = require('../../shared/clinical-resource-mapping');
const { readPolicy, confidentialityFilters } = require('../../shared/service-confidentiality-policy');
const { TYPES: MASTER_TYPES, masterEnabled, masterScopes } = require('../../shared/service-master-data');
const fail = message => { throw new RequestError('invalid_scope', message); };

/** Subtract a supported UCUM duration, retaining calendar semantics for months/years. */
function historyStart(now, duration) {
    if (duration?.system !== 'http://unitsofmeasure.org' || !Number.isFinite(duration.value) || duration.value < 0) fail('Invalid bucket history duration');
    const date = new Date(now * 1000);
    if (['a', 'mo'].includes(duration.code)) {
        if (!Number.isSafeInteger(duration.value)) fail('Calendar history duration must be integral');
        const day = date.getUTCDate();
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() - duration.value * (duration.code === 'a' ? 12 : 1));
        const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
        date.setUTCDate(Math.min(day, lastDay));
    } else {
        const seconds = { wk: 604800, d: 86400, h: 3600, min: 60, s: 1 }[duration.code];
        if (!seconds) fail('Unsupported history duration unit');
        date.setTime(date.getTime() - duration.value * seconds * 1000);
    }
    if (!Number.isFinite(date.getTime())) fail('History duration is out of range');
    return date.toISOString();
}

/** Read canonical live definitions, never treating a stale instance copy as authority. */
function serviceBuckets(store, service) {
    const catalog = store.get('HealthcareService', basedOnId(service));
    if (!catalog) fail('Service catalog is missing');
    const extensions = (catalog.extension || []).filter(item => item.url === EXTENSIONS.informationBucket);
    if (!extensions.length) fail('Service has no mapped information buckets');
    let buckets;
    try { buckets = extensions.map(require('../../shared/information-buckets').parseInformationBucket); }
    catch (error) { fail(error.message); }
    if (new Set(buckets.map(bucket => bucket.coding.code)).size !== buckets.length) fail('Service bucket codes must be unique');
    if (buckets.some(bucket => !BUCKET_RESOURCES[bucket.coding.code])) fail('Unknown service bucket mapping');
    return buckets;
}

/** Keep each approved alternative's predicates while intersecting interaction ceilings. */
function approvedAlternatives(approved, ceiling) {
    if (typeof approved !== 'string' || !approved) fail('Patient approval scope is missing');
    const result = [];
    for (const value of approved.trim().split(/\s+/)) {
        const match = /^(patient|system)\/([A-Za-z]+)\.(r|s|rs)(?:\?(.+))?$/.exec(value);
        if (!match) fail('Uncompilable patient approval');
        if (match[1] !== 'patient' || match[2] !== ceiling.resource) continue;
        const interaction = [...'rs'].filter(letter => match[3].includes(letter) && ceiling.interaction.includes(letter)).join('');
        if (!interaction) continue;
        const filters = match[4] ? match[4].split('&') : [];
        if (filters.some(filter => !/^(?:status|category|code|_security(?::not)?|date|authoredon|effective|effective-time|whenhandedover|recorded-date)=[^\s&=]+$/.test(filter))) fail('Unsupported approval predicate');
        result.push({ interaction, filters });
    }
    return result;
}

/** Compile every alternative with the service bucket and resource-specific history limit. */
function compileConsentScope({ store, service, scope, approved, now, patient, reusable = false, config = {} }) {
    const { clinicalGrantDecision, CLINICAL_TYPES } = require('../../shared/sandbox-grant-policy');
    let decision;
    try {
        decision = reusable ? { fullAccess: false } : clinicalGrantDecision(config, store, service);
        const retained = require('../../shared/service-grant').canonicalServiceGrant(store, service);
        if (!reusable && retained && Object.entries(retained.diagnostics).some(([key, value]) => key !== 'issues' && !['valid', 'supported'].includes(value))) fail('Service scope is experimental or unsupported; inspect its saved diagnostics.');
    } catch (error) { fail(error.message); }
    const ceilings = parseScopeCeiling(scope);
    const buckets = decision.fullAccess ? [] : serviceBuckets(store, service);
    let policy, master;
    try {
        if (store.privateRecords) { const definition = require('./public-fhir').requireDefinition(store, service); policy = definition.confidentialityPolicy; master = definition.includeMasterData; }
        else { const canonical = store.get('HealthcareService', basedOnId(service)); policy = readPolicy(canonical); master = masterEnabled(canonical); }
    } catch (error) { fail(error.message); }
    const output = [];
    for (const ceiling of ceilings) {
        if (ceiling.context !== 'patient') fail('Consent requires patient resource ceilings');
        if (MASTER_TYPES.includes(ceiling.resource)) {
            if (!master || ceiling.interaction !== 'r') fail('Master data requires enabled exact read-only authority');
            if (approved.trim().split(/\s+/).some(value => value.startsWith(`patient/${ceiling.resource}.s`) || value.startsWith(`patient/${ceiling.resource}.rs`))) fail('Master approval must be read only');
            const alternatives = approvedAlternatives(approved, ceiling);
            if (!alternatives.length) fail('Master data has no complete approved mapping');
            for (const alternative of alternatives) {
                const filters = [...new Set([...alternative.filters, ...confidentialityFilters(policy || { allowRestricted: false })])];
                output.push(`patient/${ceiling.resource}.r?${filters.join('&')}`);
            }
            continue;
        }
        if (decision.fullAccess) {
            if (!CLINICAL_TYPES.includes(ceiling.resource)) fail('Unsupported full clinical access ceiling');
            output.push(`patient/${ceiling.resource}.${ceiling.interaction}`);
            continue;
        }
        if (ceiling.resource === 'Patient') {
            if (!reusable && !patient) fail('Patient context is missing');
            // Legacy approvals retain their established identifier-only branch. New
            // policy-bearing services also retain every approved Patient predicate.
            const alternatives = policy ? approvedAlternatives(approved, ceiling) : [{ interaction: ceiling.interaction, filters: [] }];
            if (!alternatives.length) fail('Requested Patient has no complete approved mapping');
            for (const alternative of alternatives) {
                const predicates = [...new Set([...(reusable ? [] : [`identifier=${patient.system}|${patient.value}`]), ...alternative.filters,
                    ...confidentialityFilters(policy, { patient: true })])];
                output.push(`patient/Patient.${alternative.interaction}?${predicates.join('&')}`);
            }
            continue;
        }
        const alternatives = approvedAlternatives(approved, ceiling);
        const mapped = buckets.filter(bucket => BUCKET_RESOURCES[bucket.coding.code][ceiling.resource]);
        if (!alternatives.length || !mapped.length) fail('Requested resource has no complete approved mapping');
        for (const bucket of mapped) {
            const dateParameter = BUCKET_RESOURCES[bucket.coding.code][ceiling.resource];
            const required = [`_security=${bucket.coding.system}|${bucket.coding.code}`, `${dateParameter}=ge${historyStart(now, bucket.history)}`];
            // The pinned DS guide defines category OR within one _security value.
            // Ordinary records and explicitly tagged records remain separate complete
            // alternatives. Mixed-label policy is upstream-open; unknown-label denial
            // on the ordinary branch is an explicit PCM-IG-041-06 enforcement handoff.
            const labels = require('../../shared/information-buckets').SENSITIVITY_LABELS;
            const sensitivityAlternatives = [
                labels.map(label => `_security:not=${label.system}|${label.code}`),
                ...(bucket.taggedDetails.length ? [[`_security=${bucket.taggedDetails.map(label => `${label.system}|${label.code}`).join(',')}`]] : [])
            ];
            for (const alternative of alternatives) for (const sensitivity of sensitivityAlternatives) {
                const predicates = [...new Set([...alternative.filters, ...required, ...sensitivity,
                    ...confidentialityFilters(policy)])];
                output.push(`patient/${ceiling.resource}.${alternative.interaction}?${predicates.join('&')}`);
            }
        }
    }
    return [...new Set(output)].join(' ');
}


/** Build normal approval defaults from the live selected service, with Patient identity context. */
function defaultServiceScope(store, service, config = {}) {
    if (require('../../shared/sandbox-grant-policy').clinicalGrantDecision(config, store, service).fullAccess) return [require('../../shared/sandbox-grant-policy').fullClinicalScope(), ...(store.privateRecords ? (require('./public-fhir').requireDefinition(store, service).includeMasterData ? MASTER_TYPES.map(type => `patient/${type}.r`) : []) : masterScopes(store.get('HealthcareService', basedOnId(service))))].join(' ');
    const types = [...new Set(serviceBuckets(store, service).flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.coding.code])))];
    return [...['Patient', ...types].map(type => `patient/${type}.rs`), ...(store.privateRecords ? (require('./public-fhir').requireDefinition(store, service).includeMasterData ? MASTER_TYPES.map(type => `patient/${type}.r`) : []) : masterScopes(store.get('HealthcareService', basedOnId(service))))].join(' ');
}

module.exports = { BUCKET_RESOURCES, defaultServiceScope, approvedAlternatives, compileConsentScope, historyStart, serviceBuckets };
