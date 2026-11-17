'use strict';
/** Existing patient-free workflows remain explicit and never inherit the clinical compartment optimizer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { request, presenceClaims } = require('./hapi-authorization-matrix');
const { maintenance } = require('./hapi-authorized-search-matrix');
const { presenceScope, discoveryScope, authenticationScope, DEMOGRAPHICS } = require('./pcm-042-native-fixture');
const report = { status: 'running', preset: JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)).conformance.preset, cases: [] };
const patient = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
const missing = { system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: '999999' };
const representative = { ...missing, value: '111111' };
const demographics = { system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'patientDemographics' };
const clinical = 'authorized-search-patient';
/** Only complete, supported Contract contexts are signed; missing mandatory context is an explicit negative. */
function claims(kind, scenario, identifier) {
    return { kind, scenario, patient_identifier: identifier, consent_identifier: undefined, organization: undefined,
        healthcare_service_identifier: undefined, contract_identifier: {
            system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id',
            value: scenario === 'patient-authentication' ? 'PCM-POLICY-PATIENT-AUTHENTICATION-001' : 'PCM-POLICY-DEPENDENT-DISCOVERY-001' } };
}
/** Require exact expected status and retain only nonsecret proof facts. */
async function check(name, uri, scope, options = {}, expected = 200) {
    const result = await request('ho-a', uri, scope, options);
    assert.equal(result.response.status, expected, `${name}: ${result.text}`);
    report.cases.push({ name, status: result.response.status }); return result.body;
}
/** Exercise unchanged native system workflows on tiny owned records, including no representative Patient. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    try {
        const sample = { resourceType: 'Patient', id: 'authorized-search-sample', name: [{ text: 'Owned sample' }], birthDate: '1990-01-01',
            identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id', value: '11111111-1111-4111-8111-111111111111' }],
            address: [{ text: 'must not be disclosed' }], meta: { security: [demographics, { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } };
        await maintenance('PUT', '/Patient/' + sample.id, sample);
        const sampleClaims = { ...claims('sandbox-patient-sample', 'sandbox-patient-sample'),
            healthcare_service_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-system-healthcareservice-id', value: 'owned-sample-service' } };
        const sampleQuery = '/fhir/Patient?' + new URLSearchParams({ identifier: sample.identifier[0].system + '|', _count: '10', _total: 'none', _elements: 'identifier,name,birthDate' });
        if (report.preset === 'connectathon-easy') {
            const result = await check('patient-free-fixed-sampler', sampleQuery, 'system/Patient.s', { claims: sampleClaims });
            assert.deepEqual(result.entry.map(entry => entry.resource.id), [sample.id]);
            assert.equal(result.entry[0].resource.birthDate, '1990-01-01'); assert.equal(result.entry[0].resource.address, undefined);
            await check('sampler-query-widening-denied', sampleQuery + '&name=other', 'system/Patient.s', { claims: sampleClaims }, 403);
        } else {
            await check('sampler-denied-in-strict', sampleQuery, 'system/Patient.s', { claims: sampleClaims }, 403);
            const original = await maintenance('GET', '/Patient/' + clinical);
            await maintenance('PUT', '/Patient/' + clinical, { ...original, meta: { ...original.meta, security: [demographics] },
                name: [{ text: 'Owned authentication target' }], birthDate: '1980-01-02', address: [{ text: 'not projected' }],
                telecom: [{ system: 'sms', value: '+972500000001' }] });
            const authUri = '/fhir/Patient?' + new URLSearchParams({ identifier: patient.system + '|' + patient.value, _elements: 'identifier,name,telecom,birthDate' });
            const auth = claims('patient-authentication', 'patient-authentication', patient);
            const authResult = await check('patient-authentication-exact-target-projection', authUri, authenticationScope, { claims: auth });
            assert.deepEqual(authResult.entry.map(entry => entry.resource.id), [clinical]); assert.equal(authResult.entry[0].resource.address, undefined);
            await check('authentication-missing-patient-denied', authUri, authenticationScope, { claims: { ...auth, patient_identifier: undefined } }, 403);
            await check('clinical-missing-patient-denied', '/fhir/Observation?_count=10', 'patient/Observation.s', { claims: { patient_identifier: undefined } }, 403);
            const oneScope = presenceScope([patient]);
            const presenceUri = identifier => '/fhir/Patient?' + new URLSearchParams({ identifier: identifier.system + '|' + identifier.value, _summary: 'count', _count: '0' });
            const present = await check('singleton-system-presence-no-compartment', presenceUri(patient), oneScope, { claims: presenceClaims('online-presence', patient) });
            assert.equal(present.total, 1); assert.deepEqual(present.entry || [], []);
            const batchScope = presenceScope([patient, missing]);
            const batch = await check('batch-independent-one-zero-counts', '/fhir/', batchScope, { method: 'POST', claims: presenceClaims('batch-presence', undefined, [patient, missing]),
                body: { resourceType: 'Bundle', type: 'batch', entry: [patient, missing].map(identifier => ({ request: { method: 'GET', url: presenceUri(identifier).slice('/fhir/'.length) } })) } });
            assert.deepEqual(batch.entry.map(entry => entry.resource.total), [1, 0]);
            await check('presence-contradictory-filter-denied', presenceUri(patient) + '&name=unrelated', oneScope, { claims: presenceClaims('online-presence', patient) }, 403);
            await maintenance('PUT', '/Patient/authorized-search-ambiguous', { resourceType: 'Patient', id: 'authorized-search-ambiguous', identifier: [patient], meta: { security: [demographics] } });
            try { await check('presence-ambiguous-identity-refused', presenceUri(patient), oneScope, { claims: presenceClaims('online-presence', patient) }, 403); }
            finally { await maintenance('DELETE', '/Patient/authorized-search-ambiguous'); }
            for (const i of [1, 2, 3]) await maintenance('PUT', '/Patient/authorized-search-dependent-' + i, { resourceType: 'Patient', id: 'authorized-search-dependent-' + i,
                identifier: [{ ...missing, value: String(100 + i) }], name: [{ text: 'Owned dependent ' + i }], address: [{ text: 'not projected' }], meta: { security: [demographics] } });
            for (const i of [1, 2, 3]) await maintenance('PUT', '/RelatedPerson/authorized-search-representative-' + i, { resourceType: 'RelatedPerson', id: 'authorized-search-representative-' + i,
                identifier: [i === 3 ? { ...representative, value: '222222' } : representative], patient: { reference: 'Patient/authorized-search-dependent-' + i }, active: true,
                relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'MTH' }] }],
                meta: { security: [demographics], tag: [{ system: 'http://fhir.health.gov.il/cs/il-hdp-resource-tags', code: 'hmo-dependent-discovery' }] } });
            // Discovery returns evidence and candidates. Eligibility must conjoin active and
            // relationship on one evidence record; independent rows cannot establish a decision.
            for (const [suffix, active, code] of [['inactive', false, 'MTH'], ['unmapped', true, 'UNKNOWN']]) {
                const id = 'authorized-search-split-' + suffix;
                await maintenance('PUT', '/RelatedPerson/' + id, { resourceType: 'RelatedPerson', id,
                    identifier: [representative], patient: { reference: 'Patient/authorized-search-dependent-3' }, active,
                    relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code }] }],
                    meta: { security: [demographics], tag: [{ system: 'http://fhir.health.gov.il/cs/il-hdp-resource-tags', code: 'hmo-dependent-discovery' }] } });
            }
            const discovery = { ...claims('dependent-discovery', 'dependent-discovery'), representative_identifier: representative };
            const targetUri = '/fhir/Patient?' + new URLSearchParams({ '_has:RelatedPerson:patient:identifier': representative.system + '|' + representative.value, _elements: 'identifier,name' });
            const found = await check('discovery-with-no-representative-patient-and-same-record-join', targetUri, discoveryScope(representative), { claims: discovery });
            assert.deepEqual(found.entry.map(entry => entry.resource.id).sort(), ['authorized-search-dependent-1', 'authorized-search-dependent-2', 'authorized-search-dependent-3']);
            assert.ok(found.entry.every(entry => entry.resource.address === undefined));
            const related = await check('discovery-related-person-projection', '/fhir/RelatedPerson?' + new URLSearchParams({ identifier: representative.system + '|' + representative.value, _elements: 'identifier,patient,active,relationship' }), discoveryScope(representative), { claims: discovery });
            assert.equal(related.entry.length, 4);
            const eligible = related.entry.map(entry => entry.resource).filter(resource => resource.active === true
                && resource.relationship.some(relationship => relationship.coding.some(coding => coding.code === 'MTH')));
            assert.deepEqual(eligible.map(resource => resource.patient.reference).sort(),
                ['Patient/authorized-search-dependent-1', 'Patient/authorized-search-dependent-2']);
            await check('discovery-contradictory-filter-denied', targetUri + '&name=unrelated', discoveryScope(representative), { claims: discovery }, 403);
            await maintenance('PUT', '/Patient/' + clinical, original);
        }
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
