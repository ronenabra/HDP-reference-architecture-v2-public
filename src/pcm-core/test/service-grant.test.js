'use strict';
/** Creation-fixed service grants: completeness, immutable storage and diagnostic overrides. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceDefinitionDraft: serviceDefinition, existingRegistration } = require('../src/service-definition-form');
const { previewDefinition } = require('../src/service-scope-authoring');
const { URL, MODEL, COMPILER, inspectScope, readServiceGrant, canonicalServiceGrant } = require('../../shared/service-grant');
const { SYSTEM } = require('../../shared/service-confidentiality-policy');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const { FHIRStore } = require('../src/fhir/store');
const now = Date.parse('2024-03-31T12:34:56Z') / 1000;
const excludeV = `_security:not=${SYSTEM}|V`;

/** Readable inputs deliberately independent of runtime Patient/source/Consent state. */
function draft(extra = {}) {
    return { name: 'Creation-fixed service', purpose: 'Review eligible records', category: '35',
        accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'mo', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }],
        scopeOrigin: 'generated', ...extra };
}

test('generated final scope includes complete Patient/master/confidentiality and independent bucket/history/sensitivity alternatives', () => {
    const request = serviceDefinition(draft({ includeMasterData: true, buckets: [
        { code: 'allergies', history: 1, historyUnit: 'mo', sensitivity: ['http://terminology.hl7.org/CodeSystem/v3-ActCode|HIV'] },
        { code: 'allergiesAndIntolerances', history: 2, historyUnit: 'a', sensitivity: [] }
    ], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'AllergyIntolerance', actions: 'rs' }] }), { now });
    const grant = readServiceGrant(request), parsed = inspectScope(grant.scope);
    assert.equal(grant.model, MODEL); assert.equal(grant.compiler, COMPILER);
    assert.equal(parsed.clauses.length, 8); // Patient + three complete clinical alternatives + four explicit masters.
    assert.deepEqual(grant.diagnostics, { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] });
    for (const clause of parsed.clauses) {
        assert.ok(clause.filters.includes(excludeV));
        assert.ok(clause.filters.includes(`_security:not=${SYSTEM}|R`));
        if (clause.type === 'AllergyIntolerance') {
            assert.ok(clause.filters.some(value => value.includes('il-hdp-information-buckets|')));
            assert.ok(clause.filters.some(value => value.startsWith('date=ge')));
        } else assert.ok(!clause.filters.some(value => /^(?:date|identifier)=/.test(value)));
    }
    assert.match(grant.scope, /date=ge2024-02-29T12:34:56.000Z/);
    assert.match(grant.scope, /date=ge2022-03-31T12:34:56.000Z/);
    assert.match(grant.scope, /patient\/Organization.r\?/); assert.match(grant.scope, /patient\/Practitioner.r\?/);
    assert.doesNotMatch(JSON.stringify(grant), /NOT-A-REAL-PATIENT|preview-only|identifier=/);
});

test('literal creation cutoffs and duration survive later reads, serialized restart and unchanged template reload', () => {
    const request = serviceDefinition(draft(), { now });
    const grant = readServiceGrant(request), first = previewDefinition(request);
    assert.equal(first.savedScope, grant.scope); assert.equal(first.effectiveScope, grant.scope);
    assert.equal(previewDefinition(JSON.parse(JSON.stringify(request)), { now: now + 86400 * 365 }).savedScope, grant.scope);
    const restored = JSON.parse(JSON.stringify(request));
    assert.deepEqual(readServiceGrant(restored), grant, 'private authoring draft roundtrip preserves literal dates');
    assert.throws(() => new FHIRStore().add(restored), /Private PCM metadata/);
    assert.equal(first.history.anchor, '2024-03-31T12:34:56.000Z');
    assert.deepEqual(first.access, { mode: 'continuous', duration: 6, unit: 'mo' });
    assert.equal(request.extension.some(item => item.valuePeriod), false);
    assert.ok(!Object.hasOwn(grant, 'expiresAt')); assert.ok(!Object.hasOwn(grant, 'validUntil'));
    const later = serviceDefinition(draft(), { now: now + 86400 });
    assert.notEqual(readServiceGrant(later).scope, grant.scope);
    assert.equal(require('../src/service-templates').sameDefinition(request, later), true, 'reuse existing definition; never regenerate its stored dates');
    const zero = readServiceGrant(serviceDefinition(draft({ buckets: [{ code: 'laboratoryTests', history: 0, historyUnit: 'a', sensitivity: [] }] }), { now }));
    assert.match(zero.scope, /date=ge2024-03-31T12:34:56.000Z/);
    for (const history of [-1, NaN, Infinity]) assert.throws(() => serviceDefinition(draft({ buckets: [{ code: 'laboratoryTests', history, historyUnit: 'a', sensitivity: [] }] }), { now }));
    assert.throws(() => serviceDefinition(draft(), { now: NaN }));
});

