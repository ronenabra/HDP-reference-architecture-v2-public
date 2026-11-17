'use strict';

/** Doctor's finite app intent and public OAuth grant projection; never PCM policy. */
const { EXTENSIONS, CODE_SYSTEMS } = require('../../shared/pcm-contract');
const { BUCKET_RESOURCES } = require('../../shared/clinical-resource-mapping');
const { PATIENT_TYPES, FULL_PATIENT_SCOPE } = require('../../shared/service-grant');
const TYPES = ['RelatedPerson', 'Patient', ...new Set(Object.values(BUCKET_RESOURCES).flatMap(value => Object.keys(value))), 'Organization', 'Practitioner', 'PractitionerRole', 'Location'];
const TOKEN_FILTERS = {
    Observation: ['status', 'category', 'code'], DiagnosticReport: ['status', 'category', 'code'],
    MedicationRequest: ['status', 'category', 'code'], MedicationStatement: ['status', 'category', 'code'],
    MedicationAdministration: ['status', 'code'], MedicationDispense: ['status', 'code'],
    Procedure: ['status', 'category', 'code'], Condition: ['category', 'code'],
    AllergyIntolerance: ['category', 'code'], Encounter: ['status'], Immunization: ['status']
};

/** Read public service definitions as descriptive inputs and finite intended operations.
 * @param {object|null} definition Public HealthcareService canonical facts.
 * @returns {object} Descriptive fields and doctor-clinical-intent/1 operations, never approved authority.
 */
function servicePermissions(definition) {
    const extensions = definition?.extension || [], find = url => extensions.find(value => value.url === url);
    const durationText = value => value && Number.isFinite(value.value) && value.value >= 0 && typeof (value.unit || value.code) === 'string' ? `${value.value} ${value.unit || value.code}` : 'Unavailable';
    const buckets = extensions.filter(value => value.url === EXTENSIONS.informationBucket).map(value => {
        const children = value.extension || [];
        const codings = children.find(child => child.url === 'bucket')?.valueCodeableConcept?.coding || [];
        const code = codings.find(coding => coding.system === CODE_SYSTEMS.informationBucket)?.code;
        const history = children.find(child => child.url === 'historyDepth')?.valueDuration;
        const sensitivity = children.filter(child => child.url === 'taggedDetails');
        return { code: code || 'Unavailable', history: durationText(history), sensitivity };
    });
    const codes = new Set(buckets.map(bucket => bucket.code === 'allergies' ? 'allergiesAndIntolerances' : bucket.code));
    const types = ['Patient', ...new Set(Object.entries(BUCKET_RESOURCES).filter(([code]) => codes.has(code)).flatMap(([, mapping]) => Object.keys(mapping)))];
    const ceiling = types.map(type => `patient/${type}.rs`).join(' ');
    const duration = find(EXTENSIONS.accessDuration)?.valueDuration;
    return { ...permissionSummary(ceiling), mapping: 'doctor-clinical-intent/1', buckets,
        access: ['continuous', 'one-time'].includes(find(EXTENSIONS.accessMode)?.valueCode) ? find(EXTENSIONS.accessMode).valueCode : 'Unavailable',
        duration: durationText(duration),
        patientChanges: find(EXTENSIONS.allowPatientBucketChange)?.valueBoolean,
        categories: buckets.map(bucket => bucket.code), historyInputs: buckets.map(bucket => `${bucket.code}: ${bucket.history}`),
        unknown: buckets.filter(bucket => !Object.hasOwn(BUCKET_RESOURCES, bucket.code)).map(bucket => bucket.code),
        message: 'App request intent from public service categories; granted permissions are not yet obtained. Unknown codes add no operations; with no mapped category the explicit default is Patient context only.' };
}

/** Parse the complete public grant without requiring PCM compiler shape or private exclusions.
 * Supported filters are retained literally and enforced by the source, never rewritten.
 * @param {string} scope Exact scope returned in an OAuth response.
 * @returns {object} Complete clauses, actions and explicit capability diagnostics.
 */
