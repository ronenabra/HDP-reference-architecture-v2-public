'use strict';

/** Lossless, versioned sandbox service grants and separate authoring diagnostics. */
const URL = 'urn:pcm:sandbox:service-grant';
const MODEL = 'pcm-service-grant/1';
const COMPILER = 'pcm-service-scope/1';
const { SYSTEM } = require('./service-confidentiality-policy');
const { TYPES: MASTER_TYPES } = require('./service-master-data');
const { BUCKET_RESOURCES } = require('./clinical-resource-mapping');
const PATIENT_TYPES = Object.freeze(['Patient', 'RelatedPerson', ...new Set(Object.values(BUCKET_RESOURCES).flatMap(value => Object.keys(value)))]);
const FULL_PATIENT_SCOPE = 'patient/*.rs';
const NATIVE_TYPES = new Set(['Patient', ...MASTER_TYPES,
    ...Object.values(BUCKET_RESOURCES).flatMap(value => Object.keys(value))]);
const TOKEN_PARAMETERS = Object.freeze({
    Observation: ['status', 'category', 'code'], DiagnosticReport: ['status', 'category', 'code'],
    MedicationRequest: ['status', 'category', 'code'], MedicationStatement: ['status', 'category', 'code'],
    MedicationAdministration: ['status', 'code'], MedicationDispense: ['status', 'code'],
    Procedure: ['status', 'category', 'code'], Condition: ['category', 'code'],
    AllergyIntolerance: ['category', 'code'], Encounter: ['status'], Immunization: ['status']
});

/** Parse text for display/diagnostics without normalizing the retained expression.
 * @param {string} text Exact final service grant, including whitespace.
 * @returns {object} Parsed alternatives, coarse ceiling and independent diagnostics.
 */
function inspectScope(text) {
    if (typeof text !== 'string' || !text.length || text.length > 16384) {
        throw Object.assign(new TypeError('Scopes require nonempty text, at most 16384 characters.'), { status: 400 });
    }
    // This exact literal is the qualified sandbox wildcard. Finite ordinary policy stays separate.
    if (text === FULL_PATIENT_SCOPE) return { clauses: [{ context: 'patient', type: '*', actions: 'rs', filters: [] }],
        requestCeiling: text, diagnostics: { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] } };
    const diagnostics = { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] };
    const issue = (axis, message) => {
        diagnostics[axis] = axis === 'capability' ? 'unsupported' : 'invalid';
        diagnostics.issues.push(message);
    };
    // Unsupported raw characters stay private and diagnostic, never executable authority.
    if (/[^\x20-\x7e\t\r\n]/.test(text)) issue('syntax', 'Current runtime scope syntax does not support non-ASCII or control characters; exact experimental text is retained.');
    // The current native parser requires single-space-separated exact wire text.
    // Keep valid SMART whitespace losslessly, but do not claim matcher support
    // until ENFORCE qualifies its parser without altering the retained grant.
    if (text !== text.trim() || /[\t\r\n]| {2}/.test(text)) issue('capability', 'Current native exact-scope parser requires one space between alternatives; other whitespace is retained experimentally.');
    const clauses = [], ceilings = new Map();
    for (const token of text.trim().split(/\s+/)) {
        const match = /^(patient|system)\/([A-Z][A-Za-z0-9]*|\*)\.([cruds]+)(?:\?(.+))?$/.exec(token);
        if (!match || new Set(match?.[3]).size !== match?.[3].length) {
            issue('syntax', `Malformed SMART resource scope: ${token}`); continue;
        }
        const [, context, type, actions, query] = match;
        const filters = query ? query.split('&') : [];
        clauses.push({ context, type, actions, filters });
        if (context !== 'patient' || type === '*' || /[cud]/.test(actions)) issue('applicability', 'Reusable clinical services require finite patient read/search grants; system, wildcard and write authority is unavailable.');
        if (MASTER_TYPES.includes(type) && actions !== 'r') issue('applicability', 'Master resources permit direct read only, never search.');
        if (!NATIVE_TYPES.has(type)) issue('capability', `${type} is not supported by the current native source.`);
        if (!filters.includes(`_security:not=${SYSTEM}|V`)) issue('applicability', `${type}: every alternative must explicitly exclude Very Restricted (V).`);
        ceilings.set(type, [...'rs'].filter(action => (ceilings.get(type) || '').includes(action) || actions.includes(action)).join(''));
        for (const filter of filters) {
            const predicate = /^([^=&\s]+)=([^=&\s]+)$/.exec(filter);
            if (!predicate || /%(?![A-Fa-f0-9]{2})/.test(filter)) { issue('syntax', `Malformed search predicate: ${filter}`); continue; }
            const [, name, value] = predicate;
            // Native admission rejects '$' even inside a syntactically valid URI.
            // Preserve that text and diagnose capability independently of syntax.
            if (value.includes('$')) issue('capability', `Current native filter admission rejects dollar ($) in predicate values: ${filter}`);
            if (['patient', 'subject'].includes(name) || name.startsWith('patient:') || name.startsWith('subject:') || type === 'Patient' && name === 'identifier') {
                issue('applicability', 'Patient identity belongs to verified runtime context, never the reusable service scope.');
            }
            if (name === '_security' || name === '_security:not') {
                if (!value.split(',').every(part => /^[A-Za-z][A-Za-z0-9+.-]*:[^|,]+\|[A-Za-z0-9.-]+$/.test(part))) issue('syntax', `Malformed security predicate: ${filter}`);
                if (name === '_security' && value.split(',').includes(`${SYSTEM}|V`)) issue('applicability', 'Very Restricted (V) cannot be included.');
            } else if (Object.values(BUCKET_RESOURCES).some(mapping => mapping[type] === name)) {
                const date = /^(?:ge|gt|le|lt|eq)(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?)$/.exec(value);
                if (!date || !Number.isFinite(Date.parse(date[1])) || date[1].startsWith('0000-') || new Date(date[1]).toISOString().slice(0, 10) !== date[1].slice(0, 10)) issue('syntax', `Invalid literal history date: ${filter}`);
            } else if (TOKEN_PARAMETERS[type]?.includes(name)) {
                if (!value.split(',').every(part => /^(?:[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9:/._+-]+\|)?[A-Za-z0-9:/._+-]+$/.test(part))) issue('syntax', `Malformed token predicate: ${filter}`);
            } else issue('capability', `Unsupported predicate for ${type}: ${filter}`);
            if (/%/.test(filter)) issue('capability', `Encoded predicate requires additional source qualification: ${filter}`);
        }
    }
    if (!clauses.some(clause => clause.context === 'patient' && clause.type === 'Patient' && clause.actions === 'rs')) issue('applicability', 'Patient read and search (patient/Patient.rs) are required.');
    return { clauses, requestCeiling: [...ceilings].map(([type, actions]) => `patient/${type}.${actions}`).join(' '), diagnostics };
}

