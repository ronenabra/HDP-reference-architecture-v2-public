'use strict';
/** Actual EJS order, immutable contexts and semantic result states without a new policy interpreter. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { render } = require('../../../test-support/doctor-ux-render');
const { parseCatalog } = require('../../../scripts/generate-ui-help');
test('composer has one submitted patient value/type and no competing library/header/manual shortcut', () => {
    const html = render();
    const composer = html.slice(html.indexOf('<form action="/doctor/create-consent"'), html.indexOf('<!-- LIST CONSENTS -->'));
    assert.equal((composer.match(/name="patientId"/g) || []).length, 1); assert.equal((composer.match(/name="patientSystem"/g) || []).length, 1);
    assert.ok(composer.indexOf('data-patient-section') < composer.indexOf('Clinical service'));
    assert.ok(composer.indexOf('Clinical service') < composer.indexOf('Create consent request</button>'));
    assert.doesNotMatch(composer, /type="hidden" name="patientId"|Use ordinary CI patient|onchange=/);
    assert.doesNotMatch(html.slice(html.indexOf('<nav'), html.indexOf('</nav>')), /Patient library/);
    assert.match(html, /Name unknown \(ordinary demo patient\)/);
});

test('Doctor authors one header Explain control and distinct patient-mode panels', () => {
    const html = render();
    const navigation = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    assert.match(navigation, /class="explain-toggle"/);
    assert.match(navigation, /type="checkbox"[^>]*>\s*Explain this page/);
    assert.equal((html.match(/class="explain-toggle"/g) || []).length, 1);
    assert.match(html, /data-patient-mode="choose"[^>]*aria-controls="patient-choices"/);
    assert.match(html, /data-patient-mode="manual"[^>]*aria-controls="patient-manual"[^>]*>Enter identifier/);
    assert.match(html, /id="patient-choices"[^>]*data-patient-choices/);
    assert.match(html, /id="patient-manual"[^>]*data-patient-manual/);
    const modes = html.slice(html.indexOf('class="patient-modes"'), html.indexOf('id="patient-choices"'));
    assert.doesNotMatch(modes, /data-patient-library/);
    assert.match(html, /patient-section-heading[\s\S]*?data-patient-library/);
    assert.doesNotMatch(html, /<label[^>]*>Data types and actions to request<\/label>/);
});

test('empty and unknown patient renderings retain one exact editable identifier and honest names', () => {
    for (const selectedPatientId of ['', 'http://fhir.health.gov.il/identifier/il-national-id|000000026']) {
        const html = render(undefined, 'active', { patients: [], selectedPatientId });
        assert.match(html, /id="patient-id"[^>]*name="patientId"/);
        assert.match(html, /Keep leading zeros/);
        assert.match(html, /No sandbox GUID patients loaded/);
        assert.match(html, /Name unknown until a named choice is selected/);
        assert.equal((html.match(/name="patientId"/g) || []).length, 1);
    }
});
test('historical cards put source/query/fetch actions before bounded results and keep own context', () => {
    const html = render('unknown');
    const card = html.slice(html.indexOf('<!-- LIST CONSENTS -->'), html.indexOf('<!-- MANUAL SANDBOX CARD -->'));
    assert.match(card, /Historical service/); assert.match(card, /000000018/);
    assert.doesNotMatch(card, /000000026|different-composer-service/);
    assert.ok(card.indexOf('Check / Discover</button>') < card.indexOf('First-page preview'));
    assert.ok(card.indexOf('Intended selection') < card.indexOf('First-page preview'));
    assert.ok(card.indexOf('>Fetch data</button>') < card.indexOf('First-page preview'));
    assert.match(card, /Observation/); assert.match(card, /known record ID/);
    assert.match(card, /Request overrides/); assert.match(card, /Requested SMART scope/);
    assert.equal((card.match(/name="requestedScope"/g) || []).length, 1);
    assert.match(card, /Readable source/); assert.match(card, /View FHIR requests/);
});
test('bounded empty, partial, more and unknown states never imply clinical absence or changed approval', () => {
    for (const [outcome, phrase] of [['empty', 'Successful empty first page'], ['partial', 'Partial retrieval'], ['bounded', 'More results are indicated'], ['unknown', 'Additional results unknown'], ['complete', 'Known completed queries']]) {
        const html = render(outcome, 'rejected');
        assert.ok(html.includes(phrase), outcome); assert.match(html, /rejected/);
        assert.match(html, /not a complete clinical collection/); assert.match(html, /Up to 10 matching records per resource type/);
        assert.match(html, /Recorded: rejected/);
    }
});
test('authored/generated help matches current controls and preserves exact grant/time semantics', () => {
    const catalog = parseCatalog(fs.readFileSync(path.resolve(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));
    assert.doesNotMatch(catalog['common.explain'].body, /question.mark|tap.*adjacent action/);
    assert.match(catalog['common.explain'].body, /ordinary field|disabled control/);
    assert.match(catalog['doctor.request'].title, /Create consent request/);
    assert.match(catalog['doctor.discover'].title, /Check \/ Discover/);
    assert.match(catalog['doctor.reset'].body, /all requesting applications/);
    assert.match(catalog['doctor.reset'].body, /PCM Consent resources and source clinical data remain/);
    assert.match(catalog['doctor.saved-scope'].body, /token.response/);
    assert.match(catalog['demo.ceilings'].technical, /whole saved approval independently/);
    for (const key of ['doctor.create-section', 'doctor.tools', 'doctor.consents']) assert.doesNotMatch(catalog[key].body, /button below|Active Consents|Advanced tools|Reset All/);
});

test('manual System URI is independently labelled and preserves unsupported exact identity for correction', () => {
    const html = render(undefined, 'active', { selectedPatientId: 'urn:Unsupported:Case|00AbC' });
    assert.match(html, /Enter system URI manually…/);
    assert.match(html, /<label for="patient-system-uri"[^>]*[^<]*>System URI<\/label>/);
    assert.match(html, /id="patient-system-uri"[^>]*name="patientSystem"[^>]*value="urn:Unsupported:Case"/);
    assert.match(html, /id="patient-id"[^>]*value="00AbC"/);
    assert.match(html, /id="patient-system-feedback"[^>]*role="status"/);
    assert.match(html, /id="patient-resolved"[^>]*role="status"/);
    assert.match(html, /data-manual-system >/);
});


test('Approval details use labelled public facts and distinguish unavailable saved access from service and token', () => {
    const html = render();
    const section = html.slice(html.indexOf('<section aria-label="Consent and service">'), html.indexOf('<section aria-label="Token response"'));
    for (const label of ['Patient', 'Provider', 'Service', 'Consent status', 'Approval starts', 'Approval ends', 'Access mode', 'Recorded sources']) assert.ok(section.includes('<dt>' + label + '</dt>'), label);
    assert.match(section, /Saved approval access details are unavailable in Doctor/);
    assert.match(section, /Identifiers and service settings/);
    assert.match(section, /Open this Consent in PCM Consents/);
    assert.doesNotMatch(section, /Service categories\/history inputs|laboratoryTests: 2 a|patient\//);
});
