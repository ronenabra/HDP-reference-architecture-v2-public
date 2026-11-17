'use strict';

/** Information-bucket parsing and IL Core 0.22.0 sensitivity terminology.
 * Derived from the two sensitivity-label resources in the content-pinned
 * il.core.fhir.r4#0.22.0; see https://simplifier.net/ilcore.
 * No runtime dependency on the sibling IG checkout or compiler cache is needed.
 */
const LOCAL_SYSTEM = 'http://fhir.health.gov.il/cs/il-core-sensitivity-labels';
const ACT_SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const SENSITIVITY_LABELS = Object.freeze([
    ...['genetics', 'mental-health', 'gynecology', 'fertility', 'adoption-surrogacy',
        'domestic-violence', 'sexual-violence', 'social-work'].map(code => Object.freeze({ system: LOCAL_SYSTEM, code })),
    ...['HIV', 'PHY', 'PRS', 'NOPAT'].map(code => Object.freeze({ system: ACT_SYSTEM, code }))
]);
const labelKeys = new Set(SENSITIVITY_LABELS.map(label => `${label.system}|${label.code}`));

/** Validate one Coding against the pinned required sensitivity ValueSet. */
function assertSensitivityCoding(coding) {
    if (!coding || typeof coding.system !== 'string' || typeof coding.code !== 'string'
        || !labelKeys.has(`${coding.system}|${coding.code}`)) {
        throw new TypeError('taggedDetails requires a coding from IL Core sensitivity labels 0.22.0');
    }
    return coding;
}

/** Parse every bucket part without first-item truncation or ignored malformed values. */
function parseInformationBucket(extension) {
    const parts = extension?.extension;
    if (!Array.isArray(parts) || parts.some(part => !part || typeof part !== 'object')) {
        throw new TypeError('informationBucket requires bucket and historyDepth parts');
    }
    const bucket = parts.filter(part => part.url === 'bucket');
    const history = parts.filter(part => part.url === 'historyDepth');
    const tags = parts.filter(part => part.url === 'taggedDetails');
    const coding = bucket[0]?.valueCodeableConcept?.coding;
    const duration = history[0]?.valueDuration;
    if (parts.length !== bucket.length + history.length + tags.length
        || bucket.length !== 1 || history.length !== 1
        || !Array.isArray(coding) || coding.length !== 1
        || coding[0]?.system !== 'http://fhir.health.gov.il/cs/il-hdp-information-buckets'
        || typeof coding[0]?.code !== 'string' || !coding[0].code
        || !duration || typeof duration.value !== 'number' || !Number.isFinite(duration.value)
        || duration.system !== 'http://unitsofmeasure.org' || typeof duration.code !== 'string' || !duration.code) {
        throw new TypeError('Each informationBucket requires one bucket coding and one UCUM historyDepth');
    }
    for (const part of parts) {
        const valueField = part.url === 'historyDepth' ? 'valueDuration' : 'valueCodeableConcept';
        if (part.extension !== undefined || Object.keys(part).some(key => key.startsWith('value') && key !== valueField)) {
            throw new TypeError('Information bucket parts require exactly their declared value type');
        }
    }
    const taggedDetails = tags.map(part => {
        const values = part.valueCodeableConcept?.coding;
        if (!Array.isArray(values) || values.length !== 1) throw new TypeError('taggedDetails requires exactly one sensitivity coding');
        return assertSensitivityCoding(values[0]);
    });
    return { coding: coding[0], history: duration, taggedDetails };
}

module.exports = { SENSITIVITY_LABELS, assertSensitivityCoding, parseInformationBucket };
