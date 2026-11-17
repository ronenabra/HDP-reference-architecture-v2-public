'use strict';

/** Sandbox institution classification, separate from FHIR source role and hosting. */
const INSTITUTION_TYPES = Object.freeze(['hmo', 'hospital', 'other']);

/** Resolve documented legacy defaults without guessing from names or arbitrary custom IDs. */
function sourceInstitutionType(source, { managed = false } = {}) {
    const value = source.institutionType === undefined ? (managed && ['ho-a', 'ho-b', 'ho-c'].includes(source.id) ? 'hmo' : 'other') : source.institutionType;
    if (!INSTITUTION_TYPES.includes(value)) throw new TypeError('Institution type must be HMO, Hospital or Other');
    return value;
}
module.exports = { INSTITUTION_TYPES, sourceInstitutionType };
