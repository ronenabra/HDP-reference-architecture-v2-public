'use strict';
/** Closed master authoring and real issuance retain canonical and source authority. */
const test = require('node:test'), assert = require('node:assert/strict');
const { serviceDefinitionDraft: serviceDefinition, existingRegistration } = require('../src/service-definition-form');
const { compileConsentScope, defaultServiceScope } = require('../src/grant-compiler');
const { approvalScopeOptions } = require('../src/approval-scopes');
const { URL, TYPES, masterEnabled, masterExtension } = require('../../shared/service-master-data');
const { SYSTEM } = require('../../shared/service-confidentiality-policy');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');

/** Isolate a live canonical from a stale or forged provider copy. */
function fixture(enabled, allowRestricted = false) {
    const input = { ...structuredClone(require('../../../config/service-templates.json').templates[0].definition), includeMasterData: enabled, confidentialityPolicy: { allowRestricted } };
    const canonical = serviceDefinition(input), service = existingRegistration('canonical'), store = { get: () => canonical, privateRecords: { services: { getDefinition: () => ({ status: 'ok', ...require('../src/public-fhir').splitProduced(canonical).definition }) } } };
    const scope = defaultServiceScope(store, service);
    const compile = (requested = scope, approved = scope) => compileConsentScope({ store, service, scope: requested, approved,
        now: Date.parse('2026-11-07T12:00:00Z') / 1000, patient: { system: 'urn:patient', value: 'one' } });
    return { input, canonical, service, store, scope, compile };
}

test('off/omitted/legacy defaults and closed canonical metadata never manufacture authority', () => {
    for (const enabled of [false, undefined]) {
        const f = fixture(enabled); assert.equal(masterEnabled(f.canonical), false);
        assert.doesNotMatch(f.scope, /Organization|Practitioner/);
        f.service.extension.push(masterExtension(true));
        assert.throws(() => f.compile('patient/Organization.r'), /enabled/);
        f.canonical.extension = f.canonical.extension.filter(x => x.url !== URL);
        assert.equal(masterEnabled(f.canonical), false);
        assert.throws(() => f.compile('patient/Practitioner.r'), /enabled/);
    }
    for (const enabled of ['true', {}, ['Organization'], null]) assert.throws(() => fixture(enabled), /boolean/);
    const f = fixture(true);
    for (const bad of [{ url: URL, valueBoolean: true, actions: 'rs' }, { url: URL, valueString: 'true' }, { url: URL, valueBoolean: true, types: ['Patient'] }]) {
        assert.throws(() => lifecycle.classifyRegistrationRequest({ ...f.canonical, extension: f.canonical.extension.map(x => x.url === URL ? bad : x) }), /master/);
    }
    assert.throws(() => masterEnabled({ extension: [masterExtension(true), masterExtension(false)] }), /master/);
    assert.throws(() => lifecycle.classifyRegistrationRequest({ ...f.service, extension: [...f.service.extension, masterExtension(false)] }), /override/);
});

test('finite read grants have independent R/V policy without clinical bucket/history or Patient predicates', () => {
    for (const allowRestricted of [false, true]) {
        const f = fixture(true, allowRestricted), options = approvalScopeOptions(f.store, f.service);
        assert.deepEqual(TYPES, ['Organization', 'Practitioner', 'PractitionerRole', 'Location']);
        for (const approved of [f.scope, ...options.map(x => x.value)]) {
            const requested = [...new Set(approved.split(' ').map(x => x.split('?')[0]))].join(' ');
            const tokens = f.compile(requested, approved).split(' ');
            for (const type of TYPES) {
                const master = tokens.filter(x => x.startsWith(`patient/${type}.`)); assert.equal(master.length, 1);
                assert.ok(master[0].startsWith(`patient/${type}.r?`));
                assert.ok(master[0].includes(`_security:not=${SYSTEM}|V`));
                assert.equal(master[0].includes(`_security:not=${SYSTEM}|R`), !allowRestricted);
                assert.doesNotMatch(master[0], /identifier=|date=|information-buckets/);
            }
            assert.match(tokens[0], /identifier=urn:patient\|one/);
        }
        for (const requested of ['patient/Organization.s', 'patient/Practitioner.rs', 'system/Organization.r', 'patient/Location.s', 'patient/PractitionerRole.rs', 'patient/OrganizationAffiliation.r', 'patient/Patient.rs system/Organization.r', 'patient/*.r']) assert.throws(() => f.compile(requested));
        assert.throws(() => f.compile('patient/Organization.r', 'patient/Patient.rs'), /approved/);
        assert.throws(() => f.compile('patient/Organization.r', 'patient/Organization.rs'), /read only/);
        assert.match(f.compile('patient/Organization.r', `patient/Organization.r?_security:not=${SYSTEM}|R`), /\|R/);
    }
});

test('retired clinical override cannot remove master policy or synthesize a grant', () => {
    for (const enabled of [false, true]) {
        const f = fixture(enabled);
        for (const value of [false, true]) assert.throws(() => compileConsentScope({ store: f.store, service: f.service,
            scope: f.scope, approved: f.scope, now: 1, patient: { system: 'urn:patient', value: 'one' }, config: { sandbox: { grantFullClinicalAccess: value } } }), /retired/);
        assert.equal(defaultServiceScope(f.store, f.service).includes('patient/Organization.r'), enabled);
    }
});

