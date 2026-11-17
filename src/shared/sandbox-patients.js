'use strict';
/** Closed local sampler contract; no normative system profile or live population access. */
const { SANDBOX_GUID_ID_SYSTEM: SYSTEM, isSandboxGuid, SYNTHETIC_TEST_ID_SYSTEM } = require('./identity-mapping');
const SCENARIO = 'sandbox-patient-sample';
const QUERY = new URLSearchParams({ identifier: `${SYSTEM}|`, _count: '10', _total: 'none', _elements: 'identifier,name,birthDate' }).toString();
const URI = `/fhir/Patient?${QUERY}`;
const FIXED = Object.freeze([{ idSystem: SYNTHETIC_TEST_ID_SYSTEM, idValue: '1', display: 'Israel Israelov', standardTest: true },
    { idSystem: SYNTHETIC_TEST_ID_SYSTEM, idValue: '2', display: 'Israela Israelov', standardTest: true }]);
/** Return configured managed sources explicitly entitled to the local sampler. */
function sampleSources(config) {
    if (config.conformance?.mode !== 'connectathon' || config.conformance.preset === 'strict') return [];
    return (config.healthOrganizations || []).filter(ho => ho.clinicalData?.managed === true && ho.enabled !== false
        && config.sandboxSampling?.sourceIds.includes(ho.id));
}
/** Identify configuration changes that invalidate an in-flight sample or displayed candidate list. */
function samplingConfigurationStamp(config) {
    return JSON.stringify([config.teamId, config.contract.environment, config.conformance, config.runtime?.revision,
        config.sandboxSampling, config.systemAuthorization.clientEntitlements, config.serviceCatalog,
        (config.healthOrganizations || []).map(source => [source.id, source.endpoint, source.enabled, source.clinicalData?.managed])]);
}
/** Reject any substituted route, verb, parameters, duplicates or query value. */
function assertSampleRequest(binding) {
    if (binding?.method !== 'GET' || binding.uri !== URI) throw new TypeError('Sampler permits only its fixed projected Patient search');
}
/** Validate the single first page, exclude ambiguous/untagged identities and never follow links. */
function projectSample(bundle) {
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'searchset' || !Array.isArray(bundle.entry || [])) throw new TypeError('Sampler expected a searchset');
    const patients = [], seen = new Set(); let rejected = 0;
    for (const entry of (bundle.entry || []).slice(0, 10)) {
        const patient = entry.resource;
        const identifiers = (Array.isArray(patient?.identifier) ? patient.identifier : []).filter(item => item.system === SYSTEM);
        if (patient?.resourceType !== 'Patient' || identifiers.length !== 1 || !isSandboxGuid(identifiers[0]?.value)
            || !(Array.isArray(patient?.meta?.security) ? patient.meta.security : []).some(tag => tag.system === 'http://terminology.hl7.org/CodeSystem/v3-ActReason' && tag.code === 'HTEST')) { rejected++; continue; }
        const key = `${SYSTEM}|${identifiers[0].value}`;
        if (seen.has(key)) { rejected++; continue; }
        seen.add(key);
        const name = patient.name?.[0];
        patients.push({ idSystem: SYSTEM, idValue: identifiers[0].value,
            ...(typeof patient.birthDate === 'string' && /^[0-9]{4}(?:-[0-9]{2}){0,2}$/.test(patient.birthDate) ? { birthDate: patient.birthDate } : {}),
            display: String(typeof name?.text === 'string' ? name.text : [...(Array.isArray(name?.given) ? name.given : []), name?.family].filter(value => typeof value === 'string').join(' ') || 'Sandbox patient').slice(0, 120), sandboxSynthetic: true });
    }
    return { patients, rejected, state: rejected ? 'partial' : patients.length ? 'loaded' : 'empty', truncated: (bundle.entry || []).length > 10 };
}
module.exports = { FIXED, QUERY, URI, SYSTEM, SCENARIO, samplingConfigurationStamp, sampleSources, assertSampleRequest, projectSample };
