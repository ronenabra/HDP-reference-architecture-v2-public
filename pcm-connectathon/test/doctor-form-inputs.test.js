'use strict';

/** Exercise the actual Doctor EJS controls consumed by the ordinary sanity client. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { doctorServiceSelection, doctorConsentQuery } = require('../scripts/sanity-data-state');
const { clinicalTokenFixture, V } = require('../../test-support/clinical-token-fixture');
const { approvalPresentation } = require('../../src/sp-client/src/approval-presentation');
const { ORDINARY, identifierTypes } = require('../../src/sp-client/src/patient-choice');
const { FIXED } = require('../../src/shared/sandbox-patients');
const view = fs.readFileSync(path.resolve(__dirname, '../../src/sp-client/src/views/index.ejs'), 'utf8');
const config = { serviceCatalog: { bindings: [
    { application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'lab-a' },
    { application: 'doctor-b', providerRole: 'hospitalBServiceProvider', serviceKey: 'lab-follow-up', instanceId: 'lab-b' }
] } };
const stamp = 'a'.repeat(64);

/** Render real current controls; their saved approval belongs to the historical Consent. */
function render({ identity = 'hospital-a', services, flash = null } = {}) {
    const fixture = clinicalTokenFixture({ scope: `patient/Patient.rs?${V} patient/Observation.s?${V} patient/Condition.r?${V}` });
    const consent = fixture.approve({ system: ORDINARY.idSystem, value: ORDINARY.idValue });
    consent.id = 'created-consent';
    consent.discoveredEndpoint = 'https://ho.example/fhir';
    const owned = { id: identity === 'hospital-b' ? 'lab-b' : 'lab-a', signature: stamp, name: 'Owned registration', available: true, readiness: 'Ready to request' };
    return ejs.render(view, {
        teamId: 'form-inputs', browserBase: '/doctor', currentIdentity: identity, identities: [{ id: identity, label: 'Selected provider' }],
        publicBaseUrls: { pcmUi: 'http://pcm.test', spClient: 'http://doctor.test/doctor' }, flash,
        conformance: { mode: 'connectathon', resultLabel: 'NON-CONFORMANT SIMULATION', warnings: [] },
        services: services || [owned], selectedServiceId: '', selectedPatientId: `${ORDINARY.idSystem}|${ORDINARY.idValue}`,
        patients: [ORDINARY, ...FIXED], identifierTypes: identifierTypes(),
        consents: [{ id: consent.id, consent, service: owned, approval: approvalPresentation(consent, {}, { querySelection: 'patient/Patient.rs patient/Observation.s patient/Condition.r' }), data: null }]
    });
}

for (const identity of ['hospital-a', 'hospital-b']) {
    test(`current ${identity} form supplies its exact owned option stamp even before selection`, () => {
        const html = render({ identity });
        assert.match(html, /name="serviceStamp" value=""/);
        assert.deepEqual(doctorServiceSelection(html, config, identity), { serviceId: identity === 'hospital-b' ? 'lab-b' : 'lab-a', serviceStamp: stamp });
    });
}

const serviceCases = [
    ['missing composer', html => html.replace('/doctor/create-consent', '/doctor/other')],
    ['missing owned registration', html => html.replace('value="lab-a"', 'value="foreign"')],
    ['disabled registration', html => html.replace('value="lab-a"', 'value="lab-a" disabled')],
    ['missing option stamp', html => html.replace(`data-service-stamp="${stamp}"`, '')],
    ['disabled picker', html => html.replace('name="serviceId"', 'name="serviceId" disabled')],
    ['ambiguous registration', html => html.replace('</select>\n                                    <input type="hidden" name="serviceStamp"', `<option value="lab-a" data-service-stamp="${stamp}">Duplicate</option></select>\n                                    <input type="hidden" name="serviceStamp"`)],
    ['foreign provider form', html => html.replace(/name="identity" value="hospital-a"/g, 'name="identity" value="hospital-b"')],
    ['ambiguous composer', html => html + html]
];
for (const [name, change] of serviceCases) {
    test(`ordinary service selection rejects ${name}`, () => {
        assert.throws(() => doctorServiceSelection(change(render()), config, 'hospital-a'), /Doctor|registration/);
    });
}
test('diagnostic identities cannot borrow ordinary provider form stamps', () => {
    for (const identity of ['untrusted', 'untrusted-assertion', 'unknown']) {
        assert.throws(() => doctorServiceSelection(render(), config, identity), /ordinary provider/);
    }
});

test('created Consent query keeps its rendered source and complete saved query selection', () => {
    assert.deepEqual(doctorConsentQuery(render(), 'hospital-a', 'created-consent'), {
        endpointUrl: 'https://ho.example/fhir', requestedScope: 'patient/Patient.rs patient/Observation.s patient/Condition.r'
    });
});
test('rendered source attribute escapes are decoded once without changing its query bytes', () => {
    const html = render().replace(/https:\/\/ho.example\/fhir/g, 'https://ho.example/fhir?a=1&amp;b=2');
    assert.equal(doctorConsentQuery(html, 'hospital-a', 'created-consent').endpointUrl, 'https://ho.example/fhir?a=1&b=2');
});
const queryCases = [
    ['missing Consent', html => html.replace(/value="created-consent"/g, 'value="another-consent"')],
    ['disabled query', html => html.replace('name="requestedScope"', 'name="requestedScope" disabled')],
    ['missing query', html => html.replace('name="requestedScope"', 'name="retiredScope"')],
    ['empty query', html => html.replace('value="patient/Patient.rs patient/Observation.s patient/Condition.r"', 'value=""')],
    ['missing source', html => html.replace('value="https://ho.example/fhir" data-help-key="doctor.endpoint"', 'value="" data-help-key="doctor.endpoint"')],
    ['disabled fetch', html => html.replace('formaction="/doctor/fetch-data" class="btn btn-success"', 'formaction="/doctor/fetch-data" disabled class="btn btn-success"')],
    ['ambiguous Consent', html => html + html]
];
for (const [name, change] of queryCases) {
    test(`created Consent query rejects ${name}`, () => {
        assert.throws(() => doctorConsentQuery(change(render()), 'hospital-a', 'created-consent'), /Consent/);
    });
}
test('another provider cannot reuse the created Consent query form', () => {
    assert.throws(() => doctorConsentQuery(render(), 'hospital-b', 'created-consent'), /provider/);
});
