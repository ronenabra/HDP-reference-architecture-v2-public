'use strict';
/** Local GUID admission, bounded sampler policy/transport and ordinary Consent authority. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { dataGrantFixture } = require('../../../test-support/data-grants');
const { SCENARIO, SYSTEM, URI, FIXED, projectSample, assertSampleRequest, sampleSources } = require('../../shared/sandbox-patients');
const { normalizePatientIdentifier, sandboxIdentityOptions } = require('../../shared/identity-mapping');
const { samplingResourceDrafts: samplingResources, validateSamplingPolicy } = require('../src/fhir/sampling-policy');
const { createConsent, approveConsent, assertConsentResource, patientIdentifier } = require('../src/fhir/consent-lifecycle');
const { buildConsentSubmit } = require('../../sp-client/src/fhir-builders');
const { resolveGrant } = require('../src/data-grant');
const GUID = 'Ab123456-1234-5678-9012-1234567890ab';
const patient = (value = GUID) => ({ resourceType: 'Patient', id: 'synthetic', identifier: [{ system: SYSTEM, value }], name: [{ text: 'Sandbox person' }], birthDate: '1990-01-01', telecom: [{ value: 'private' }], meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } });
const bundle = resources => ({ resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })), link: [{ relation: 'next', url: 'https://malicious.invalid/full-population' }] });
/** Local policy fixture uses the same authority graph and external loader as bootstrap. */
function fixture() {
    const f = dataGrantFixture(); f.config.serviceCatalog = { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: f.service.id, instanceIdentifier: 'SAMPLER-TEST-INSTANCE' }] };
    f.config.sandboxSampling = { sourceIds: ['ho-a', 'ho-b'] };
    for (const role of ['serviceProvider', 'hospitalBServiceProvider']) f.config.systemAuthorization.clientEntitlements[f.config.organizations[role].clientId] = [SCENARIO];
    for (const resource of samplingResources(f.config, f.request.now)) require('../src/public-fhir').publishNewResource(f.store, resource);
    return f;
}
test('GUID is explicitly gated and preserves casing; standard auto IDs remain exact', () => {
    assert.throws(() => normalizePatientIdentifier({ system: SYSTEM, value: GUID }), /connectathon/);
    assert.equal(normalizePatientIdentifier({ system: SYSTEM, value: GUID }, { allowSandboxGuid: true }).value, GUID);
    for (const value of ['', '00000000-0000-0000-0000-000000000000', 'ABC', GUID.replaceAll('-', ''), `${GUID} `]) assert.throws(() => normalizePatientIdentifier({ system: SYSTEM, value }, { allowSandboxGuid: true }));
    assert.deepEqual(FIXED.map(p => p.idValue), ['1', '2']);
    for (const value of ['01', '3']) assert.throws(() => normalizePatientIdentifier({ system: FIXED[0].idSystem, value }));
});
test('first-page projection handles 0/1/10/>10 and skips invalid/ambiguous/duplicate/non-HTEST rows', () => {
    for (const count of [0, 1, 10, 11]) { const result = projectSample(bundle(Array.from({ length: count }, (_, i) => patient(`00000001-1234-5678-9012-${String(i + 1).padStart(12, '0')}`)))); assert.equal(result.patients.length, Math.min(10, count)); assert.ok(result.patients.every(p => !p.telecom && p.birthDate === '1990-01-01')); }
    const wrong = patient(); wrong.identifier[0].system = 'urn:wrong'; const ambiguous = patient(); ambiguous.identifier.push({ system: SYSTEM, value: '12345678-1234-1234-1234-123456789abc' }); const untagged = patient(); delete untagged.meta;
    const result = projectSample(bundle([patient(), patient(), wrong, ambiguous, untagged, patient('bad'), patient([GUID])]));
    assert.equal(result.state, 'partial'); assert.equal(result.rejected, 6); assert.equal(result.patients.length, 1);
    assert.throws(() => projectSample({ resourceType: 'Patient' }));
});
test('sample adds only literal birthDate and retains full, partial and missing precision', () => {
    for (const birthDate of ['1990-03-12', '1990-03', '1990', undefined, '<script>']) {
        const resource = patient(); resource.birthDate = birthDate;
        resource.address = [{ text: 'private' }]; resource.gender = 'female';
        const [result] = projectSample(bundle([resource])).patients;
        assert.equal(result.birthDate, birthDate && !birthDate.startsWith('<') ? birthDate : undefined);
        assert.deepEqual(Object.keys(result).sort(), ['display', 'idSystem', 'idValue', 'sandboxSynthetic', ...(result.birthDate ? ['birthDate'] : [])].sort());
    }
    assert.equal(new URL('http://local' + URI).searchParams.get('_elements'), 'identifier,name,birthDate');
    for (const projection of ['identifier,name', 'identifier,name,birthDate,telecom', '*']) {
        const url = new URL('http://local' + URI); url.searchParams.set('_elements', projection);
        assert.throws(() => assertSampleRequest({ method: 'GET', uri: url.pathname + url.search }));
    }
});
test('fixed query rejects arbitrary route/method/projection/count/system and all strict sources', () => {
    assertSampleRequest({ method: 'GET', uri: URI });
    for (const binding of [{ method: 'POST', uri: URI }, { method: 'GET', uri: `${URI}&_include=*` }, { method: 'GET', uri: URI.replace('_count=10', '_count=100') }, { method: 'GET', uri: URI.replace('Patient?', 'Patient/1?') }, { method: 'GET', uri: URI.replace('identifier%2Cname', '*') }]) assert.throws(() => assertSampleRequest(binding));
    const f = fixture(); assert.equal(sampleSources(f.config).length, 2); assert.equal(samplingGrant(f).scenario, SCENARIO);
    assert.throws(() => samplingGrant(f, { resource: f.config.healthOrganizations[2].endpoint }));
    f.config.conformance.mode = 'strict'; assert.equal(sampleSources(f.config).length, 0); assert.throws(() => samplingGrant(f));
});
/** Exercise the same resolver used by /token and /introspect, with no private invocation. */
function samplingGrant(f, overrides = {}) {
    return resolveGrant({ ...f.request, requested: require('../../../test-support/data-grants').rar('Contract', 'PCM-POLICY-SANDBOX-PATIENT-SAMPLE-001'), scope: 'system/Patient.s', ...overrides });
}
test('two ordinary applications receive identical bounded Contract-only grants across eligible targets', () => {
    const f = fixture();
    for (const role of ['serviceProvider', 'hospitalBServiceProvider']) for (const source of f.config.healthOrganizations.slice(0, 2)) {
        const org = f.config.organizations[role];
        const grant = samplingGrant(f, { client: { clientId: org.clientId, organizationId: org.id, role: 'service-provider' }, resource: source.endpoint });
        assert.equal(grant.scope, 'system/Patient.s'); assert.equal(grant.authorization_details[0].fhirContext.length, 2);
        assert.equal(grant.invocationId, undefined);
        const { validateDataAuthorizationDetails } = require('../../shared/data-authorization-details');
        assert.equal(validateDataAuthorizationDetails(grant.authorization_details, { allowSandboxGuid: true }).scenario, SCENARIO);
        assert.throws(() => validateDataAuthorizationDetails(grant.authorization_details));
    }
    const policy = f.store.get('Contract', 'sandbox-patient-sampling-policy-v2');
    const { service } = validateSamplingPolicy(f.store, policy, f.config.organizations.pcm.id);
    assert.equal(policy.status, 'policy');
    for (const resource of [policy, service]) assert.ok(resource.meta.tag.some(tag => tag.display === 'Only for sandbox tests'));
    assert.equal(policy.meta.profile, undefined); assert.equal(service.meta.profile, undefined);
    assert.throws(() => validateSamplingPolicy(f.store, { ...policy, meta: { ...policy.meta, profile: [require('../src/fhir/system-contract').SYSTEM_PROFILE] } }, f.config.organizations.pcm.id));
});
test('sampling fails closed on eligibility, ambiguity, dates, lifecycle, targets and attempted RAR widening', () => {
    const { rar } = require('../../../test-support/data-grants');
    const mutations = [
        f => delete f.config.systemAuthorization.clientEntitlements[f.client.clientId],
        f => f.config.sandboxSampling.sourceIds = ['ho-c'],
        f => f.store.update({ ...f.store.get('Contract', 'sandbox-patient-sampling-policy-v2'), status: 'revoked' }),
        f => f.store.update({ ...f.store.get('HealthcareService', 'sandbox-patient-sampling-service-v2'), active: false }),
        f => f.store.add({ ...f.store.get('Contract', 'sandbox-patient-sampling-policy-v2'), id: 'duplicate-policy' }),
        f => f.store.add({ ...f.store.get('HealthcareService', 'sandbox-patient-sampling-service-v2'), id: 'duplicate-service' }),
        f => f.store.update({ ...f.store.get('Organization', f.source.dataSourceOrganization.id), active: false }),
        f => f.store.update({ ...f.store.get('Organization', f.client.organizationId), active: false }),
        f => f.store.update({ ...f.store.get('Contract', 'sandbox-patient-sampling-policy-v2'), applies: { start: new Date((f.request.now + 1) * 1000).toISOString(), end: new Date((f.request.now + 100) * 1000).toISOString() } }),
        f => f.store.update({ ...f.store.get('Contract', 'sandbox-patient-sampling-policy-v2'), applies: { start: new Date((f.request.now - 100) * 1000).toISOString(), end: new Date(f.request.now * 1000).toISOString() } }),
        f => f.config.conformance = { mode: 'strict', preset: 'strict' }
    ];
    for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => samplingGrant(f)); }
    const f = fixture();
    for (const scope of ['system/Patient.r', 'system/Patient.rs', 'system/Patient.s system/RelatedPerson.s']) assert.throws(() => samplingGrant(f, { scope }));
    assert.throws(() => samplingGrant(f, { requested: rar('Contract', 'PCM-POLICY-SANDBOX-PATIENT-SAMPLE-001', [f.patient]) }));
    assert.throws(() => samplingGrant(f, { client: { clientId: f.config.oauthClients.presenceOrchestrator.clientId } }));
    const endpoint = require('../src/fhir/participant-lifecycle').participantEndpoint(f.store, f.store.get('Organization', f.source.dataSourceOrganization.id));
    f.store.update({ ...endpoint, address: 'https://different.invalid/fhir' }); assert.throws(() => samplingGrant(f));
});
test('protected catalog reconciliation includes the local pair and preserves its terminal lifecycle and operator fields', () => {
    const f = fixture(), { proposedCatalog, previewCatalog, reconcileCatalog, HASH_SYSTEM } = require('../src/catalog-bootstrap');
    const service = f.store.get('HealthcareService', 'sandbox-patient-sampling-service-v2');
    f.store.update({ ...service, active: false, name: 'Operator sampler name' });
    const policy = f.store.get('Contract', 'sandbox-patient-sampling-policy-v2');
    f.store.update({ ...policy, status: 'revoked' });
    const previousHash = f.store.privateRecords.provisioning.get('Contract', policy.id).seedTags.find(tag => tag.system === HASH_SYSTEM).code;
    f.config.sandboxSampling.sourceIds = ['ho-a'];
    const full = proposedCatalog(f.config);
    const proposed = full.filter(item => [service.id, policy.id].includes(item.id)); const preview = previewCatalog(f.store, proposed);
    assert.ok(proposed.some(item => item.id === service.id)); assert.ok(proposed.some(item => item.id === policy.id));
    assert.ok(preview.conflicts.some(item => item.key === `Contract/${policy.id}`));
    let backup; reconcileCatalog(f.store, proposed, preview.versions, value => { backup = value; });
    const changed = f.store.get('Contract', policy.id); assert.equal(changed.status, 'revoked');
    assert.deepEqual(changed.applies, policy.applies); assert.equal(changed.issued, policy.issued);
    assert.notEqual(f.store.privateRecords.provisioning.get('Contract', changed.id).seedTags.find(tag => tag.system === HASH_SYSTEM).code, previousHash);
    assert.equal(f.store.get('HealthcareService', service.id).active, false);
    assert.equal(f.store.get('HealthcareService', service.id).name, 'Operator sampler name'); assert.ok(backup.Contract);
});
test('GUID Consent is manual, stored with local provenance and HTEST, clinical RAR is exact and strict rejects', () => {
    const f = fixture(), identifier = { system: SYSTEM, value: GUID };
    const request = buildConsentSubmit(identifier, f.service.id, sandboxIdentityOptions(f.config));
    assert.throws(() => createConsent({ store: f.store, callerOrganization: f.store.get('Organization', f.client.organizationId), request }), /connectathon/);
    const created = createConsent({ store: f.store, config: f.config, callerOrganization: f.store.get('Organization', f.client.organizationId), request, clock: () => new Date(f.request.now * 1000) });
    assert.equal(created.status, 'proposed'); assert.equal(patientIdentifier(created).sandboxSynthetic, true); assertConsentResource(created);
    const approved = approveConsent({ store: f.store, consent: created, sourceOrganizationIds: [f.source.dataSourceOrganization.id], clock: () => new Date(f.request.now * 1000) }); assertConsentResource(approved);
    const requested = require('../../../test-support/data-grants').rar('Consent', approved.identifier[0].value);
    const grant = resolveGrant({ ...f.request, requested }); assert.equal(grant.patient.value, GUID); assert.equal(grant.authorization_details[0].fhirContext.find(item => item.type === 'Patient').identifier.value, GUID);
    const { validateDataAuthorizationDetails } = require('../../shared/data-authorization-details'); assert.throws(() => validateDataAuthorizationDetails(grant.authorization_details)); assert.equal(validateDataAuthorizationDetails(grant.authorization_details, { allowSandboxGuid: true }).scenario, 'consent-access');
    f.config.conformance.mode = 'strict'; f.config.conformance.preset = 'strict'; assert.throws(() => resolveGrant({ ...f.request, requested }), /GUID/);
});