/** Decode owned metadata without mutating legacy records or regenerating grant text.
 * @param {object} service Canonical definition or inherited presentation copy.
 * @returns {object|null} Versioned grant, or null for an untouched legacy definition.
 */
function readServiceGrant(service) {
    const values = (service?.extension || []).filter(item => item.url === URL);
    if (!values.length) return null;
    if (values.length !== 1 || Object.keys(values[0]).some(key => !['url', 'valueString'].includes(key)) || typeof values[0].valueString !== 'string') throw new TypeError('Invalid service grant extension.');
    let grant;
    try { grant = JSON.parse(values[0].valueString); } catch { throw new TypeError('Invalid service grant JSON.'); }
    if (!grant || Object.keys(grant).sort().join(',') !== 'anchor,authoring,compiler,diagnostics,historyMode,model,origin,scope'
        || grant.model !== MODEL || grant.compiler !== COMPILER || !['generated', 'custom'].includes(grant.origin)
        || grant.historyMode !== (grant.origin === 'custom' ? 'manual-literal' : 'creation-fixed') || typeof grant.anchor !== 'string' || !Number.isFinite(Date.parse(grant.anchor))
        || new Date(grant.anchor).toISOString() !== grant.anchor || !grant.authoring || Array.isArray(grant.authoring)
        || JSON.stringify(inspectScope(grant.scope).diagnostics) !== JSON.stringify(grant.diagnostics)) throw new TypeError('Invalid service grant version, provenance or diagnostics.');
    return grant;
}

/** Resolve authority from the live canonical, ignoring any registration copy.
 * @param {object} store Existing FHIR store.
 * @param {object} service Canonical or provider registration.
 * @returns {object|null} Authoritative exact service grant.
 */
function canonicalServiceGrant(store, service) {
    if (store.privateRecords) {
        const definition = store.privateRecords.services.getDefinition(service?.id);
        if (definition.status !== 'ok') throw new Error('Private service definition is missing or invalid.');
        return definition.grant;
    }
    const basedOn = service?.extension?.find(item => item.url === require('./pcm-contract').EXTENSIONS.basedOnCanonicalHealthcareService)?.valueReference?.reference;
    return readServiceGrant(basedOn ? store.get('HealthcareService', basedOn.replace(/^HealthcareService\//, '')) : service);
}
module.exports = { URL, MODEL, COMPILER, PATIENT_TYPES, FULL_PATIENT_SCOPE, inspectScope, readServiceGrant, canonicalServiceGrant };
