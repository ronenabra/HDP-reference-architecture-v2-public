'use strict';
/** Actual private sampling, ordinary manual GUID Consent and native patient/source isolation. */
const fs = require('fs'), assert = require('node:assert/strict');
const { request, issue, introspect, save, approvePending, savedApproval, client, config } = require('./demo-runtime-client');
const identifier = { system: 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id', value: 'Ab123456-1234-5678-9012-000000000001' };
async function main() {
    let output;
    if (config.conformance.preset === 'strict') {
        await assert.rejects(client.loadSandboxPatientSample('ho-a', 'hospital-a'));
        const token = await client._test.getToken(config.internalBaseUrls.pcmFhir, 'hospital-a');
        const forged = require('/app/src/fhir-builders').buildConsentSubmit(identifier, config.service.id, { allowSandboxGuid: true });
        assert.equal((await request(`${config.internalBaseUrls.pcmFhir}/Consent`, { method: 'POST', body: forged, bearer: token })).status, 400);
        output = { preset: 'strict', status: 'pass', scenarios: ['sampler-denied', 'forged-guid-consent-denied'] };
    } else {
        // Measure with the actual preset before enabling filters: easy's sampler must stay bounded.
        const sample = await client.loadSandboxPatientSample('ho-a', 'hospital-a');
        assert.equal(sample.requests, 1); assert.equal(sample.patients.length, 10); assert.ok(sample.patients.every(patient => patient.idSystem === identifier.system && !patient.telecom && patient.birthDate === '1990-01-01'));
        output = { preset: config.conformance.preset, status: 'pass', sample: { count: sample.patients.length, sourceId: sample.sourceId, requests: sample.requests, diagnostics: sample.diagnostics }, scenarios: ['bounded-sample'] };
        if (process.env.PCM_SAMPLE_ONLY !== 'true') {
            assert.equal((await client.loadSandboxPatientSample('ho-b', 'hospital-a')).state, 'empty');
            await assert.rejects(client.loadSandboxPatientSample('legacy-ds', 'hospital-a'));
            assert.equal((await save()).status, 200);
            const binding = config.serviceCatalog.bindings.find(item => item.application === 'doctor' && item.serviceKey === 'lab-follow-up');
            const pending = await client.createConsentRequest(`${identifier.system}|${identifier.value}`, binding.instanceId, 'hospital-a');
            assert.equal(pending.status, 'proposed'); assert.equal(pending.patient.identifier.value, identifier.value);
            assert.notEqual((await issue(pending, 'patient/Patient.rs patient/Observation.rs')).status, 200);
            const consent = await approvePending(pending, { scopeChoice: 'service-provided', sourceIds: [config.healthOrganizations[0].dataSourceOrganization.id] });
            assert.equal(consent.status, 'active');
            const token = await issue(consent); assert.equal(token.status, 200);
            const active = await introspect(token.json.access_token); assert.equal(active.json.active, true); assert.equal(token.json.scope, savedApproval(consent).scope); assert.equal(active.json.scope, token.json.scope); assert.deepEqual(active.json.authorization_details, token.json.authorization_details);
            const patientContext = active.json.authorization_details[0].fhirContext.find(item => item.type === 'Patient'); assert.deepEqual(patientContext.identifier, identifier);
            const source = config.healthOrganizations[0].endpoint;
            const data = await request(`${source}/Observation?_count=10`, { bearer: token.json.access_token }); assert.equal(data.status, 200); assert.equal(data.json.entry.length, 1); assert.ok(data.json.entry[0].resource.id.includes('sample-observation-1'));
            const ownPatient = await request(`${source}/Patient?identifier=${encodeURIComponent(`${identifier.system}|${identifier.value}`)}`, { bearer: token.json.access_token }); assert.equal(ownPatient.status, 200); assert.equal(ownPatient.json.entry.length, 1);
            const foreign = await request(`${source}/Patient?identifier=${encodeURIComponent(`${identifier.system}|Ab123456-1234-5678-9012-000000000002`)}`, { bearer: token.json.access_token }); assert.ok(foreign.status >= 400 || !(foreign.json.entry || []).length);
            assert.notEqual((await issue(consent, undefined, 1)).status, 200); assert.ok((await request(`${config.healthOrganizations[1].endpoint}/Observation?_count=10`, { bearer: token.json.access_token })).status >= 400);
            output.scenarios.push('manual-guid-consent', 'exact-rar-introspection', 'native-guid-observation', 'other-patient-source-denied'); output.nativeFiltersDuringClinicalProof = true;
        }
    }
    output.scenarios = output.scenarios.map(id => ({ id: `demo-patients-${id}`, status: 'pass', executed: true }));
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(output, null, 2)); console.log(JSON.stringify(output));
}
main().catch(error => { console.error({ message: error.message, status: error.response?.status }); process.exitCode = 1; });
