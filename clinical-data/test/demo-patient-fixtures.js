'use strict';
/** Deterministic qualification-only populations; never generated or imported at bootstrap. */
const crypto = require('crypto');
const base = require('../demo/ho-a.source.transaction.json');
const SYSTEM = 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id';
/** Build only the explicitly selected 100/10000 qualification dataset with positive GUID clinical data. */
function patientFixture(count) {
    if (![100, 10000].includes(count)) throw new TypeError('Only the two qualification population sizes are supported');
    const bundle = structuredClone(base), template = base.entry.find(entry => entry.resource.resourceType === 'Patient').resource;
    for (let i = 1; i <= count; i++) {
        const suffix = String(i).padStart(12, '0'), value = `Ab123456-1234-5678-9012-${suffix}`;
        const patient = { ...structuredClone(template), id: `sample-${i}`, identifier: [{ system: SYSTEM, value }], name: [{ text: `Sandbox Person ${i}` }], birthDate: '1990-01-01', telecom: [{ system: 'phone', value: 'qualification-only' }] };
        patient.meta.security = [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }];
        bundle.entry.push({ fullUrl: `urn:uuid:ab123456-1234-5678-9012-${suffix}`, resource: patient, request: { method: 'PUT', url: `Patient/${patient.id}` } });
    }
    const observation = structuredClone(base.entry.find(entry => entry.resource.resourceType === 'Observation').resource);
    observation.id = 'sample-observation-1'; observation.subject = { reference: 'urn:uuid:ab123456-1234-5678-9012-000000000001' };
    bundle.entry.push({ fullUrl: 'urn:uuid:bb123456-1234-5678-9012-000000000001', resource: observation, request: { method: 'PUT', url: `Observation/${observation.id}` } });
    const bytes = Buffer.from(JSON.stringify(bundle));
    return { bundle, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), count, firstIdentifier: { system: SYSTEM, value: 'Ab123456-1234-5678-9012-000000000001' } };
}
module.exports = { patientFixture };
