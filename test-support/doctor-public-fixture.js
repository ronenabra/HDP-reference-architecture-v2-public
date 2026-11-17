'use strict';
/** Unmodified pinned public examples plus realistic detached OAuth/source responses. */
const fs = require('node:fs'), path = require('node:path');
const { EXTENSIONS } = require('../src/shared/pcm-contract');
const { TYPE, ROLE, SERVICE } = require('../src/shared/data-authorization-details');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/FHIR-examples', file)));

/** Return fresh public-only objects, with no PCM owner repository or compiler dependency. */
function doctorPublicFixture() {
    const canonical = read('HealthcareService-svc-catalog-cross-org-summary.json');
    const instance = read('HealthcareService-svc-instance-hosp-a-cross-org-summary.json');
    const consent = read('Consent-consent-hosp-a-cross-org-summary.json');
    const providerId = instance.providedBy.reference.split('/')[1];
    const provider = { resourceType: 'Organization', id: providerId, active: true, name: 'Public provider' };
    const details = [{ type: TYPE, purposeOfUse: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' }], fhirContext: [
        { type: 'Consent', role: `${ROLE}authorization-basis`, identifier: { ...consent.identifier[0] } },
        { type: 'HealthcareService', role: `${ROLE}healthcare-service`, identifier: { system: SERVICE.Consent, value: instance.identifier.find(value => value.system === SERVICE.Consent).value } },
        { type: 'Patient', role: `${ROLE}authorization-patient`, identifier: { ...consent.patient.identifier } }
    ] }];
    // FHIR identifiers may contain public descriptive properties; RAR is the closed pair.
    for (const item of details[0].fhirContext) item.identifier = { system: item.identifier.system, value: item.identifier.value };
    return { canonical, instance, consent, provider, details, serviceId: consent.extension.find(value => value.url === EXTENSIONS.pcmService).valueReference.reference.split('/')[1],
        scope: 'patient/Observation.s?status=final&date=ge2025-01-01 patient/Condition.r',
        response: { access_token: 'opaque-bearer-must-never-render', token_type: 'Bearer', expires_in: 30, scope: 'patient/Observation.s?status=final&date=ge2025-01-01 patient/Condition.r', authorization_details: details } };
}
module.exports = { doctorPublicFixture };