test('normal issuance and introspection freeze the grant and enforce deadlines/state even with easy controls off', () => {
    const { createTokenService } = require('../src/token-service');
    const { evaluateSubjectToken } = require('../src/introspection-service');
    const { contractAuthorizationDetails } = require('../../shared/data-authorization-details');
    const { buildEffectivePolicy } = require('../../shared/conformance-policy');
    const authentication = { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true };
    for (const lifetime of [30, 86400]) {
        const f = fixture(); let retained;
        const contract = f.store.get('Contract', 'sandbox-patient-sampling-policy-v2');
        f.store.update({ ...contract, applies: { ...contract.applies, end: new Date((f.request.now + 20) * 1000).toISOString() } });
        const client = { ...f.client, mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) };
        const issue = createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore, getConfig: () => f.config,
            getPolicy: () => buildEffectivePolicy(f.config, {}), getIssuer: () => f.config.contract.operational.fhirBase, clock: () => f.request.now, getLifetime: () => lifetime,
            authenticate: req => { req.mtls = { thumbprint: client.mtlsThumbprint }; return { client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: client.assertionThumbprint }; }, logger: { info() {}, warn() {} }, tokenStore: { issue(kind, claims, seconds) { retained = { ...claims, kind, iat: f.request.now, exp: f.request.now + seconds }; return { token: 'ordinary-opaque', record: retained }; } } });
        const issued = issue({ body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'ordinary-assertion', resource: f.source.endpoint, scope: 'system/Patient.s', authorization_details: JSON.stringify(contractAuthorizationDetails(contract.identifier[0].value)) } });
        assert.equal(issued.status, 200); assert.equal(issued.body.expires_in, 20); assert.equal(retained.kind, 'sandbox_patient_sample');
        const caller = { clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id };
        const findClient = id => id === f.client.clientId ? f.client : f.config.healthOrganizations.map(source => ({ clientId: source.clientId, organizationId: source.dataSourceOrganization.id, role: 'data-source' })).find(item => item.clientId === id);
        const inspect = (token = retained, override = {}) => evaluateSubjectToken({ token, caller, findClient, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now: f.request.now, controls: { tokenExpiry: false, tokenAudience: false, tokenResourceBinding: false, serviceState: false }, ...override });
        const active = inspect(); assert.equal(active.active, true); assert.deepEqual(active.authorization_details, issued.body.authorization_details); assert.equal(active.scope, issued.body.scope); assert.equal(active.organization_id, undefined);
        assert.equal(inspect({ ...retained, exp: f.request.now }), null);
        assert.equal(inspect({ ...retained, aud: f.config.healthOrganizations[1].endpoint }), null);
        const other = f.config.healthOrganizations[1]; assert.equal(inspect(retained, { caller: { clientId: other.clientId, organizationId: other.dataSourceOrganization.id } }), null);
        const service = f.store.get('HealthcareService', 'sandbox-patient-sampling-service-v2'); f.store.update({ ...service, active: false }); assert.equal(inspect(), null); f.store.update(service);
        f.store.update({ ...contract, status: 'revoked' }); assert.equal(inspect(), null);
        assert.deepEqual(retained.pcm_authentication_context, authentication);
    }
});

test('disabled service/Consent simulations do not bypass labelled sampling pair authority or expiry', () => {
    const f = fixture();
    const controls = { serviceState: false, consentState: false, tokenAudience: false, tokenExpiry: false };
    const grant = samplingGrant(f, { controls });
    assert.equal(grant.authorization_details[0].fhirContext.find(item => item.type === 'HealthcareService').identifier.value, 'PCM-SERVICE-SANDBOX-PATIENT-SAMPLE-001');
    const service = f.store.get('HealthcareService', 'sandbox-patient-sampling-service-v2');
    f.store.add({ ...service, active: false });
    assert.throws(() => samplingGrant(f, { controls }));
    f.store.add(service);
    const contract = f.store.get('Contract', 'sandbox-patient-sampling-policy-v2');
    assert.throws(() => samplingGrant(f, { controls, now: Date.parse(contract.applies.end) / 1000 }));
});
