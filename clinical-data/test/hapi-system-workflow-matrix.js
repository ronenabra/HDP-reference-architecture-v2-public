'use strict';

/** Native HAPI qualification with explicitly imported PCM-IG-042 workflow fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { request, expectDenied } = require('./hapi-authorization-matrix');
const { authenticationScope, discoveryScope } = require('./pcm-042-native-fixture');
const representative = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
const token = `${representative.system}|${representative.value}`;

/** Build the closed private context issued by the adapter for a system scenario. */
function claims(scenario) {
    const suffix = scenario === 'patient-authentication' ? 'PATIENT-AUTHENTICATION' : 'DEPENDENT-DISCOVERY';
    return {
        scenario, kind: scenario, consent_identifier: undefined, organization: undefined,
        patient_identifier: scenario === 'patient-authentication' ? representative : undefined,
        representative_identifier: scenario === 'dependent-discovery' ? representative : undefined,
        contract_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: `PCM-POLICY-${suffix}-001` },
        healthcare_service_identifier: undefined
    };
}

/** Exhaust both independent search streams and verify every returned resource's projection. */
async function pages(ho, type, query, scope, context) {
    let uri = `/fhir/${type}?${new URLSearchParams(query)}`;
    const resources = [];
    const seen = new Set();
    while (uri) {
        assert.ok(!seen.has(uri) && seen.size < 20, 'native pagination must terminate');
        seen.add(uri);
        const result = await request(ho, uri, scope, { claims: context });
        assert.equal(result.response.status, 200, `${ho} ${type}: ${result.text}`);
        assert.equal(result.body.type, 'searchset');
        for (const entry of result.body.entry || []) {
            assert.ok(entry.fullUrl.startsWith('http'), 'absolute fullUrl');
            assert.ok(entry.resource.meta?.versionId, 'ordinary metadata preserved');
            assert.equal(entry.resource.address, undefined, 'projection excludes address');
            assert.equal(entry.resource.telecom, undefined, 'discovery excludes contact');
            resources.push(entry.resource);
        }
        const next = result.body.link?.find(link => link.relation === 'next')?.url;
        if (!next) uri = null;
        else { const url = new URL(next); uri = `${url.pathname}${url.search}`; }
    }
    return { resources, pageCount: seen.size };
}

/** Exercise the exact reverse chain with omitted filters and independently paged evidence. */
async function main() {
    const scenarios = [];
    const authScope = authenticationScope;
    const authUri = `/fhir/Patient?${new URLSearchParams({ identifier: token, _elements: 'identifier,name,telecom,birthDate' })}`;
    const auth = await request('ho-a', authUri, authScope, { claims: claims('patient-authentication') });
    assert.equal(auth.response.status, 200, auth.text);
    assert.equal(auth.body.entry.length, 1);
    assert.equal(auth.body.entry[0].resource.birthDate, '1980-01-02');
    assert.ok(auth.body.entry[0].resource.telecom.length);
    assert.equal(auth.body.entry[0].resource.address, undefined);
    await expectDenied(await request('ho-a', '/fhir/Patient/representative-a', authScope, { claims: claims('patient-authentication') }), 'authentication cannot read');
    scenarios.push({ id: 'hapi-authentication-projection', status: 'pass', executed: true });
    const scope = discoveryScope(representative);
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        const context = claims('dependent-discovery');
        const patient = await pages(ho, 'Patient', { '_has:RelatedPerson:patient:identifier': token, _elements: 'identifier,name', _count: '1' }, scope, context);
        const related = await pages(ho, 'RelatedPerson', { identifier: token, _elements: 'identifier,patient,active,relationship', _count: '1' }, scope, context);
        assert.ok(patient.resources.length >= (ho === 'ho-c' ? 1 : 2) && patient.pageCount >= (ho === 'ho-c' ? 1 : 2), `${ho} Patient pagination`);
        assert.ok(related.resources.length >= 2 && related.pageCount >= 2, `${ho} RelatedPerson pagination`);
        assert.ok(related.resources.every(resource => resource.identifier.some(id => id.system === representative.system && id.value === representative.value)));
        const omitted = await request(ho, '/fhir/Patient?_elements=identifier,name&_count=1', scope, { claims: context });
        // The closed system-search request shape requires its exact identity filter.
        await expectDenied(omitted, `${ho} omitted discovery filter`);
        const batch = await request(ho, '/fhir', scope, { claims: context, method: 'POST', body: { resourceType: 'Bundle', type: 'batch', entry: [
            { request: { method: 'GET', url: `Patient?${new URLSearchParams({ '_has:RelatedPerson:patient:identifier': token, _elements: 'identifier,name' })}` } },
            { request: { method: 'GET', url: `RelatedPerson?${new URLSearchParams({ identifier: token, _elements: 'identifier,patient,active,relationship' })}` } }
        ] } });
        assert.equal(batch.response.status, 200, batch.text);
        assert.deepEqual(batch.body.entry.map(item => item.response.status.split(' ')[0]), ['200', '200']);
        await expectDenied(await request(ho, '/fhir/RelatedPerson?identifier=wrong', scope, { claims: context }), `${ho} changed filter`);
        await expectDenied(await request(ho, `/fhir/Patient/${patient.resources[0].id}`, scope, { claims: context }), `${ho} discovery read`);
        scenarios.push({ id: `hapi-discovery-${ho}`, status: 'pass', executed: true, patientPages: patient.pageCount, relationshipPages: related.pageCount });
    }
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify({ scenarios }, null, 2));
    console.log(JSON.stringify({ scenarios }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { claims, pages };
