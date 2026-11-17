'use strict';
/** Public-only selected-service facts keep descriptive settings separate from token authority. */
const test = require('node:test'), assert = require('node:assert/strict');
const { doctorPublicFixture } = require('../../../test-support/doctor-public-fixture');
const { serviceSummary, projectOwnedServices } = require('../src/service-directory');
const { permissionSummary } = require('../src/permission-plan');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const { render } = require('../../../test-support/doctor-ux-render');
/** Project only public resources, deliberately omitting all tags and owner extensions. */
function fixture() {
    const { canonical, instance, provider } = doctorPublicFixture();
    for (const item of [canonical, instance]) delete item.meta.tag;
    const project = () => projectOwnedServices({ entry: [canonical, instance].map(resource => ({ resource })) }, provider.id, provider)[0];
    return { canonical, instance, provider, project };
}
test('one public summary labels service history and duration without manufacturing record dates or grant', () => {
    const f = fixture(), summary = serviceSummary(f.project());
    assert.match(summary.data, /Laboratory tests, Medications — service categories/);
    assert.match(summary.history, /2 years/); assert.match(summary.history, /not granted record dates/);
    assert.match(summary.duration, /6 months.*approval may be shorter/);
    assert.equal(summary.access, 'Ongoing — service setting; PCM approval may narrow this to one-time');
    assert.equal(summary.grant, 'Granted permissions not yet obtained');
    assert.match(summary.restrictions, /Restricted \(R\).*Not provided by PCM/);
    assert.doesNotMatch(JSON.stringify(summary), /2024-|rolling|patient\/\*/);
});
test('missing optional descriptions and history remain usable, unknowns never become all access', () => {
    const f = fixture();
    delete f.canonical.extraDetails; delete f.instance.extraDetails;
    f.canonical.name = f.instance.name = 'FULL ACCESS TO EVERYTHING';
    f.canonical.extension = f.canonical.extension.filter(value => value.url !== EXTENSIONS.informationBucket);
    const service = f.project(), summary = serviceSummary(service);
    assert.equal(service.available, true); assert.equal(summary.purpose, 'Not provided by PCM');
    assert.equal(summary.data, 'Not provided by PCM'); assert.equal(summary.history, 'Not provided by PCM');
    assert.equal(summary.intent, 'patient/Patient.rs'); assert.equal(summary.grant, 'Granted permissions not yet obtained');
    assert.match(summary.restrictions, /Not provided by PCM/);
});
test('one-time start rule and public sensitivity settings do not assert sensitive inclusion or exclusion', () => {
    const f = fixture(); f.canonical.extension.find(value => value.url === EXTENSIONS.accessMode).valueCode = 'one-time';
    f.canonical.extension.find(value => value.url === EXTENSIONS.informationBucket).extension.push({ url: 'taggedDetails', valueCodeableConcept: { coding: [{ system: 'http://fhir.health.gov.il/cs/il-core-sensitivity-labels', code: 'mental-health' }] } });
    const summary = serviceSummary(f.project());
    assert.match(summary.access, /one hour per approved source.*first qualifying access check; issuing a token does not start/);
    assert.match(summary.sensitivity, /mental-health.*not granted permissions/);
    assert.match(summary.restrictions, /Not provided by PCM/);
});
test('literal fixed/no-cutoff, R/V exclusions and unsupported manual grants never change service summary', () => {
    const summary = serviceSummary(fixture().project()), original = structuredClone(summary);
    for (const [scope, usable] of [
        ['patient/Observation.s?date=ge2024-11-08&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|R,http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&_security:not=http://fhir.health.gov.il/cs/il-core-sensitivity-labels|mental-health', true],
        ['patient/Observation.rs', true], ['patient/*.rs', true], ['patient/Observation.s?unqualified=manual', false]
    ]) {
        const grant = permissionSummary(scope);
        assert.equal(grant.usable, usable); assert.equal(grant.scope, scope);
        assert.deepEqual(summary, original); assert.doesNotMatch(summary.history, /2024-11-08/);
        if (scope.includes('2024-11-08')) assert.equal(grant.clauses[0].filters[0], 'date=ge2024-11-08');
        if (scope === 'patient/Observation.rs') assert.deepEqual(grant.clauses[0].filters, []);
    }
});
test('provider-isolated equal names omit catalog, unassigned and foreign registrations', () => {
    const f = fixture(), other = structuredClone(f.instance); other.id = 'different-assignment'; other.providedBy.reference = 'Organization/other';
    const resources = [f.instance, other, f.canonical, { ...f.instance, id: 'unassigned', providedBy: undefined }];
    const bundle = { entry: resources.map(resource => ({ resource })) };
    assert.deepEqual(projectOwnedServices(bundle, f.provider.id, f.provider).map(service => service.id), [f.instance.id]);
    assert.deepEqual(projectOwnedServices(bundle, 'other', { ...f.provider, id: 'other' }).map(service => service.id), ['different-assignment']);
    assert.equal(projectOwnedServices(bundle, '', null).length, 0);
    assert.ok(projectOwnedServices(bundle, f.provider.id, { ...f.provider, active: false }).every(service => !service.available));
});
test('actual composer has one summary, one collapsed Service details, and separate contextual management', () => {
    const service = fixture().project(); service.summary = serviceSummary(service);
    const html = render(undefined, 'active', { consents: [], services: [service], selectedServiceId: service.id, manageServicesUrl: 'http://pcm.test/admin/services?providerRole=serviceProvider', serviceList: { complete: true, services: [service], refreshedAt: '2026-11-14T00:00:00Z' } });
    const composer = html.slice(html.indexOf('<form action="/doctor/create-consent"'), html.indexOf('<!-- LIST CONSENTS -->'));
    assert.equal((composer.match(/data-selected-service-summary/g) || []).length, 1);
    assert.equal((composer.match(/<details/g) || []).length, 1); assert.match(composer, /<details data-service-details[^>]*>/);
    assert.doesNotMatch(composer, /<details[^>]*\bopen|Loaded service purposes|Manage services|creation inputs|name="requestedScope"|name="scope"/);
    assert.ok(composer.indexOf('Maximum consent period') < composer.indexOf('Create consent request</button>'));
    assert.match(composer, /Services connected to Requesting application/);
    assert.doesNotMatch(html, /urn:pcm:sandbox:(?:service-grant|consent-scope-snapshot|service-authoring)/);
    assert.match(html.slice(html.indexOf('doctor-tools-panel'), html.indexOf('</nav>')), /Manage services in PCM/);
});


