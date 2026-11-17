'use strict';
/** Shared syntax diagnostics remain distinct from authoring choices and backend capability. */
const test = require('node:test'), assert = require('node:assert/strict');
const { serviceDefinitionDraft: serviceDefinition } = require('../src/service-definition-form');
const { previewDefinition } = require('../src/service-scope-authoring');
const { readServiceGrant } = require('../../shared/service-grant');
const { SYSTEM } = require('../../shared/service-confidentiality-policy');
const { PRESETS } = require('../../shared/conformance-policy');
const { buildTeamConfig } = require('../../../test-support/team-config');
/** Build readable categories without coupling manual scope to their generated mapping. */
function draft(extra = {}) { return { name: 'Scope authoring', purpose: 'Review', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
    buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'mo', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 'rs' }], ...extra }; }
/** Independent expected R4/native intersection; shared by actual-route regressions. */
const predicateResources = [
    ['Observation', 'laboratoryTests', 'date', ['status', 'category', 'code']],
    ['DiagnosticReport', 'laboratoryTests', 'date', ['status', 'category', 'code']],
    ['MedicationRequest', 'medications', 'authoredon', ['status', 'category', 'code']],
    ['MedicationStatement', 'medications', 'effective', ['status', 'category', 'code']],
    ['MedicationAdministration', 'medications', 'effective-time', ['status', 'code']],
    ['MedicationDispense', 'medications', 'whenhandedover', ['status', 'code']],
    ['Procedure', 'procedures', 'date', ['status', 'category', 'code']],
    ['Condition', 'diagnoses', 'recorded-date', ['category', 'code']],
    ['AllergyIntolerance', 'allergiesAndIntolerances', 'date', ['category', 'code']],
    ['Encounter', 'encounterInformation', 'date', ['status']],
    ['Immunization', 'immunizations', 'date', ['status']]
];
const malformedPredicates = ['code=http://loinc.org|1234-5|extra', 'status=final,,preliminary', 'code=1234-5,', 'code=,1234-5', 'code=|1234-5', 'code=http://loinc.org|'];
/** Build one resource draft without introducing permissions beyond its selected bucket. */
function predicateDraft(type, bucket, predicate) {
    return draft({ buckets: [{ code: bucket, history: 1, historyUnit: 'mo', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type, actions: 'rs' }], scopeOrigin: 'custom',
        approvalScope: `patient/Patient.rs?_security:not=${SYSTEM}|V patient/${type}.s?${predicate}&_security:not=${SYSTEM}|V` });
}
test('all native malformed token members have syntax diagnostics without destroying exact text', () => {
    for (const predicate of malformedPredicates) {
        const input = predicateDraft('Observation', 'laboratoryTests', predicate);
        const grant = readServiceGrant(serviceDefinition(input));
        assert.equal(grant.scope, input.approvalScope); assert.equal(grant.diagnostics.syntax, 'invalid');
    }
});
test('all 33 resource-token combinations and mapped dates distinguish syntax from native support', () => {
    for (const [type, bucket, date, supported] of predicateResources) {
        for (const name of ['status', 'category', 'code']) {
            const input = predicateDraft(type, bucket, `${name}=http://loinc.org|1234-5,other`);
            const preview = previewDefinition(serviceDefinition(input));
            assert.equal(preview.savedScope, input.approvalScope); assert.equal(readServiceGrant(serviceDefinition(input)).diagnostics.syntax, 'valid');
            assert.equal(readServiceGrant(serviceDefinition(input)).diagnostics.capability, supported.includes(name) ? 'supported' : 'unsupported', `${type}.${name}`);
            assert.equal(preview.requestCeiling, null, 'manual advice does not derive an executable ceiling');
        }
        assert.equal(readServiceGrant(serviceDefinition(predicateDraft(type, bucket, `${date}=ge2024-02-29`))).diagnostics.syntax, 'valid');
        const wrongDate = date === 'date' ? 'effective' : 'date';
        assert.equal(readServiceGrant(serviceDefinition(predicateDraft(type, bucket, `${wrongDate}=ge2024-02-29`))).diagnostics.capability, 'unsupported');
    }
});
test('invalid dates retain an actionable syntax diagnostic and presets cannot replace a saved preview', () => {
    const input = predicateDraft('Observation', 'laboratoryTests', 'date=ge2024-02-30');
    const request = serviceDefinition(input);
    assert.equal(readServiceGrant(request).diagnostics.syntax, 'invalid');
    for (const preset of PRESETS) {
        assert.deepEqual(previewDefinition(request, { config: buildTeamConfig({}, preset) }), previewDefinition(request));
    }
    const generated = serviceDefinition(draft({ confidentialityPolicy: { allowRestricted: true } }));
    assert.doesNotMatch(readServiceGrant(generated).scope, /v3-Confidentiality\|R/);
    assert.match(readServiceGrant(generated).scope, /v3-Confidentiality\|V/);
});

