'use strict';

/** Closed resource/history mapping; aliases retained only for existing sandbox services. */
const BUCKET_RESOURCES = Object.freeze({
    laboratoryTests: Object.freeze({ Observation: 'date', DiagnosticReport: 'date' }),
    medications: Object.freeze({ MedicationRequest: 'authoredon', MedicationStatement: 'effective', MedicationAdministration: 'effective-time', MedicationDispense: 'whenhandedover' }),
    procedures: Object.freeze({ Procedure: 'date' }),
    diagnoses: Object.freeze({ Condition: 'recorded-date' }),
    allergiesAndIntolerances: Object.freeze({ AllergyIntolerance: 'date' }),
    encounterInformation: Object.freeze({ Encounter: 'date' }),
    allergies: Object.freeze({ AllergyIntolerance: 'date' }),
    immunizations: Object.freeze({ Immunization: 'date' })
});
module.exports = { BUCKET_RESOURCES };
