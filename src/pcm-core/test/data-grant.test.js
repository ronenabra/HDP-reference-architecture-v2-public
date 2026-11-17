'use strict';

/** Current authorization and immutable grant tests for every supported scenario. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { NOW, dataGrantFixture, rar } = require('../../../test-support/data-grants');
const { resolveGrant, grantStillAllowed } = require('../src/data-grant');
const { historyStart } = require('../src/grant-compiler');
const { setApprovedTokenScope } = require('../src/data-sources');
const { clinicalTokenFixture, V } = require('../../../test-support/clinical-token-fixture');
const { EXTENSIONS } = require('../../shared/pcm-contract');

test('advisory custom approval remains exact and unusable under every preset', () => {
    for (const scope of ['', 'suspect scope', 'patient/Unknown.rs', 'patient/Observation.rs?_filter=x']) {
        const f = clinicalTokenFixture({ scope });
        assert.throws(() => resolveGrant({ ...f.request, scope: 'patient/Patient.rs patient/Observation.rs' }), /approval|snapshot/i);
        f.config.sandbox.grantFullClinicalAccess = true;
        assert.throws(() => resolveGrant({ ...f.request, scope: 'patient/Patient.rs patient/Observation.rs' }), /retired|approval|snapshot/i);
    }
});

test('Consent business identity resolves its exact saved default without recompiling live service policy', () => {
    const { request, consent, store } = dataGrantFixture();
    const grant = resolveGrant(request);
    assert.equal(grant.scope, store.privateRecords.approvals.getDecision(consent.id).snapshot.scope);
    assert.match(grant.scope, /date=ge2024-10-04T12:00:00.000Z/);
    assert.equal(grant.authorization_details[0].fhirContext.length, 3);
    assert.equal(grantStillAllowed(grant, resolveGrant(request)), true);
    assert.throws(() => resolveGrant({ ...request, requested: rar('Consent', consent.id) }), /Authorization basis is unavailable/);
    store.update({ ...consent, status: 'inactive' });
    assert.throws(() => resolveGrant(request), /Authorization basis is unavailable/);
});

test('complete union stays immutable despite narrow requests; new permissions require a new approval', () => {
    const exact = `patient/Patient.rs?${V} patient/Observation.s?status=final&${V} patient/Observation.s?status=preliminary&${V}`;
    const f = clinicalTokenFixture({ scope: exact });
    const before = resolveGrant(f.request);
    assert.equal(before.scope, exact);
    assert.equal(resolveGrant({ ...f.request, scope: 'patient/Observation.s' }).scope, exact);
    const forged = structuredClone(f.consent);
    assert.throws(() => setApprovedTokenScope(forged, `patient/Patient.rs?${V}`), /read-only/);
    forged.extension.push({ url: require('../../shared/pcm-contract').SANDBOX_EXTENSIONS.approvedTokenScope, valueString: `patient/Patient.rs?${V}` });
    assert.throws(() => f.store.update(forged), /read-only|snapshot|private/i);
    const replacement = f.approve(undefined, `patient/Patient.rs?${V}`);
    const after = resolveGrant({ ...f.request, requested: rar('Consent', replacement.identifier[0].value) });
    assert.equal(grantStillAllowed(before, after), false);
    assert.equal(resolveGrant(f.request).scope, exact);
});

test('presence is Contract backed and checks every requested patient eligibility', () => {
    const { request, config, patient } = dataGrantFixture();
    const input = { ...request, client: { clientId: config.oauthClients.presenceOrchestrator.clientId }, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [patient]), scope: 'system/Patient.s' };
    const grant = resolveGrant(input);
    assert.equal(grant.scenario, 'presence-check');
    assert.equal(grant.authorization_details[0].fhirContext.length, 2);
    assert.equal(grant.serviceId, undefined);
    assert.match(grant.scope, /\?identifier=.*\|1&_security=.*patientDemographics$/);
    assert.throws(() => resolveGrant({ ...input, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [patient, { ...patient, value: '2' }]) }), /unavailable/);
    assert.throws(() => resolveGrant({ ...input, client: request.client }), /unavailable/);
});

test('authentication and discovery require private matching flow evidence and cap expiration', () => {
    const { request, config, strongPatient, source } = dataGrantFixture();
    const authenticationClient = config.oauthClients.authenticationOrchestrator.clientId;
    const input = { ...request, client: { clientId: authenticationClient }, requested: rar('Contract', 'PCM-POLICY-PATIENT-AUTHENTICATION-001', [strongPatient]), scope: 'patient/Patient.s' };
    assert.throws(() => resolveGrant(input), /unavailable/);
    const invocation = { id: 'private-flow', clientId: authenticationClient, identifier: strongPatient, homeHmoId: source.dataSourceOrganization.id, phase: 'authenticating', expiresAt: NOW + 10 };
    const auth = resolveGrant({ ...input, invocation });
    assert.equal(auth.deadline, NOW + 10);
    assert.match(auth.scope, /^patient\/Patient.s\?_security=.*patientDemographics$/);
    assert.throws(() => resolveGrant({ ...input, invocation: { ...invocation, expiresAt: NOW } }), /unavailable/);
    const discoveryClient = config.oauthClients.discoveryOrchestrator.clientId;
    const discovery = { ...request, client: { clientId: discoveryClient }, requested: rar('Contract', 'PCM-POLICY-DEPENDENT-DISCOVERY-001'), scope: 'system/Patient.s system/RelatedPerson.s', invocation: { ...invocation, clientId: discoveryClient, phase: 'authenticated' } };
    const grant = resolveGrant(discovery);
    assert.match(grant.scope, /^system\/Patient.s\?_has:RelatedPerson:patient:identifier=/);
    assert.equal(grant.authorization_details[0].fhirContext[1].type, 'RelatedPerson');
    assert.throws(() => resolveGrant({ ...discovery, invocation: { ...discovery.invocation, phase: 'authenticating' } }), /unavailable/);
});

test('calendar history subtraction clamps leap days and rejects unsupported units', () => {
    assert.equal(historyStart(Date.parse('2024-02-29T12:00:00Z') / 1000, { system: 'http://unitsofmeasure.org', value: 1, code: 'a' }), '2023-02-28T12:00:00.000Z');
    assert.throws(() => historyStart(NOW, { system: 'http://unitsofmeasure.org', value: 1, code: 'unknown' }), /unit/);
});

test('system entitlement never grants clinical Consent authority in relaxed presets', () => {
    const { request, config } = dataGrantFixture();
    assert.throws(() => resolveGrant({ ...request, client: { role: 'presence-orchestrator', clientId: config.oauthClients.presenceOrchestrator.clientId },
        controls: { consentState: false, serviceState: false, tokenResourceBinding: false } }), error => error.code === 'unauthorized_client');
});

test('every preset retains system entitlement, invocation and membership invariants under effective controls', () => {
    const { buildTeamConfig } = require('../../../test-support/team-config');
    const { buildEffectivePolicy } = require('../../shared/conformance-policy');
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        const f = dataGrantFixture();
        const selected = buildTeamConfig({}, preset);
        for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) f.config[key] = selected[key];
        const controls = buildEffectivePolicy(f.config).simulation.controls;
        assert.equal(controls.serviceState, true);
        const input = { ...f.request, controls, scope: 'system/Patient.s',
            client: { clientId: f.config.oauthClients.presenceOrchestrator.clientId },
            requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [f.patient]) };
        assert.equal(resolveGrant(input).scenario, 'presence-check');
        assert.throws(() => resolveGrant({ ...input, client: { clientId: 'unentitled' } }), /unavailable/);
        assert.throws(() => resolveGrant({ ...input, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [{ ...f.patient, value: '2' }]) }), /unavailable/);
        const auth = { ...input, scope: 'patient/Patient.s', client: { clientId: f.config.oauthClients.authenticationOrchestrator.clientId },
            requested: rar('Contract', 'PCM-POLICY-PATIENT-AUTHENTICATION-001', [f.strongPatient]) };
        assert.throws(() => resolveGrant(auth), /unavailable/);
        assert.ok(resolveGrant({ ...auth, invocation: { id: 'trusted', clientId: auth.client.clientId, identifier: f.strongPatient,
            homeHmoId: f.source.dataSourceOrganization.id, phase: 'authenticating', expiresAt: NOW + 10 } }));
        const contract = f.store.get('Contract', 'policy-presence');
        contract.term[0].asset = []; f.store.add(contract);
        assert.throws(() => resolveGrant(input), /unavailable/);
        f.store.add({ ...contract, term: [{ ...contract.term[0], asset: [{ context: [{ reference: { reference: `Organization/${f.source.dataSourceOrganization.id}` } }] }] }], status: 'revoked' });
        assert.throws(() => resolveGrant(input), /unavailable/);
    }
});


test('ongoing normative Contract grant survives JSON persistence without inventing a service', () => {
    const f = dataGrantFixture();
    const contract = f.store.get('Contract', 'policy-presence');
    delete contract.applies.end;
    f.store.add(contract);
    const input = { ...f.request, scope: 'system/Patient.s', client: { clientId: f.config.oauthClients.presenceOrchestrator.clientId },
        requested: rar('Contract', contract.identifier[0].value, [f.patient]) };
    const retained = JSON.parse(JSON.stringify(resolveGrant(input)));
    assert.equal(retained.deadline, Number.MAX_SAFE_INTEGER);
    assert.equal(retained.serviceId, undefined);
    assert.equal(grantStillAllowed(retained, resolveGrant(input)), true);
    assert.equal(retained.authorization_details[0].fhirContext.some(item => item.type === 'HealthcareService'), false);
});

test('plural-category service authoring freezes complete alternatives once; live metadata cannot rewrite approval', () => {
    const { serviceDefinitionDraft: serviceDefinition } = require('../src/service-definition-form');
    const { readServiceGrant } = require('../../shared/service-grant');
    const { SENSITIVITY_LABELS } = require('../../shared/information-buckets');
    const labels = [SENSITIVITY_LABELS[1], SENSITIVITY_LABELS[8]];
    const f = dataGrantFixture();
    const definition = serviceDefinition({ name: 'New explicit tagged labs', purpose: 'Owned fixture', category: '35', accessMode: 'continuous',
        duration: 6, durationUnit: 'mo', allowChanges: true, buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a',
            sensitivity: labels.map(label => `${label.system}|${label.code}`) }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }] }, { now: NOW });
    const exact = readServiceGrant(definition).scope;
    assert.match(exact, /date=ge2024-10-04T12:00:00.000Z/);
    assert.ok(exact.includes(`_security=${labels.map(label => `${label.system}|${label.code}`).join(',')}`));
    const clinical = clinicalTokenFixture({ scope: exact });
    const catalog = clinical.store.get('HealthcareService', clinical.config.service.catalogId || 'service-catalog-1');
    catalog.extension.find(item => item.url === EXTENSIONS.informationBucket).extension.push({ url: 'taggedDetails', valueCodeableConcept: { coding: [labels[0]] } });
    clinical.store.update(catalog);
    assert.equal(resolveGrant(clinical.request).scope, exact);
});

test('FHIR long PNA identity stays stored while OAuth has its independent 128-character bound', () => {
    const f = clinicalTokenFixture();
    for (const length of [128, 129]) {
        const consent = f.approve({ system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: 'P'.repeat(length) });
        const request = { ...f.request, requested: rar('Consent', consent.identifier[0].value) };
        if (length === 128) assert.deepEqual(resolveGrant(request).authorization_details[0].fhirContext.find(item => item.type === 'Patient').identifier, consent.patient.identifier);
        else assert.throws(() => resolveGrant(request), error => error.code === 'invalid_authorization_details');
        assert.equal(f.store.get('Consent', consent.id).patient.identifier.value.length, length);
    }
});

test('fresh service approval inside the represented OAuth second preserves its clocks and conservative expiry', () => {
    const f = require('../../../test-support/data-grants').dataGrantFixture();
    const { EXTENSIONS } = require('../../shared/pcm-contract');
    const service = f.store.get('HealthcareService', f.service.id);
    const catalog = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(service));
    const window = (start, end) => {
        for (const resource of [catalog, service]) {
            const current = f.store.get('HealthcareService', resource.id);
            f.store.update({ ...current, extension: [...current.extension.filter(item => item.url !== EXTENSIONS.approvalWindow),
                { url: EXTENSIONS.approvalWindow, valuePeriod: { start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() } }] });
        }
    };
    window(f.request.now + 0.5, f.request.now + 60.5);
    const periods = [catalog, service].map(row => f.store.get('HealthcareService', row.id).extension.find(item => item.url === EXTENSIONS.approvalWindow));
    const approval = structuredClone(f.store.privateRecords.approvals.getDecision(f.consent.id));
    assert.equal(require('../src/data-grant').resolveGrant(f.request).deadline, f.request.now + 60.5);
    assert.deepEqual([catalog, service].map(row => f.store.get('HealthcareService', row.id).extension.find(item => item.url === EXTENSIONS.approvalWindow)), periods);
    assert.deepEqual(f.store.privateRecords.approvals.getDecision(f.consent.id), approval);
    assert.equal(f.windows.size, 0, 'issuance never starts or changes first-use clocks');
    assert.throws(() => require('../src/data-grant').resolveGrant({ ...f.request, now: f.request.now + 0.25 }), /Authorization basis/, 'precise clocks retain their exact start boundary');
    window(f.request.now + 1, f.request.now + 60);
    assert.throws(() => require('../src/data-grant').resolveGrant(f.request), /Authorization basis/);
    window(f.request.now - 60, f.request.now + 0.5);
    assert.equal(Math.floor(require('../src/data-grant').resolveGrant(f.request).deadline - f.request.now), 0, 'token issuance still floors remaining lifetime');
    window(f.request.now - 60, f.request.now);
    assert.throws(() => require('../src/data-grant').resolveGrant(f.request), /Authorization basis/, 'exact expiry remains terminal');
});
