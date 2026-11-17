'use strict';

/** Exact private scope shapes emitted by PCM; public workflow requests stay unfiltered. */
const DEMOGRAPHICS = '_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics';
const DISCOVERY_TAG = '_tag=http://fhir.health.gov.il/cs/il-hdp-resource-tags|hmo-dependent-discovery';

/** Compile the ordered identifier list bound to online or batch presence context. */
function presenceScope(identifiers) {
    return `system/Patient.s?identifier=${identifiers.map(value => `${value.system}|${value.value}`).join(',')}&${DEMOGRAPHICS}`;
}

/** Compile independent Patient and RelatedPerson discovery alternatives in canonical order. */
function discoveryScope(identifier) {
    const token = `${identifier.system}|${identifier.value}`;
    return `system/Patient.s?_has:RelatedPerson:patient:identifier=${token}&${DEMOGRAPHICS} system/RelatedPerson.s?identifier=${token}&${DEMOGRAPHICS}&${DISCOVERY_TAG}`;
}
const authenticationScope = `patient/Patient.s?${DEMOGRAPHICS}`;
module.exports = { DEMOGRAPHICS, presenceScope, discoveryScope, authenticationScope };
