'use strict';
/** Minimal ordinary HealthcareService submit bodies, using the existing mapping and compiler. */
const { EXTENSIONS, CODE_SYSTEMS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const { BUCKET_RESOURCES } = require('../../shared/clinical-resource-mapping');
const { SENSITIVITY_LABELS, assertSensitivityCoding } = require('../../shared/information-buckets');
const { classifyRegistrationRequest } = require('./fhir/healthcare-service-lifecycle');
const { validateScope, serviceGrantExtension } = require('./service-scope-authoring');
const { policyExtension } = require('../../shared/service-confidentiality-policy');
const { TYPES: MASTER_TYPES, masterExtension } = require('../../shared/service-master-data');
const UNITS = Object.freeze({ a: 'years', mo: 'months', wk: 'weeks', d: 'days', h: 'hours' });

/** Build and validate the minimum definition and one retained service-defined scope option.
 * @param {object} input Readable form fields; no server-managed fields accepted.
 * @param {object} options Server-validated illustrative template queries, when supplied.
 * @returns {object} Closed regular FHIR create body.
 */
function serviceDefinitionDraft(input, { exampleQueries, now, internalValidation = false } = {}) {
    const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
    if (!input || Object.keys(input).some(key => !['name', 'purpose', 'category', 'accessMode', 'duration', 'durationUnit', 'allowChanges', 'buckets', 'permissions', 'confidentialityPolicy', 'includeMasterData', 'scopeOrigin', 'approvalScope', 'exampleQueries'].includes(key))) fail('Use the service creation form fields.');
    for (const [key, label] of [['name', 'Service name'], ['purpose', 'Purpose']]) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2000) fail(`${label} is required (up to 2000 characters).`);
    if (input.category !== '35') fail('Choose a supported service category.');
    if (!['continuous', 'one-time'].includes(input.accessMode) || typeof input.allowChanges !== 'boolean') fail('Choose an access mode and whether patient data-category changes are allowed.');
    const duration = Number(input.duration);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 1000 || !UNITS[input.durationUnit]) fail('Access duration must be a whole number from 1 to 1000 with a supported unit.');
    if (!Array.isArray(input.buckets) || !input.buckets.length || input.buckets.length > Object.keys(BUCKET_RESOURCES).length) fail('Select at least one supported data category.');
    if (new Set(input.buckets.map(bucket => bucket?.code)).size !== input.buckets.length) fail('Choose each data category once.');
    const extensions = input.buckets.map(bucket => {
        if (!bucket || Object.keys(bucket).some(key => !['code', 'history', 'historyUnit', 'sensitivity'].includes(key)) || !Object.hasOwn(BUCKET_RESOURCES, bucket.code)) fail('Choose a supported data category.');
        const history = Number(bucket.history);
        if (!Number.isSafeInteger(history) || history < 0 || history > 1000 || !UNITS[bucket.historyUnit]) fail('History must be a whole number from 0 to 1000 with a supported unit.');
        if (!Array.isArray(bucket.sensitivity) || bucket.sensitivity.length > SENSITIVITY_LABELS.length || new Set(bucket.sensitivity).size !== bucket.sensitivity.length) fail('Choose valid additional sensitive categories.');
        const tags = bucket.sensitivity.map(value => {
            const coding = SENSITIVITY_LABELS.find(item => `${item.system}|${item.code}` === value);
            try { assertSensitivityCoding(coding); } catch { fail('Choose a supported sensitive category.'); }
            return { url: 'taggedDetails', valueCodeableConcept: { coding: [coding] } };
        });
        return { url: EXTENSIONS.informationBucket, extension: [
            { url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code: bucket.code }] } },
            { url: 'historyDepth', valueDuration: { value: history, code: bucket.historyUnit, system: 'http://unitsofmeasure.org' } }, ...tags
        ] };
    });
    const types = ['Patient', ...new Set(input.buckets.flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.code])))];
    if (!Array.isArray(input.permissions) || !input.permissions.length || input.permissions.length > types.length || new Set(input.permissions.map(item => item?.type)).size !== input.permissions.length) fail('Choose at least one data type and read/search permission, without duplicates.');
    for (const choice of input.permissions) if (!choice || Object.keys(choice).some(key => !['type', 'actions'].includes(key)) || !types.includes(choice.type) || !['r', 's', 'rs'].includes(choice.actions)) fail('Choose only data types used by the selected categories and supported read/search actions.');
    if (!input.permissions.some(item => item.type === 'Patient' && item.actions === 'rs')) fail('Patient read and search (patient/Patient.rs) are required.');
    let confidentiality, master;
    try { confidentiality = policyExtension(input.confidentialityPolicy); master = masterExtension(input.includeMasterData); } catch (error) { fail(error.message); }
    const masterPermissions = input.includeMasterData ? MASTER_TYPES.map(type => ({ type, actions: 'r' })) : [];
    const generated = [...input.permissions, ...masterPermissions].map(item => `patient/${item.type}.${item.actions}`).join(' ');
    const origin = input.scopeOrigin ?? 'generated';
    if (!['generated', 'custom'].includes(origin)) fail('Choose generated or custom scope origin.');
    if (origin === 'generated' && input.approvalScope !== undefined && input.approvalScope !== generated) fail('Generated scope changed. Reset to generated or choose custom.');
    const scope = origin === 'custom' ? input.approvalScope : generated;
    validateScope(scope, input);
    exampleQueries ??= input.exampleQueries;
    if (exampleQueries !== undefined && (!Array.isArray(exampleQueries) || exampleQueries.length > types.length || new Set(exampleQueries.map(query => query?.type)).size !== exampleQueries.length || exampleQueries.some(query => !query || Object.keys(query).some(key => !['type', 'query'].includes(key)) || !input.permissions.some(item => item.type === query.type) || typeof query.query !== 'string' || !query.query.trim() || query.query.length > 2000 || /[\x00-\x1f\x7f]/.test(query.query)))) fail('Example queries require unique selected resource types and readable text up to 2000 characters. They are examples only, never executed.');
    const queries = exampleQueries ? [...exampleQueries.map(query => ({ url: EXTENSIONS.exampleQuery, valueString: query.query })), ...masterPermissions.map(item => ({ url: EXTENSIONS.exampleQuery, valueString: `GET [FHIR BASE]/${item.type}/[record-id]` }))] : [...input.permissions, ...masterPermissions].map(item => ({ url: EXTENSIONS.exampleQuery, valueString: item.actions.includes('s') ? `GET [FHIR BASE]/${item.type}?_count=10` : `GET [FHIR BASE]/${item.type}/[record-id]` }));
    const request = { resourceType: 'HealthcareService', meta: { profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-new-service-submit'] },
        name: input.name.trim(), extraDetails: input.purpose.trim(), category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/service-category', code: input.category }] }],
        type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA', display: 'information access' }] }],
        extension: [confidentiality, master, { url: EXTENSIONS.accessMode, valueCode: input.accessMode },
            { url: EXTENSIONS.accessDuration, valueDuration: { value: duration, code: input.durationUnit, system: 'http://unitsofmeasure.org' } },
            { url: EXTENSIONS.allowPatientBucketChange, valueBoolean: input.allowChanges }, ...extensions, ...queries,
            { url: SANDBOX_EXTENSIONS.approvalScopeOption, extension: [{ url: 'id', valueString: 'selected-permissions' }, { url: 'label', valueString: origin === 'custom' ? 'Custom selected read/search permissions' : 'Selected read/search permissions' }, { url: 'scope', valueString: scope }, ...(input.scopeOrigin === undefined ? [] : [{ url: 'origin', valueString: origin }])] }] };
    request.extension.push(serviceGrantExtension(request, input, { now }));
    if (!internalValidation) classifyRegistrationRequest(request);
    return request;
}

/** Build the closed existing-catalog registration without any browser-supplied owner. */
function existingRegistration(catalogId) {
    if (typeof catalogId !== 'string' || !/^[A-Za-z0-9.-]{1,64}$/.test(catalogId)) throw Object.assign(new Error('Choose a valid service definition.'), { status: 400 });
    return { resourceType: 'HealthcareService', extension: [{ url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: `HealthcareService/${catalogId}` } }] };
}
/** Build a clean public submit body. Authoring permissions stay in the separate command. */
function serviceDefinition(input, options) { return serviceDefinitionCommand(input, options).resource; }
/** Closed owner command; callers must use the existing authenticated PCM owner boundary. */
function serviceDefinitionCommand(input, options) { return require('./public-fhir').splitProduced(serviceDefinitionDraft(input, options)); }
module.exports = { serviceDefinition, serviceDefinitionCommand, serviceDefinitionDraft, existingRegistration, UNITS };