function permissionSummary(scope) {
    if (scope === FULL_PATIENT_SCOPE) {
        const projection = permissionSummary(PATIENT_TYPES.map(type => `patient/${type}.rs`).join(' '));
        return { ...projection, scope, wildcard: true, history: { ...projection.history, message: 'All supported patient data, including R and V; no scope predicates. Patient and source context still apply.' } };
    }
    const issues = [], clauses = [], permissions = new Map();
    if (typeof scope !== 'string' || !scope || scope.length > 16384 || scope !== scope.trim() || /[^\x20-\x7e]| {2}/.test(scope)) issues.push('Scope must contain bounded ASCII alternatives separated by single spaces.');
    for (const token of typeof scope === 'string' ? scope.split(' ') : []) {
        const match = /^patient\/([A-Z][A-Za-z0-9]*)\.(r|s|rs)(?:\?(.+))?$/.exec(token);
        if (!match) { issues.push('Only finite patient read/search scopes are supported.'); continue; }
        const [, type, actions, query] = match;
        if (!TYPES.includes(type) || ['Organization', 'Practitioner', 'PractitionerRole', 'Location'].includes(type) && actions !== 'r') issues.push(`${type}: unsupported resource/actions.`);
        const filters = query ? query.split('&') : [];
        for (const filter of filters) {
            const predicate = /^([^=&\s]+)=([^=&\s]+)$/.exec(filter);
            if (!predicate || /[%$]/.test(filter)) { issues.push(`Unsupported or malformed restriction: ${filter}`); continue; }
            const [, name, value] = predicate;
            const dates = Object.values(BUCKET_RESOURCES).map(mapping => mapping[type]).filter(Boolean);
            if (['_security', '_security:not'].includes(name)) {
                if (!value.split(',').every(part => /^[A-Za-z][A-Za-z0-9+.-]*:[^|,]+\|[A-Za-z0-9.-]+$/.test(part))) issues.push(`Malformed security restriction: ${filter}`);
            } else if (dates.includes(name)) {
                const date = /^(?:ge|gt|le|lt|eq)(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?)$/.exec(value);
                if (!date || !Number.isFinite(Date.parse(date[1])) || new Date(date[1]).toISOString().slice(0, 10) !== date[1].slice(0, 10)) issues.push(`Malformed date restriction: ${filter}`);
            } else if (!TOKEN_FILTERS[type]?.includes(name) || !value.split(',').every(part => /^(?:[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9:/._+-]+\|)?[A-Za-z0-9:/._+-]+$/.test(part))) issues.push(`Unsupported restriction for ${type}: ${filter}`);
        }
        clauses.push({ type, actions, filters });
        permissions.set(type, [...'rs'].filter(action => (permissions.get(type) || '').includes(action) || actions.includes(action)).join(''));
    }
    const usable = !issues.length && clauses.length > 0;
    const actions = usable ? [...permissions].map(([type, value]) => ({ type, permissions: value, description: value === 'r' ? 'individual record read only' : value === 's' ? 'search only' : 'individual record read and search' })) : [];
    return { scope, usable, actions, clauses, diagnostics: { issues }, ceiling: actions.map(action => `patient/${action.type}.${action.permissions}`).join(' '),
        history: { available: usable, alternatives: clauses, message: 'Literal token restrictions only; no rolling history or approval provenance is inferred.' } };
}

/** Validate explicit finite app selections, independent of any hidden approved scope.
 * @param {string} selection Unfiltered finite resource/action intent.
 * @returns {object} Complete validated selection; malformed/unsupported input throws.
 */
function validateSelection(selection) {
    const summary = permissionSummary(selection);
    if (summary.wildcard || !summary.usable || summary.clauses.some(clause => clause.filters.length) || summary.actions.length !== summary.clauses.length || summary.actions.length > TYPES.length) {
        throw new Error('Choose each supported finite patient resource once with r, s or rs, separated by one space; filters come from the token grant.');
    }
    return summary;
}

/** Select intended operations applicable to the obtained grant; constraints remain source-enforced.
 * @param {object} summary Complete supported public grant projection.
 * @param {string} selection Independently selected finite app operations.
 * @returns {object} Search actions and honest read-only/not-granted skips.
 */
function planQueries(summary, selection = summary.ceiling) {
    if (!summary.usable) throw new Error('The effective token scope contains unsupported restrictions; no clinical query can be sent.');
    const selected = validateSelection(selection), searches = [], skipped = [];
    for (const action of selected.actions) {
        const granted = summary.actions.find(value => value.type === action.type);
        if (action.permissions.includes('s') && granted?.permissions.includes('s')) searches.push({ type: action.type, method: 'GET', interaction: 'search' });
        else skipped.push({ type: action.type, outcome: granted?.permissions.includes('r') ? 'skipped-read-only' : 'not-granted',
            message: granted?.permissions.includes('r') ? 'Individual record read only; this preview requires search permission and has no known-record-ID composer.' : 'Requested operation is absent from the effective token grant; no query sent.' });
    }
    return { selection, ceiling: summary.ceiling, searches, skipped };
}

/** Validate public RAR binding and the whole returned grant without a private approval comparison.
 * @param {object} response OAuth scope and enriched authorization_details.
 * @param {object} consent Exact public Consent for this request.
 * @param {object} instance Exact public service registration associated with that Consent.
 * @param {object} options Local public identity/lifetime validation options.
 * @returns {object} Detached effective grant and complete supported scope projection.
 */
function validateClinicalGrant(response, consent, instance, options = {}) {
    const { consentAuthorizationDetails, validateDataAuthorizationDetails, SERVICE } = require('../../shared/data-authorization-details');
    const expected = consentAuthorizationDetails(consent)[0].fhirContext[0].identifier;
    const effective = validateDataAuthorizationDetails(response.authorization_details, options);
    const identifiers = (instance.identifier || []).filter(value => value.system === SERVICE.Consent);
    const association = consent.extension?.find(value => value.url === EXTENSIONS.pcmService)?.valueReference?.reference;
    const equal = (left, right) => left?.system === right?.system && left?.value === right?.value;
    const summary = permissionSummary(response.scope);
    if (!summary.usable || effective.scenario !== 'consent-access' || !equal(effective.basis.identifier, expected)
        || !equal(effective.patients[0], consent.patient?.identifier) || association !== `HealthcareService/${instance.id}`
        || identifiers.length !== 1 || !equal(effective.service.identifier, identifiers[0])) {
        throw new TypeError('Unexpected effective clinical grant: unsupported scope or mismatched Consent/Patient/service context. No clinical query sent.');
    }
    return { scope: response.scope, authorization_details: structuredClone(response.authorization_details), summary };
}
module.exports = { TYPES, permissionSummary, servicePermissions, validateSelection, planQueries, validateClinicalGrant };
