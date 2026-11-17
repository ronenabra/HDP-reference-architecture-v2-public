'use strict';
/** Exact atomic approval decisions, immutable store writes and source-only preservation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { versionDefinition, EXACT, V } = require('../../../test-support/consent-snapshot-fixture');
const { FHIRStore } = require('../src/fhir/store');
const { buildSeedResources } = require('../src/bootstrap');
const { approveConsent, createConsent } = require('../src/fhir/consent-lifecycle');
const { readApprovalSnapshot, URL } = require('../../shared/consent-scope-snapshot');
const { approvalScopeOptions, approvalReview } = require('../src/approval-scopes');
const { EXTENSIONS, IDENTIFIER_SYSTEMS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const clock = () => new Date('2026-11-08T12:00:00.000Z');

/** Build independent resources and create a real requested Consent. */
function fixture() {
    const config = buildTeamConfig({ serviceCatalog: { file: 'config/demo-services.json', bindings: [{ serviceKey: 'lab-follow-up', application: 'serviceProvider', providerRole: 'serviceProvider', instanceId: 'approval-lab-follow-up', instanceIdentifier: 'APPROVAL-LAB' }] } });
    const store = new FHIRStore({ clock });
    require('../src/bootstrap').buildSeedDrafts(config, {}, clock).forEach(item => require('../src/public-fhir').publishNewResource(store, item));
    require('../src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    versionDefinition(store);
    const sp = store.get('Organization', config.organizations.serviceProvider.id);
    const request = JSON.parse(require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
    request.patient.identifier = { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' };
    request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = 'HealthcareService/approval-lab-follow-up';
    const create = (patient = request.patient.identifier) => createConsent({ store, callerOrganization: sp, request: { ...request, patient: { identifier: patient } }, clock });
    return { config, store, create, consent: create(), service: store.get('HealthcareService', 'approval-lab-follow-up') };
}

for (const choice of ['service-provided', 'auto-resources', 'auto-buckets', 'custom']) test(`exact once-only ${choice} snapshot, explicit broad choice and literal provenance`, () => {
    const f = fixture(), options = approvalScopeOptions(f.store, f.service, { now: clock().getTime() / 1000 });
    const manual = `patient/Patient.rs?${V} patient/Encounter.s?status=finished&${V} patient/Observation.r?date=ge2001-01-01&${V}`;
    const saved = approveConsent({ ...f, scopeChoice: choice, customScope: manual, sourceOrganizationIds: [], clock });
    const snapshot = f.store.privateRecords.approvals.getDecision(saved.id).snapshot;
    assert.equal(snapshot.scope, choice === 'custom' ? manual : options.find(item => item.id === choice).value);
    assert.equal(snapshot.choice, choice); assert.equal(snapshot.usable, true);
    assert.equal(snapshot.approvedAt, saved.provision.period.start); assert.equal(snapshot.service.grant.scope, EXACT);
    assert.equal(snapshot.validity.mode, 'continuous'); assert.equal(snapshot.actor.simulation, true);
    if (choice === 'service-provided') { assert.match(snapshot.scope, /status=final/); assert.equal(snapshot.anchor, '2026-01-05T12:00:00.000Z'); }
    if (choice.startsWith('auto')) assert.doesNotMatch(snapshot.scope, /status=final/);
    if (choice === 'auto-buckets') assert.match(snapshot.scope, /date=ge2024-11-08T12:00:00.000Z/);
    if (choice === 'auto-resources') assert.doesNotMatch(snapshot.scope, /date=|information-buckets/);
    const bytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(saved.id).snapshot);
    const definition = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service)); definition.name = 'Changed template';
    require('../../../test-support/private-definition').replaceDefinition(f.store, definition, { ...snapshot.service.grant.authoring, approvalScope: EXACT.replace('status=final', 'status=preliminary') }, { now: Date.parse('2027-03-01T00:00:00Z') / 1000 });
    f.config.sandbox.grantFullClinicalAccess = true;
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(saved.id).snapshot), bytes);
    assert.deepEqual(JSON.parse(JSON.stringify(f.store.privateRecords.approvals.getDecision(saved.id).snapshot)), snapshot);
    assert.throws(() => approveConsent({ ...f, scopeChoice: 'custom', customScope: 'replacement', clock }), /changed/);
    assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(saved.id).snapshot), bytes);
});

test('empty/invalid/unsupported manual text remains exact and unusable, with no legacy broad fallback', () => {
    const f = fixture();
    for (const text of ['', '  suspect scope  ', `patient/Patient.rs?${V} patient/DocumentReference.s?${V}`, 'patient/Observation.rs']) {
        const consent = f.create();
        const saved = approveConsent({ ...f, consent, scopeChoice: 'custom', customScope: text, clock });
        assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.scope, text); assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.usable, false);
    }
    assert.equal(require('../src/data-sources').getApprovedTokenScope({ extension: [] }), '');
    const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service));
    delete f.store.privateState.services[`HealthcareService/${canonical.id}`];
    assert.throws(() => approveConsent({ ...f, consent: f.create(), clock }), /definition|authority|operational/i);

});

