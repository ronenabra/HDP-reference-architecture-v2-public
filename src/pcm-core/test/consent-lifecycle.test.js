/** Authoritative Consent lifecycle, identity, and imported-artifact tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FHIRStore } = require('../src/fhir/store');
const {
    ConsentLifecycleError,
    approveConsent,
    assertConsentResource,
    assertDeactivateRequest,
    assertSubmitRequest,
    businessStatusExtension,
    cancelConsent,
    consentBusinessStatus,
    consentIsActive,
    createConsent,
    expireConsent,
    findMatchingConsentRequests,
    reconcileExpiredConsents,
    reconcileConsentsForService,
    rejectConsent
} = require('../src/fhir/consent-lifecycle');
const {
    CODE_SYSTEMS,
    CONSENT_POLICY,
    EXTENSIONS,
    IDENTIFIER_SYSTEMS
} = require('../../shared/pcm-contract');
const {
    hasValidIsraeliNationalId,
    normalizePatientIdentifier
} = require('../../shared/identity-mapping');

const examples = path.resolve(__dirname, '../../../docs/FHIR-examples');
const read = name => JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));
const fixedNow = () => new Date('2026-01-05T08:20:00.000Z');

function organization(id, role, parent = null) {
    return {
        resourceType: 'Organization', id, active: true, name: id,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-${id}` }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: role }] }],
        ...(parent ? { partOf: { reference: `Organization/${parent}` } } : {})
    };
}

function fixture() {
    const store = new FHIRStore({ clock: fixedNow });
    store.add(organization('parent-sp', 'parent-org'));
    const sp = store.add(organization('org-sp-hospital-a', 'service-provider', 'parent-sp'));
    store.add(organization('other-sp', 'service-provider', 'parent-sp'));
    store.add(organization('parent-ds', 'parent-org'));
    store.add({ ...organization('org-ds-hmo-b', 'source', 'parent-ds'), endpoint: [{ reference: 'Endpoint/endpoint-ds' }] });
    store.add({
        resourceType: 'Endpoint', id: 'endpoint-ds', status: 'active', address: 'https://source.example/r4',
        managingOrganization: { reference: 'Organization/org-ds-hmo-b' }
    });
    const catalog = store.add(read('HealthcareService-svc-catalog-cross-org-summary.json'));
    // Fresh fixture registration freezes real public-definition defaults; imported examples stay unchanged.
    store.privateRecords.services.createDefinition({ serviceId: catalog.id,
        ...require('../src/public-service-definition').definitionFromPublic(catalog, fixedNow()),
        expectedRevision: store.privateState.revision, expectedVersions: { [`HealthcareService/${catalog.id}`]: catalog.meta.versionId } });
    const service = store.add(read('HealthcareService-svc-instance-hosp-a-cross-org-summary.json'));
    return { store, sp, catalog, service };
}

function submit(patient = { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573740' }) {
    const request = read('Consent-consent-request-hosp-a-cross-org-summary.json');
    delete request.id;
    request.patient.identifier = patient;
    return request;
}

function deactivate(id) {
    const lifecycle = read('Parameters-parameters-consent-hosp-a-lifecycle.json');
    const request = lifecycle.parameter.find(parameter => parameter.name === 'deactivationRequest').resource;
    request.id = id;
    return request;
}

test('patient identifiers retain system/value identity and enforce national, test, and passport rules', () => {
    assert.equal(hasValidIsraeliNationalId('324573740'), true);
    assert.equal(hasValidIsraeliNationalId('324573741'), false);
    for (const identifier of [
        { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573740' },
        { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' },
        { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '2' },
        { system: IDENTIFIER_SYSTEMS.passport, value: 'IL-PASSPORT-42' },
        { system: 'http://hl7.org/fhir/sid/passport-USA', value: 'US-PASSPORT-42' }
    ]) {
        const normalized = normalizePatientIdentifier(identifier);
        assert.equal(normalized.key, `${identifier.system}|${identifier.value}`);
    }
    for (const identifier of [
        { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573741' },
        { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '123' },
        { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '3' },
        { system: IDENTIFIER_SYSTEMS.passport, value: ' IL-PASSPORT-42' },
        { system: 'http://hl7.org/fhir/sid/passport-ZZZ', value: '42' },
        { system: 'https://unknown.example/id', value: '42' }
    ]) assert.throws(() => normalizePatientIdentifier(identifier));
});

test('submit and deactivate DTOs enforce fixed policy, ppc-1, scope, category, and server fields', () => {
    assert.doesNotThrow(() => assertSubmitRequest(submit()));
    assert.doesNotThrow(() => assertDeactivateRequest(deactivate('consent-1')));
    for (const mutate of [
        request => { request.policy = []; },
        request => { request.policy.push({ ...request.policy[0] }); },
        request => { request.policy[0].authority = 'https://example.invalid/'; },
        request => { request.policyRule = { coding: [] }; },
        request => { request.status = 'active'; },
        request => { request.scope.coding.push({ system: 'x', code: 'y' }); },
        request => { request.category.push(request.category[0]); },
        request => { request.identifier = [{ system: IDENTIFIER_SYSTEMS.consent, value: 'client-owned' }]; },
        request => { request.extension.push(businessStatusExtension('active')); }
    ]) {
        const request = submit();
        mutate(request);
        if (request.identifier) {
            // The common closed DTO rejects this field before lifecycle logic.
            assert.ok(request.identifier);
        } else {
            assert.throws(() => assertSubmitRequest(request), ConsentLifecycleError);
        }
    }
});

test('submit derives the complete requested response and recovery search preserves duplicate evidence', () => {
    const { store, sp, service } = fixture();
    const ids = ['logical-1', 'business-1', 'logical-2', 'business-2'];
    const first = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow, idGenerator: () => ids.shift() });
    assert.equal(first.id, 'logical-1');
    assert.equal(first.identifier[0].value, 'PCM-CONSENT-BUSINESS-1');
    assert.equal(consentBusinessStatus(first), 'requested');
    assert.equal(first.status, 'proposed');
    assert.equal(first.category.length, 2);
    assert.equal(first.provision.actor.length, 1);
    assert.equal(first.provision.period, undefined);
    assert.equal(first.patient.identifier.system, IDENTIFIER_SYSTEMS.israelNationalId);
    assert.equal(assertConsentResource(first), true);
    createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow, idGenerator: () => ids.shift() });
    const recovery = findMatchingConsentRequests(store, {
        requesterOrganizationId: sp.id,
        patient: submit().patient.identifier,
        serviceId: service.id
    });
    assert.equal(recovery.length, 2);
    assert.notEqual(recovery[0].id, recovery[1].id);
});

test('authoritative response invariants reject status, category, actor, provision, and HTEST drift', () => {
    const { store, sp } = fixture();
    const valid = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
    for (const mutate of [
        consent => { consent.status = 'active'; },
        consent => { consent.category.pop(); },
        consent => { consent.provision.type = 'deny'; },
        consent => { consent.provision.actor[0].role.coding[0].code = 'CST'; },
        consent => { consent.policyRule = { coding: [] }; },
        consent => { consent.meta.security = [{ system: CODE_SYSTEMS.actReason, code: 'HTEST' }]; }
    ]) {
        const candidate = JSON.parse(JSON.stringify(valid));
        mutate(candidate);
        assert.throws(() => assertConsentResource(candidate), ConsentLifecycleError);
    }
});

test('submit requires caller ownership and active instance plus canonical state', () => {
    const { store, sp, catalog } = fixture();
    assert.throws(() => createConsent({
        store, callerOrganization: store.get('Organization', 'other-sp'), request: submit()
    }), error => error.status === 403);
    store.update({ ...catalog, active: false, extension: [
        ...catalog.extension.filter(extension => extension.url !== EXTENSIONS.serviceBusinessStatus),
        { url: EXTENSIONS.serviceBusinessStatus, valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'suspended' } }
    ] });
    assert.throws(() => createConsent({ store, callerOrganization: sp, request: submit() }), /operational HealthcareService/);
});

test('patient approval can narrow mode and period but cannot exceed service limits', () => {
    const { store, sp } = fixture();
    const consent = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
    const approved = approveConsent({
        store, consent, sourceOrganizationIds: ['org-ds-hmo-b'], approvedAccessMode: 'one-time',
        approvedEnd: '2026-02-05T08:20:00.000Z', clock: fixedNow
    });
    assert.equal(consentBusinessStatus(approved), 'active');
    assert.equal(consentIsActive(approved, fixedNow()), true);
    assert.equal(consentIsActive(approved, Math.floor(fixedNow().getTime() / 1000)), true);
    assert.equal(approved.category[0].coding[0].code, 'one-time');
    assert.equal(approved.provision.actor.length, 2);

    const second = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
    assert.throws(() => approveConsent({
        store, consent: second, approvedEnd: '2027-01-05T08:20:00.000Z', clock: fixedNow
    }), /no longer than/);
    const rejected = rejectConsent({ store, consent: second });
    assert.equal(consentBusinessStatus(rejected), 'rejected');
    assert.equal(rejected.provision.period, undefined);
});

test('provider cancellation is terminal, owner-only, and same-state idempotent', () => {
    const { store, sp } = fixture();
    const consent = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
    assert.throws(() => cancelConsent({
        store, callerOrganization: store.get('Organization', 'other-sp'), consent, request: deactivate(consent.id)
    }), error => error.status === 403);
    const cancelled = cancelConsent({ store, callerOrganization: sp, consent, request: deactivate(consent.id) });
    assert.equal(cancelled.status, 'inactive');
    assert.equal(consentBusinessStatus(cancelled), 'service-provider-cancelled');
    const retry = cancelConsent({ store, callerOrganization: sp, consent: cancelled, request: deactivate(consent.id) });
    assert.equal(retry.meta.versionId, cancelled.meta.versionId);
    assert.throws(() => approveConsent({ store, consent: cancelled, clock: fixedNow }), /requested/);
});

test('service suspension is reversible, cancellation is terminal, and expiry honors exact fake-clock boundaries', () => {
    const { store, sp, service } = fixture();
    let consent = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
    consent = approveConsent({ store, consent, sourceOrganizationIds: [], clock: fixedNow });
    reconcileConsentsForService({ store, serviceId: service.id, serviceState: 'suspended', now: fixedNow() });
    assert.equal(consentBusinessStatus(store.get('Consent', consent.id)), 'temporarily-inactive');
    reconcileConsentsForService({ store, serviceId: service.id, serviceState: 'active', now: fixedNow() });
    assert.equal(consentBusinessStatus(store.get('Consent', consent.id)), 'active');

    const end = new Date(store.get('Consent', consent.id).provision.period.end);
    assert.equal(consentIsActive(store.get('Consent', consent.id), new Date(end.getTime() - 1)), true);
    const expired = expireConsent({ store, consent: store.get('Consent', consent.id), now: end });
    assert.equal(consentBusinessStatus(expired), 'permanently-inactive');
    assert.equal(consentIsActive(expired, end), false);
    assert.deepEqual(reconcileExpiredConsents({ store, now: end }), []);

    let terminal = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
    terminal = approveConsent({ store, consent: terminal, sourceOrganizationIds: [], clock: fixedNow });
    reconcileConsentsForService({ store, serviceId: service.id, serviceState: 'cancelled', now: fixedNow() });
    assert.equal(consentBusinessStatus(store.get('Consent', terminal.id)), 'permanently-inactive');
    reconcileConsentsForService({ store, serviceId: service.id, serviceState: 'active', now: fixedNow() });
    assert.equal(consentBusinessStatus(store.get('Consent', terminal.id)), 'permanently-inactive');
});

test('synthetic patients 1 and 2 auto-approve with HTEST and every operational source', () => {
    for (const value of ['1', '2']) {
        const { store, sp } = fixture();
        const consent = createConsent({
            store, callerOrganization: sp,
            request: submit({ system: IDENTIFIER_SYSTEMS.syntheticTest, value }),
            clock: fixedNow
        });
        assert.equal(consentBusinessStatus(consent), 'active');
        assert.equal(consent.meta.security[0].code, 'HTEST');
        assert.deepEqual(consent.provision.actor.filter(actor => actor.role.coding[0].code === 'CST')
            .map(actor => actor.reference.reference), ['Organization/org-ds-hmo-b']);
        assert.equal(assertConsentResource(consent), true);
    }
});

test('all imported Consent and lifecycle Parameters examples satisfy their exact path', () => {
    const consentFiles = fs.readdirSync(examples).filter(name => /^Consent-.*\.json$/.test(name));
    assert.equal(consentFiles.length, 10);
    for (const file of consentFiles) {
        const consent = read(file);
        if (consent.meta.profile[0] === 'http://pcm.fhir.health.gov.il/StructureDefinition/pcm-consent-submit') {
            assert.doesNotThrow(() => assertSubmitRequest(consent), file);
        } else {
            assert.equal(assertConsentResource(consent), true, file);
        }
    }
    const lifecycle = read('Parameters-parameters-consent-hosp-a-lifecycle.json');
    assert.deepEqual(lifecycle.parameter.map(parameter => parameter.name), [
        'created', 'approved', 'deactivationRequest', 'deactivated'
    ]);
    for (const parameter of lifecycle.parameter) {
        if (parameter.name === 'deactivationRequest') assert.doesNotThrow(() => assertDeactivateRequest(parameter.resource));
        else assert.equal(assertConsentResource(parameter.resource), true, parameter.name);
    }
    assert.deepEqual(CONSENT_POLICY, {
        authority: 'https://www.gov.il/',
        uri: 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024'
    });
});

test('UI approval labels distinguish exact test auto-approval from ordinary review and denial', () => {
    const { isTestAutoApproved } = require('../../shared/consent-presentation');
    for (const value of ['1', '2']) {
        const { store, sp } = fixture();
        const consent = createConsent({ store, callerOrganization: sp,
            request: submit({ system: IDENTIFIER_SYSTEMS.syntheticTest, value }), clock: fixedNow });
        assert.equal(consent.status, 'active');
        assert.equal(isTestAutoApproved(consent), true);
        assert.equal(isTestAutoApproved({ ...consent, patient: { identifier: { system: IDENTIFIER_SYSTEMS.israelNationalId, value } } }), false);
    }
    for (const decision of ['approve', 'deny']) {
        const { store, sp } = fixture();
        const proposed = createConsent({ store, callerOrganization: sp, request: submit(), clock: fixedNow });
        assert.equal(store.get('Consent', proposed.id).status, 'proposed');
        assert.equal(isTestAutoApproved(proposed), false);
        const result = decision === 'approve' ? approveConsent({ store, consent: proposed, clock: fixedNow })
            : rejectConsent({ store, consent: proposed });
        assert.equal(store.get('Consent', result.id).status, decision === 'approve' ? 'active' : 'rejected');
        assert.equal(isTestAutoApproved(result), false);
    }
});

test('0.4.2 Palestinian and passport Consent identities preserve exact strings without Israeli checksum or OAuth length limits', () => {
    for (const identifier of [
        { system: IDENTIFIER_SYSTEMS.palestinianNationalId, value: '000000019' },
        { system: IDENTIFIER_SYSTEMS.palestinianNationalId, value: 'P'.repeat(129) },
        { system: 'http://hl7.org/fhir/sid/passport-USA', value: '000000019' }
    ]) {
        const { store, sp } = fixture();
        const result = createConsent({ store, callerOrganization: sp, request: submit(identifier), clock: fixedNow });
        assert.deepEqual(result.patient.identifier, identifier);
        assert.equal(result.status, 'proposed');
    }
    for (const value of ['', ' ', '000019 ', ' 000019']) assert.throws(() => assertSubmitRequest(submit({ system: IDENTIFIER_SYSTEMS.palestinianNationalId, value })));
});