test('native dollar-value rejection preserves valid URI syntax and exact manual scope with unsupported diagnostics', () => {
    const { clinicalTokenFixture } = require('../../../test-support/clinical-token-fixture');
    const { rar } = require('../../../test-support/data-grants');
    const { URL: snapshotUrl } = require('../../shared/consent-scope-snapshot');
    const { resolveGrant } = require('../src/data-grant');
    const fixture = clinicalTokenFixture();
    const v = `_security:not=${SYSTEM}|V`;
    for (const name of ['_security', '_security:not']) {
        const text = `patient/Patient.rs?${v} patient/Observation.s?${name}=urn:example:dollar$system|A&${v}`;
        const request = serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: text }));
        const grant = readServiceGrant(request);
        assert.equal(grant.scope, text);
        assert.equal(grant.authoring.approvalScope, text);
        assert.equal(grant.diagnostics.syntax, 'valid');
        assert.equal(grant.diagnostics.applicability, 'valid');
        assert.equal(grant.diagnostics.capability, 'unsupported');
        assert.ok(grant.diagnostics.issues.some(message => message.includes('rejects dollar ($)')));
        assert.equal(previewDefinition(request).savedScope, text);
        const consent = fixture.approve(undefined, text);
        const snapshot = fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot;
        const bytes = JSON.stringify(snapshot);
        assert.equal(snapshot.scope, text);
        assert.deepEqual(snapshot.diagnostics, grant.diagnostics);
        assert.equal(snapshot.usable, false);
        const neighbor = serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: text.replace('$', '') }));
        assert.equal(readServiceGrant(neighbor).diagnostics.capability, 'supported', 'unchanged valid URI neighbor stays supported');
        const neighborConsent = fixture.approve(undefined, readServiceGrant(neighbor).scope);
        assert.equal(fixture.store.privateRecords.approvals.getDecision(neighborConsent.id).snapshot.usable, true);
        for (const preset of PRESETS) {
            const config = buildTeamConfig({}, preset);
            assert.throws(() => resolveGrant({ ...fixture.request, config,
                requested: rar('Consent', consent.identifier[0].value) }), /Approval scope is missing or unusable/);
            assert.equal(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot), bytes);
            assert.equal(resolveGrant({ ...fixture.request, config,
                requested: rar('Consent', neighborConsent.identifier[0].value) }).scope, readServiceGrant(neighbor).scope);
        }
    }
});
module.exports = { draft, predicateResources, malformedPredicates, predicateDraft };


test('manual authoring offers bounded lexical advice only and never requires a successful compiler preview', () => {
    const { advisoryScope } = require('../src/service-scope-authoring');
    for (const text of ['  malformed experimental text\n\t  ', 'patient/DocumentReference.rs?experimental=unusual%20value', 'patient/Encounter.s?status=finished', '   ', 'patient/Encounter.s?code=שלום', '\u0000']) {
        const input = draft({ scopeOrigin: 'custom', approvalScope: text });
        const preview = previewDefinition(serviceDefinition(input));
        assert.equal(preview.savedScope, text);
        assert.deepEqual(preview.diagnostics, advisoryScope(text));
        assert.deepEqual(Object.keys(preview.diagnostics).sort(), ['issues', 'syntax']);
        assert.equal(readServiceGrant(serviceDefinition(input)).authoring.approvalScope, text);
    }
    assert.ok(advisoryScope('bad '.repeat(3000)).issues.length <= 8);
    for (const text of ['', 'x'.repeat(16385)]) assert.throws(() => advisoryScope(text), /Scopes require/);
});