test('stale Consent/service review, duplicate decisions and rollback preserve the complete prior state', () => {
    const f = fixture(), review = approvalReview(f.store, f.consent, clock().toISOString());
    const service = f.store.get('HealthcareService', f.service.id); service.name = 'new version'; f.store.update(service);
    assert.throws(() => approveConsent({ ...f, review, clock }), /changed/);
    assert.deepEqual(f.store.get('Consent', f.consent.id), f.consent);
    const generations = [...f.store.authorityState.generations];
    const update = f.store.update.bind(f.store);
    f.store.update = resource => { update(resource); throw new Error('publication failed'); };
    assert.throws(() => approveConsent({ ...f, clock }), /publication failed/);
    assert.deepEqual(f.store.get('Consent', f.consent.id), f.consent);
    assert.deepEqual([...f.store.authorityState.generations], generations);
    f.store.update = update;
    const saved = approveConsent({ ...f, clock });
    assert.throws(() => approveConsent({ ...f, consent: saved, clock }), /Only a requested/);
    assert.equal(f.store.get('Consent', saved.id).meta.versionId, saved.meta.versionId);
});

test('synthetic approval records the same exact snapshot path and simulated actor', () => {
    const f = fixture();
    const saved = f.create({ system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' });
    assert.equal(saved.status, 'active'); assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.scope, EXACT);
    assert.deepEqual(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.actor, { id: 'synthetic-test-auto-approval', simulation: true });
});

test('direct helper/store replacement cannot change approved permissions, origin, service, period or mode', () => {
    const f = fixture(), saved = approveConsent({ ...f, clock });
    for (const mutate of [
        next => { next.extension.push({ url: SANDBOX_EXTENSIONS.approvedTokenScope, valueString: 'patient/Observation.rs' }); },
        next => { next.extension.push({ url: SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, valueString: 'generated: forged' }); },
        next => { next.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = 'HealthcareService/other'; },
        next => { next.provision.period.end = '2030-01-01T00:00:00Z'; },
        next => { next.category[0].coding[0].code = 'one-time'; },
        next => { next.extension.push({ url: URL, valueString: '{}' }); }
    ]) {
        const next = structuredClone(saved); mutate(next);
        assert.throws(() => f.store.update(next), /snapshot|read-only|private/i);
        assert.deepEqual(f.store.get('Consent', saved.id), saved);
        assert.throws(() => f.store.add(next), /snapshot|read-only|private/i);
    }
    assert.throws(() => require('../src/data-sources').setApprovedTokenScope(saved, 'patient/Observation.rs'), /read-only/);
});

test('issuer staging rejects missing and advisory authority even with every simulation check off', () => {
    const f = fixture(), { rar } = require('../../../test-support/data-grants');
    const client = { role: 'service-provider', organizationId: f.config.organizations.serviceProvider.id };
    const options = { store: f.store, config: { ...f.config, sandbox: { grantFullClinicalAccess: true } }, client,
        scope: 'patient/Observation.rs', resource: f.config.healthOrganizations[0].endpoint, now: clock().getTime() / 1000,
        firstUseStore: { get: () => null }, controls: { consentState: false, serviceState: false, tokenResourceBinding: false } };
    for (const consent of [f.consent, approveConsent({ ...f, scopeChoice: 'custom', customScope: '  unsupported  ', clock })]) {
        const result = require('../src/token-authorization').resolveDataSourceGrant({ ...options, requested: rar('Consent', consent.identifier[0].value) });
        assert.equal(result.error, 'invalid_scope'); assert.equal(result.diagnostic, 'approval-snapshot-unusable');
    }
});

test('source remove/readd preserves actual file-backed one-time deadlines and approval bytes', () => {
    const f = fixture(), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-snapshot-usage-'));
    try {
        const ids = f.config.healthOrganizations.map(source => source.dataSourceOrganization.id);
        const saved = approveConsent({ ...f, sourceOrganizationIds: [ids[0]], approvedAccessMode: 'one-time', clock });
        const windows = new (require('../src/state-store').FileFirstUseWindowStore)(directory);
        // Existing first-use semantics are unchanged until TOKEN-03 changes the key.
        const key = `${saved.id}\u0000${ids[0]}`;
        const started = windows.getOrStart(key, 3600, clock().getTime() / 1000);
        const files = fs.readdirSync(directory), before = files.map(file => fs.readFileSync(path.join(directory, file), 'utf8'));
        const bytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(saved.id).snapshot);
        for (const sourceOrganizationIds of [ids.slice(0, 2), [ids[1]], [], [ids[0]]]) {
            const current = f.store.get('Consent', saved.id);
            require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config,
                consentId: saved.id, expectedVersion: current.meta.versionId, sourceOrganizationIds, actor: 'operator', sessionId: 'owned-test', audit() {}, clock });
            const next = f.store.get('Consent', saved.id);
            assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(next.id).snapshot), bytes);
            assert.deepEqual(next.provision.period, saved.provision.period); assert.deepEqual(next.category, saved.category);
            assert.deepEqual(files.map(file => fs.readFileSync(path.join(directory, file), 'utf8')), before);
        }
        const reopened = new (require('../src/state-store').FileFirstUseWindowStore)(directory);
        assert.equal(reopened.getOrStart(key, 3600, started.expiresAt + 60).expiresAt, started.expiresAt);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing/malformed service metadata and expired/forged reviews fail without an approval mutation', () => {
    for (const scenario of ['missing-service', 'missing-canonical', 'malformed-grant', 'expired-review', 'forged-review']) {
        const f = fixture(), review = approvalReview(f.store, f.consent, clock().toISOString());
        if (scenario === 'missing-service') f.store.data.HealthcareService.delete(f.service.id);
        if (scenario === 'missing-canonical') f.store.data.HealthcareService.delete(require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service));
        if (scenario === 'malformed-grant') {
            const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service));
            f.store.privateState.services[`HealthcareService/${canonical.id}`].versions[f.store.privateState.services[`HealthcareService/${canonical.id}`].currentVersion].grant = { malformed: true };
        }
        if (scenario === 'forged-review') review.proof = 'x'.repeat(review.proof.length);
        assert.throws(() => approveConsent({ ...f, review, clock: scenario === 'expired-review' ? () => new Date(clock().getTime() + 900001) : clock }), /operational|grant|expired|changed|definition/i);
        assert.deepEqual(f.store.get('Consent', f.consent.id), f.consent, scenario);
    }
    for (const customScope of ['x'.repeat(16385), ['patient/Observation.rs']]) {
        const f = fixture(); assert.throws(() => approveConsent({ ...f, scopeChoice: 'custom', customScope, clock }), /text, at most 16384/);
        assert.deepEqual(f.store.get('Consent', f.consent.id), f.consent);
    }
    const invalid = fixture(), raw = 'control\u0001';
    const saved = approveConsent({ ...invalid, scopeChoice: 'custom', customScope: raw, clock });
    const decision = invalid.store.privateRecords.approvals.getDecision(saved.id).snapshot;
    assert.equal(decision.scope, raw); assert.equal(decision.usable, false);
    assert.equal(decision.diagnostics.syntax, 'invalid', 'lossless experimental text never becomes executable authority');
});