test('long purpose is compact with its complete public value and identifiers in Service details', () => {
    const f = fixture(); f.canonical.extraDetails = 'Complete public purpose '.repeat(30);
    f.instance.identifier[0].value = '000Long-ID-'.repeat(40);
    const summary = serviceSummary(f.project());
    assert.match(summary.purpose, /full purpose in Service details/);
    assert.equal(summary.fullPurpose, f.canonical.extraDetails);
    assert.ok(summary.identifiers.includes(f.instance.identifier[0].value));
    const service = f.project(); service.summary = summary;
    const html = render(undefined, 'active', { consents: [], services: [service], selectedServiceId: service.id });
    assert.ok(html.includes(f.instance.identifier[0].value));
});


test('public UCUM codes become readable periods without changing history or consent duration', () => {
    const f = fixture();
    const duration = f.canonical.extension.find(value => value.url === EXTENSIONS.accessDuration).valueDuration;
    delete duration.unit; duration.value = 1; duration.code = 'mo';
    const history = f.canonical.extension.find(value => value.url === EXTENSIONS.informationBucket).extension.find(value => value.url === 'historyDepth').valueDuration;
    delete history.unit;
    const summary = serviceSummary(f.project());
    assert.match(summary.duration, /^1 month — service maximum/);
    assert.match(summary.history, /Laboratory tests: 2 years/);
    assert.equal(duration.code, 'mo'); assert.equal(history.code, 'a');
});


test('already-read public provider name is kept separately from the requesting application label', () => {
    const f = fixture(); f.provider.name = 'Actual public provider';
    assert.equal(f.project().providerName, 'Actual public provider');
});