test('manual final text replaces generator axes and keeps exact literals and union alternatives', () => {
    const text = `  patient/Patient.rs?${excludeV}\n\tpatient/Encounter.s?status=finished&${excludeV} patient/Observation.r?date=ge2001-01-01&${excludeV}  `;
    const request = serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: text }), { now });
    const grant = readServiceGrant(request);
    assert.equal(grant.scope, text); assert.equal(grant.origin, 'custom');
    assert.deepEqual(grant.authoring.buckets, draft().buckets);
    assert.equal(grant.diagnostics.capability, 'unsupported', 'native parser does not yet qualify arbitrary exact whitespace');
    assert.equal(readServiceGrant(serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: text.trim().replace(/\s+/g, ' ') }), { now })).diagnostics.capability, 'supported');
    assert.equal(grant.diagnostics.applicability, 'valid');
    assert.equal(previewDefinition(request).savedScope, text);
    assert.doesNotMatch(grant.scope, /information-buckets|2024|\|R|sensitivity/);
    assert.equal(inspectScope(text).clauses.length, 3);
    assert.equal(require('../src/service-templates').sameDefinition(request,
        serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: text }), { now: now + 86400 })), true);
});

test('experimental text is lossless with separate syntax/applicability/source diagnostics and cannot authorize', () => {
    const { clinicalTokenFixture } = require('../../../test-support/clinical-token-fixture');
    const { rar } = require('../../../test-support/data-grants');
    const { URL: snapshotUrl } = require('../../shared/consent-scope-snapshot');
    const { PRESETS } = require('../../shared/conformance-policy');
    const { buildTeamConfig } = require('../../../test-support/team-config');
    const { resolveGrant } = require('../src/data-grant');
    const fixture = clinicalTokenFixture();
    const unsupported = `patient/Patient.rs?${excludeV} patient/DocumentReference.rs?${excludeV}&category=clinical-note`;
    const unproven = readServiceGrant(serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: unsupported }), { now }));
    assert.equal(unproven.scope, unsupported); assert.equal(unproven.diagnostics.syntax, 'valid');
    assert.equal(unproven.diagnostics.applicability, 'valid'); assert.equal(unproven.diagnostics.capability, 'unsupported');
    for (const [text, axis, expected = 'invalid'] of [[unsupported, 'capability', 'unsupported'], ['suspect scope', 'syntax'], [`patient/Patient.rs?${excludeV} patient/Observation.s?status=final,,preliminary&${excludeV}`, 'syntax'],
        ['patient/Patient.rs patient/Observation.s', 'applicability'], [`patient/Patient.rs?${excludeV} patient/Organization.rs?${excludeV}`, 'applicability'],
        [`patient/Patient.rs?identifier=urn:patient|1&${excludeV}`, 'applicability']]) {
        const request = serviceDefinition(draft({ scopeOrigin: 'custom', approvalScope: text }), { now });
        const grant = readServiceGrant(request);
        assert.equal(grant.scope, text);
        assert.equal(grant.diagnostics[axis], expected);
        const consent = fixture.approve(undefined, text);
        const snapshot = fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot;
        const bytes = JSON.stringify(snapshot);
        assert.equal(snapshot.scope, text);
        assert.deepEqual(snapshot.diagnostics, grant.diagnostics);
        assert.equal(snapshot.usable, false);
        for (const preset of PRESETS) {
            const config = buildTeamConfig({}, preset);
            assert.equal(resolveGrant({ ...fixture.request, config }).scope, fixture.scope, 'valid neighboring approval still authorizes');
            assert.throws(() => resolveGrant({ ...fixture.request, config,
                requested: rar('Consent', consent.identifier[0].value) }), /Approval scope is missing or unusable/);
            assert.equal(JSON.stringify(fixture.store.privateRecords.approvals.getDecision(consent.id).snapshot), bytes);
        }
    }
});