test('supported explicit approval remains selectable when the saved service default is experimental', () => {
    const f = fixture();
    const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service));
    const grant = require('../../shared/service-grant').canonicalServiceGrant(f.store, f.service);
    require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, { ...grant.authoring, approvalScope: 'experimental scope' }, { now: Date.parse(grant.anchor) / 1000 });
    const saved = approveConsent({ ...f, scopeChoice: 'auto-resources', clock });
    assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.usable, true);
    assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.service.grant.diagnostics.syntax, 'invalid');
    assert.doesNotMatch(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.scope, /experimental/);
});

test('serialized private checkpoint restores the exact decision under a future clock without recompilation', () => {
    const f = fixture(), saved = approveConsent({ ...f, scopeChoice: 'custom', customScope: `patient/Patient.rs?${V} patient/Observation.s?date=ge2001-01-01&${V}`, clock });
    const checkpoint = require('../src/migration-checkpoint');
    const state = checkpoint.snapshot(f.store, { privateState: true });
    const restored = new FHIRStore({ clock: () => new Date('2030-01-01T00:00:00Z') });
    checkpoint.hydrate(restored, JSON.parse(JSON.stringify(state)));
    assert.deepEqual(restored.privateRecords.approvals.getDecision(saved.id).snapshot, f.store.privateRecords.approvals.getDecision(saved.id).snapshot);
    assert.equal(readApprovalSnapshot(restored.get('Consent', saved.id)), null);
});

test('saved generated default retains creation dates while an explicit bucket alternative freezes fresh approval dates', () => {
    const f = fixture();
    const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service));
    const original = require('../../shared/service-grant').canonicalServiceGrant(f.store, f.service);
    const input = { ...original.authoring, scopeOrigin: 'generated' }; delete input.approvalScope;
    require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, input, { now: Date.parse(original.anchor) / 1000 });
    const defaultDecision = f.store.privateRecords.approvals.getDecision(approveConsent({ ...f, clock }).id).snapshot;
    const freshDecision = f.store.privateRecords.approvals.getDecision(approveConsent({ ...f, consent: f.create(), scopeChoice: 'auto-buckets', clock }).id).snapshot;
    assert.match(defaultDecision.scope, /date=ge2024-01-05T12:00:00.000Z/);
    assert.match(freshDecision.scope, /date=ge2024-11-08T12:00:00.000Z/);
    assert.equal(defaultDecision.historyMode, 'creation-fixed'); assert.equal(freshDecision.historyMode, 'approval-fixed');
    assert.equal(defaultDecision.scope, require('../../shared/service-grant').canonicalServiceGrant(f.store, f.service).scope);
});
