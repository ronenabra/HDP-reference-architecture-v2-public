'use strict';
/** Actual Doctor client → PCM → adapter → HAPI catalog journey on an owned team. */
const fs = require('fs');
const assert = require('node:assert/strict');
const client = require('/app/src/client');
const config = JSON.parse(fs.readFileSync('/runtime/team-config.json'));
const { catalogScope, loadServiceCatalog } = require('/shared/service-catalog');

async function main() {
    const catalog = loadServiceCatalog(config);
    const results = [];
    for (const definition of catalog.clinicalServices.filter(item => !item.sandboxFullAccess)) {
        const binding = config.serviceCatalog.bindings.find(item => item.application === 'doctor' && item.serviceKey === definition.key);
        const consent = await client.createConsentRequest('http://fhir.health.gov.il/identifier/il-hdp-test-id|1', binding.instanceId, 'hospital-a');
        assert.equal(consent.status, 'active');
        const scope = catalogScope(definition);
        const data = await client.fetchData(consent.id, config.healthOrganizations[0].endpoint, 'hospital-a', scope);
        assert.equal(data.resourceType, 'Bundle');
        const types = (data.entry || []).map(entry => entry.resource.resourceType);
        assert.ok(types.includes('Patient'), `${definition.key} must return its authorized Patient`);
        const ceilings = new Set(scope.split(' ').map(item => item.split('/')[1].split('.')[0]));
        assert.ok(types.every(type => ceilings.has(type)));
        // The fixture's Observations belong to a different patient: every
        // preset must omit them while returning each positive mapped record.
        for (const type of ceilings) if (type !== 'Observation') assert.ok(types.includes(type), `${definition.key}: missing positive ${type} result`);
        assert.ok(!types.includes('Observation'), 'other-patient Observations must be filtered');
        const patients = data.entry.filter(entry => entry.resource.resourceType === 'Patient');
        assert.equal(patients.length, 1);
        assert.ok(patients[0].resource.identifier.some(item => item.system === 'http://fhir.health.gov.il/identifier/il-hdp-test-id' && item.value === '1'));
        results.push({ id: `demo-catalog-${definition.key}`, executed: true, service: definition.key, consentId: consent.id, scope, returnedTypes: types, status: 'pass' });
    }
    const output = { preset: config.conformance.preset, scenarios: results, status: 'pass' };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(output, null, 2));
    console.log(JSON.stringify(output));
}
main().catch(error => { console.error({ message: error.message, status: error.response?.status, classification: error.classification }); process.exitCode = 1; });