test('ordinary registration inherits canonical grant and forged metadata or material update cannot change it', async () => {
    const config = require('../../../test-support/team-config').buildTeamConfig();
    const store = new FHIRStore({ clock: () => new Date(now * 1000) });
    for (const resource of require('../src/bootstrap').buildSeedDrafts(config)) require('../src/public-fhir').publishNewResource(store, resource);
    const provider = store.get('Organization', config.organizations.serviceProvider.id);
    const command = require('../src/service-definition-form').serviceDefinitionCommand(draft(), { now });
    let id = 0;
    const created = lifecycle.registerHealthcareService({ store, callerOrganization: provider,
        request: command.resource, privateDefinition: command.definition, clock: () => new Date(now * 1000), idGenerator: () => `final-grant-${++id}` });
    const grant = store.privateRecords.services.getDefinition(created.canonical.id).grant;
    for (const anchor of [now - 901, now + 1]) {
        const stale = require('../src/service-definition-form').serviceDefinitionCommand(draft({ name: `Stale creation ${anchor}` }), { now: anchor });
        assert.throws(() => lifecycle.registerHealthcareService({ store, callerOrganization: provider,
            request: stale.resource, privateDefinition: stale.definition, clock: () => new Date(now * 1000) }), /anchor expired|future/);
    }
    assert.deepEqual(store.privateRecords.services.getDefinition(created.instance.id).grant, grant);
    const forged = structuredClone(created.instance);
    forged.extension.push({ url: URL, valueString: JSON.stringify({ ...grant, scope: 'patient/Patient.rs' }) });
    assert.deepEqual(canonicalServiceGrant(store, forged), grant);
    assert.throws(() => store.update(forged), /Private PCM metadata/);
    assert.throws(() => lifecycle.classifyRegistrationRequest({ ...existingRegistration(created.canonical.id), extension: [...existingRegistration(created.canonical.id).extension, forged.extension.at(-1)] }), /canonical|prohibited|not allowed|unsupported|override/i);
    const proposal = structuredClone(created.canonical);
    proposal.meta.profile = ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-catalog-update-proposal'];
    proposal.name = 'Non-material description edit';
    const body = { resourceType: 'Parameters', parameter: [{ name: 'proposedCatalog', resource: proposal }] };
    assert.doesNotThrow(() => lifecycle.requestCatalogUpdate({ store, callerOrganization: provider, targetId: proposal.id, body }));
    proposal.extension = proposal.extension.filter(item => item.url !== require('../../shared/pcm-contract').EXTENSIONS.informationBucket);
    assert.throws(() => lifecycle.requestCatalogUpdate({ store, callerOrganization: provider, targetId: proposal.id, body }), /material|new-service|informationBucket/i);
    const checkpoint = require('../src/migration-checkpoint'), saved = checkpoint.snapshot(store, { privateState: true });
    const restarted = new FHIRStore({ clock: () => new Date('2030-01-01T00:00:00Z') }); checkpoint.hydrate(restarted, saved);
    assert.deepEqual(restarted.privateRecords.services.getDefinition(created.canonical.id).grant, grant);
    assert.equal(readServiceGrant(restarted.get('HealthcareService', created.canonical.id)), null);
    delete restarted.privateState.services[`HealthcareService/${created.canonical.id}`];
    assert.throws(() => require('../src/public-fhir').assertRetainedCompatibility(restarted), /private authority/);
});
