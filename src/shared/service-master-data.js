'use strict';

/** Explicit owner-approved, finite direct-read authority for non-patient master data. */
const URL = 'urn:pcm:sandbox:service-master-data';
const TYPES = Object.freeze(['Organization', 'Practitioner', 'PractitionerRole', 'Location']);

/** Encode only an explicit boolean; callers cannot select actions or invent types. */
function masterExtension(enabled = false) {
    if (typeof enabled !== 'boolean') throw new Error('Include master data requires a boolean.');
    return { url: URL, valueBoolean: enabled };
}

/** Read live canonical metadata; omission preserves legacy master access off. */
function masterEnabled(service) {
    const values = (service?.extension || []).filter(item => item.url === URL);
    if (!values.length) return false;
    if (values.length !== 1 || Object.keys(values[0]).some(key => !['url', 'valueBoolean'].includes(key))
        || typeof values[0].valueBoolean !== 'boolean') throw new Error('Invalid service master-data setting.');
    return values[0].valueBoolean;
}

/** Exact read-only ceilings, with no search or Patient-compartment implication. */
function masterScopes(service) {
    return masterEnabled(service) ? TYPES.map(type => `patient/${type}.r`) : [];
}
module.exports = { URL, TYPES, masterExtension, masterEnabled, masterScopes };
