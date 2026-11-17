'use strict';
/** Patient entry projection; all syntax and policy validation stays in the shared identifier helper. */
const mapping = require('../../shared/identity-mapping');
const ORDINARY = Object.freeze({ idSystem: mapping.DEFAULT_PATIENT_ID_SYSTEM, idValue: '000000018', display: 'Name unknown (ordinary demo patient)' });
/** Normalize a typed value or full token without converting numeric-looking identifiers. */
function patientChoice(value, system, config) {
    const parsed = mapping.parseBusinessIdentifier(value, system === undefined ? mapping.DEFAULT_PATIENT_ID_SYSTEM : String(system).trim());
    if (parsed && !parsed.system) throw new TypeError('Enter a supported patient identifier system URI');
    return mapping.normalizePatientIdentifier(parsed, mapping.sandboxIdentityOptions(config));
}
/** Offer supported namespaces; pasted full tokens still use the same shared validation. */
function identifierTypes() {
    return [
        { system: mapping.DEFAULT_PATIENT_ID_SYSTEM, label: 'Israeli national identifier' },
        { system: mapping.PALESTINIAN_NATIONAL_ID_SYSTEM, label: 'Palestinian national identifier' },
        { system: mapping.SYNTHETIC_TEST_ID_SYSTEM, label: 'Standard synthetic test identifier' },
        { system: mapping.SANDBOX_GUID_ID_SYSTEM, label: 'Sandbox synthetic GUID' },
        ...[...mapping.PASSPORT_ID_SYSTEMS].map(system => ({ system, label: `Passport (${system.slice(-3)})` }))
    ];
}
/** Associate shared-validator failures with the editable field without duplicating policy. */
function patientErrorField(error) {
    return /system|subset/.test(error.message) && !/value/.test(error.message) ? 'system' : 'value';
}
module.exports = { ORDINARY, patientChoice, identifierTypes, patientErrorField };
