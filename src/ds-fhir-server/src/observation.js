/**
 * Observation helpers for the DS FHIR server mock.
 */
const { v4: uuidv4 } = require('uuid');

/**
 * Build a minimal Observation searchset bundle for a given patient reference.
 * @param {string|null|undefined} patientRef
 * @returns {object} FHIR Bundle
 */
function buildObservationBundle(patientRef) {
    const observations = [
        {
            resourceType: 'Observation',
            id: uuidv4(),
            status: 'final',
            code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel with all children optional' }] },
            subject: { reference: patientRef || 'Patient/unknown' },
            effectiveDateTime: new Date().toISOString(),
            component: [
                {
                    code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic blood pressure' }] },
                    valueQuantity: { value: 120, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' }
                },
                {
                    code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic blood pressure' }] },
                    valueQuantity: { value: 80, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' }
                }
            ]
        }
    ];

    return {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: observations.map(r => ({ resource: r }))
    };
}

module.exports = {
    buildObservationBundle
};