test('explicit master approval owns exact authority independently of the service default and stays source/revocation bound in every preset', t => {
    for (const preset of require('../../shared/conformance-policy').PRESETS) {
    const f = require('../../../test-support/pcm-042-grants').grantHarness(preset);
    const v = `_security:not=${SYSTEM}|V`, exact = `patient/Patient.rs?${v} patient/Observation.rs?${v} patient/Organization.r?${v} patient/Practitioner.r?${v} patient/PractitionerRole.r?${v} patient/Location.r?${v}`;
    const consent = f.newDecision({ scope: exact });
    f.body.scope = 'patient/Patient.rs patient/Observation.rs patient/Organization.r patient/Practitioner.r patient/PractitionerRole.r patient/Location.r';
    f.body.authorization_details = require('../../../test-support/pcm-042-grants').requested('Consent', consent.identifier[0].value);
    const issued = f.issue(); assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(f.inspect(issued.body.access_token).body.scope, exact);
    assert.equal(f.inspect(issued.body.access_token, f.config.healthOrganizations[1].clientId).body.active, false);
    f.store.update({ ...f.store.get('Consent', consent.id), status: 'inactive' });
    assert.equal(f.inspect(issued.body.access_token).body.active, false); assert.equal(f.issue().status, 400);
    f.close();
    }
});


test('template setting uses the same canonical pipeline and appends only logical-ID examples', () => {
    const config = structuredClone(require('../../../config/service-templates.json'));
    config.templates[0].definition.includeMasterData = true;
    const template = require('../src/service-templates').validateTemplates(config)[0];
    assert.equal(template.privateDefinition.includeMasterData, true);
    assert.ok(template.scope.endsWith(TYPES.map(type => `patient/${type}.r`).join(' ')));
    const queries = template.request.extension.filter(x => x.url === EXTENSIONS.exampleQuery).map(x => x.valueString);
    for (const type of TYPES) {
        assert.ok(queries.includes(`GET [FHIR BASE]/${type}/[record-id]`));
        assert.equal(queries.some(x => x.startsWith(`GET [FHIR BASE]/${type}?`)), false);
    }
});


test('template matching preserves legacy off omission without hiding enabled-authority differences', () => {
    const { sameDefinition } = require('../src/service-templates');
    const f = fixture(false), legacy = structuredClone(f.canonical);
    legacy.extension = legacy.extension.filter(x => x.url !== URL);
    assert.equal(sameDefinition(legacy, f.canonical), true);
    const enabled = fixture(true).canonical;
    assert.equal(sameDefinition(enabled, f.canonical), false);
    assert.equal(sameDefinition(legacy, enabled), false);
    assert.equal(sameDefinition(enabled, enabled), true);
});


test('legacy source rejects both explicit master and ordinary clinical grants', t => {
    const f = require('../../../test-support/pcm-042-grants').grantHarness('connectathon-balanced'); t.after(f.close);
    const legacyId = f.config.organizations.referenceDataSource.id, v = `_security:not=${SYSTEM}|V`;
    for (const exact of [`patient/Patient.rs?${v} patient/Observation.rs?${v}`, `patient/Patient.rs?${v} patient/Organization.r?${v}`]) {
        const consent = f.newDecision({ scope: exact, sources: [f.source.dataSourceOrganization.id, legacyId] });
        f.body.scope = require('../../shared/service-grant').inspectScope(exact).requestCeiling;
        f.body.authorization_details = require('../../../test-support/pcm-042-grants').requested('Consent', consent.identifier[0].value);
        assert.equal(f.issue().status, 200);
        const denied = f.issue('consent-access', [], { endpoint: f.config.legacyDataSource.internalFhirBaseUrl });
        assert.equal(denied.status, 400); assert.equal(denied.body.error, 'invalid_scope'); assert.match(denied.body.error_description, /Legacy Node source/);
    }
});


test('generated mixed approval labels distinguish clinical search from master known-ID reads; off stays legacy', () => {
    for (const enabled of [true, false, undefined]) {
        const f = fixture(enabled), options = approvalScopeOptions(f.store, f.service).slice(1);
        for (const option of options) {
            assert.match(option.value, /patient\/Patient\.rs/);
            if (enabled) {
                assert.match(option.label, /service’s resource types|Service categories/);
                for (const type of TYPES) {
                    assert.match(option.value, new RegExp(`patient/${type}\\.r\\?`));
                    assert.doesNotMatch(option.value, new RegExp(`patient/${type}\\.rs|patient/${type}\\.r\\?[^ ]*information-buckets`));
                }
            } else {
                assert.doesNotMatch(option.label, /master|Organization|Practitioner|known logical ID/);
                assert.doesNotMatch(option.value, /Organization|Practitioner/);
            }
        }
        if (!enabled) assert.deepEqual(options.map(x => x.label), ['All records of the service’s resource types', 'Service categories with dates recalculated for this approval']);
    }
});

test('new generator defaults never rewrite or widen an old exact two-master approval', () => {
    const f = require('../../../test-support/pcm-042-grants').grantHarness('strict');
    try {
        const V = `_security:not=${SYSTEM}|V`, scope = ['Patient.rs','Organization.r','Practitioner.r'].map(value => `patient/${value}?${V}`).join(' ');
        const consent = f.newDecision({ scope }), before = JSON.stringify(f.store.privateRecords.approvals.getDecision(consent.id));
        f.body.authorization_details = require('../../../test-support/pcm-042-grants').requested('Consent', consent.identifier[0].value);
        f.body.scope = 'patient/Patient.rs patient/Organization.r patient/Practitioner.r';
        assert.equal(f.issue().body.scope, scope);
        serviceDefinition({ ...fixture(true).input });
        f.body.scope += ' patient/PractitionerRole.r patient/Location.r';
        const narrowed = f.issue(); assert.equal(narrowed.status, 200); assert.equal(narrowed.body.scope, scope);
        assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(consent.id)), before);
    } finally { f.close(); }
});
