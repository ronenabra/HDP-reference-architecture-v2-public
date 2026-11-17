'use strict';
/** Local UI projections of authoritative Consent decisions; never modify the FHIR resource. */
const { IDENTIFIER_SYSTEMS, SECURITY } = require('./pcm-contract');

/** Identify the exact auto-approved test exception, including later expired/cancelled records. */
function isTestAutoApproved(consent) {
    const patient = consent?.patient?.identifier;
    return patient?.system === IDENTIFIER_SYSTEMS.syntheticTest && ['1', '2'].includes(patient.value)
        && Boolean(consent.provision?.period?.start)
        && (consent.meta?.security || []).some(code => code.system === SECURITY.system && code.code === SECURITY.syntheticTestCode);
}

/** Retired compatibility projection: no preset exempts Consent approval. */
function relaxedConsentSources(_policy) { return []; }
const CATEGORY_LABELS = Object.freeze({ laboratoryTests: 'Laboratory tests', medications: 'Medications',
    procedures: 'Procedures', diagnoses: 'Diagnoses', allergiesAndIntolerances: 'Allergies and intolerances',
    allergies: 'Allergies', encounterInformation: 'Encounters', immunizations: 'Immunizations' });

/** Format a recorded instant with an explicit timezone; never invent missing dates. */
function readableDate(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
}

/** Translate the supported history units while retaining unknown authored values. */
function historyLabel(history = {}) {
    const unit = { a: 'year', mo: 'month', wk: 'week', d: 'day', h: 'hour', min: 'minute', s: 'second' }[history.code];
    return unit ? `Past ${history.value} ${unit}${Number(history.value) === 1 ? '' : 's'}` : `${history.value ?? 'Unknown'} ${history.code || 'unknown unit'}`;
}

/** Explain saved scope text conservatively, without treating it as an issued grant. */
function savedPermissions(scope) {
    if (!scope) return 'No permission text was saved.';
    return scope.split(' ').filter(Boolean).map(token => {
        const match = /^patient\/([A-Z][A-Za-z]+)\.(r|s|rs)(?:\?(.+))?$/.exec(token);
        if (!match) return 'Unrecognized permission text; review the technical scope.';
        const action = { r: 'Read', s: 'Search', rs: 'Read and search' }[match[2]];
        const type = { Patient: 'patient records', Observation: 'observations', DiagnosticReport: 'diagnostic reports',
            MedicationRequest: 'medication requests', MedicationStatement: 'medication statements',
            AllergyIntolerance: 'allergy records', Condition: 'diagnoses', Procedure: 'procedures', Encounter: 'encounters',
            Immunization: 'immunizations' }[match[1]] || match[1];
        const filters = new URLSearchParams(match[3] || '');
        const categories = filters.getAll('_security').flatMap(value => value.split(',')).map(value => CATEGORY_LABELS[value.split('|')[1]]).filter(Boolean);
        return `${action} ${type}${categories.length ? `, filtered by ${categories.join(' or ').toLowerCase()}` : match[3] ? ', with saved filters (see technical scope)' : ''}.`;
    }).join(' ');
}

/** Describe recorded choice origins without exposing internal classification prefixes. */
function permissionChoice(origin) {
    if (origin?.startsWith('service-')) return 'Service provided (default) — exact saved definition';
    if (origin?.startsWith('manual:')) return 'Manual override — advanced';
    if (origin?.startsWith('Missing legacy')) return origin;
    if (origin?.startsWith('custom:')) return 'Custom permissions — advanced';
    if (origin?.startsWith('authored:')) return `Service-defined permission option: ${origin.slice('authored:'.length).trim()}`;
    if (origin?.startsWith('generated:')) return origin.includes('bucket') || origin.includes('categor')
        ? "Generated from the service's data categories" : "Generated from the service's data types";
    return 'Saved previously; the selection method was not recorded.';
}

/** Show only retained source-change evidence; resolve names with raw IDs as a fallback. */
function sourceHistory(audit, choices = []) {
    if (!audit || !Number.isFinite(Date.parse(audit.at)) || !['added', 'removed'].every(key => Array.isArray(audit[key]) && audit[key].every(id => typeof id === 'string'))) return null;
    const names = new Map(choices.map(source => [source.id, source.name]));
    return { at: readableDate(audit.at), added: audit.added.map(id => names.get(id) || id).join(', ') || 'None',
        removed: audit.removed.map(id => names.get(id) || id).join(', ') || 'None' };
}

module.exports = { isTestAutoApproved, relaxedConsentSources, readableDate, historyLabel, savedPermissions, permissionChoice, sourceHistory, CATEGORY_LABELS };
