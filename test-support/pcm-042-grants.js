'use strict';

/** Disposable real-store grant harness; only registered assertion verification is replaced. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataGrantFixture, rar, NOW } = require('./data-grants');
const { buildTeamConfig } = require('./team-config');
const { FileTokenStore } = require('../src/pcm-core/src/token-store');
const { createTokenService } = require('../src/pcm-core/src/token-service');
const { createIntrospectionService } = require('../src/pcm-core/src/introspection-service');
const { buildEffectivePolicy } = require('../src/shared/conformance-policy');
const { INTERNAL_INVOCATION } = require('../src/pcm-core/src/data-grant');
const { TYPE, ROLE_BASE, BASIS_SYSTEMS } = require('../src/pcm-core/src/rar-request');

/** Build arbitrary distinct supported identities without weakening the normal request parser. */
function patients(count) {
    return Array.from({ length: count }, (_, i) => ({ system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: String(i + 1) }));
}

/** Serialize the untrusted request independently of the configured patient count. */
function requested(type, value, identities = []) {
    return JSON.stringify([{ type: TYPE, fhirContext: [{ type, role: `${ROLE_BASE}authorization-basis`, identifier: { system: BASIS_SYSTEMS[type], value } },
        ...identities.map(identifier => ({ type: 'Patient', role: `${ROLE_BASE}authorization-patient`, identifier }))] }]);
}

/** Return real issuance/introspection services and all disposable state for focused tests. */
function grantHarness(preset = 'strict', { mode = 'continuous' } = {}) {
    const f = dataGrantFixture({ mode });
    // Use complete FHIR actor codings so the explicit empty-source simulation is not accidentally selected.
    for (const actor of f.consent.provision.actor) for (const coding of actor.role.coding) coding.system = 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType';
    f.consent = f.store.update(f.consent);
    const selected = buildTeamConfig({}, preset);
    for (const key of ['conformance', 'security', 'securitySimulation', 'sandbox', 'legacyDataSource']) f.config[key] = selected[key];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-042-grants-'));
    f.config.runtime.stateDir = path.join(directory, 'state');
    let now = NOW, sequence = 0, authentications = 0, replays = 0, introspectionReplays = 0;
    const tokenStore = new FileTokenStore(directory, { clock: () => now, tokenGenerator: () => String(++sequence).padStart(36, '0') });
    const clients = [{ ...f.client, scopes: ['system/*.crus'], authorizationCodeGrant: true }, ...f.config.healthOrganizations.map(source => ({ clientId: source.clientId, organizationId: source.dataSourceOrganization.id,
        role: 'data-source', scopes: ['introspection', 'system/*.crus'] })), ...Object.entries(f.config.oauthClients).map(([key, client]) => ({ ...client,
        organizationId: f.config.organizations.pcm.id, role: key.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`) }))];
    for (const client of clients) Object.assign(client, { mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) });
    const findClient = id => clients.find(client => client.clientId === id);
    let invocation = null;
    const service = createTokenService({ authorizationStore: { consumeCode: () => ({ ok: true, grant: { scope: ['patient/Observation.rs'], audience: f.config.contract.operational.fhirBase, patient: f.patient } }) }, fhirStore: f.store, firstUseStore: f.firstUseStore, tokenStore,
        authenticate: req => { authentications++; req.mtls = { thumbprint: 'A'.repeat(43) }; return { client: { ...findClient(req.clientId || f.client.clientId), mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) },
            transportVerified: true, signatureVerified: true, assertionSigningThumbprint: 'B'.repeat(43),
            decodedAssertion: { jti: 'bound-test-invocation' }, commitReplay: () => { replays++; return true; } }; },
        getConfig: () => f.config, getIssuer: () => f.config.contract.operational.fhirBase, getPolicy: () => buildEffectivePolicy(f.config),
        resolveInvocation: () => invocation, clock: () => now, logger: { info() {}, warn() {} } });
    const introspect = createIntrospectionService({ store: f.store, firstUseStore: f.firstUseStore, tokenStore, findClient,
        authenticateAssertion: req => ({ client: findClient(req.callerId || f.source.clientId), commitReplay: () => { introspectionReplays++; return true; } }), getConfig: () => f.config,
        getAudience: () => `${f.config.contract.operational.oauthBase}/introspect`,
        getPolicy: () => buildEffectivePolicy(f.config), resolveInvocation: () => invocation, clock: () => now });
    const body = { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'stub-registered-assertion', resource: f.source.endpoint, scope: f.request.scope, authorization_details: requested('Consent', f.consent.identifier[0].value) };
    const issue = (scenario = 'consent-access', identities = [f.patient], source = f.source) => {
        const keys = { 'presence-check': ['presenceOrchestrator', 'PRESENCE', 'system/Patient.s'],
            'patient-authentication': ['authenticationOrchestrator', 'PATIENT-AUTHENTICATION', 'patient/Patient.s'],
            'dependent-discovery': ['discoveryOrchestrator', 'DEPENDENT-DISCOVERY', 'system/Patient.s system/RelatedPerson.s'] };
        if (scenario === 'consent-access') return service({ body: { ...body, resource: source.endpoint } });
        const [key, policy, scope] = keys[scenario];
        const clientId = f.config.oauthClients[key].clientId;
        if (scenario !== 'presence-check') invocation = { id: 'private-test-invocation', clientId, identifier: f.strongPatient,
            homeHmoId: source.dataSourceOrganization?.id || source.id, phase: scenario === 'dependent-discovery' ? 'authenticated' : 'authenticating', expiresAt: now + 100 };
        const identitiesForScenario = scenario === 'dependent-discovery' ? [] : scenario === 'patient-authentication' ? [f.strongPatient] : identities;
        return service({ clientId, body: { ...body, resource: source.endpoint, scope, authorization_details: requested('Contract', `PCM-POLICY-${policy}-001`, identitiesForScenario) } });
    };
    const inspect = (token, callerId = f.source.clientId, options = {}) => introspect({ ...options, callerId, body: { token, client_assertion_type: body.client_assertion_type, client_assertion: body.client_assertion } });
    /** New permissions/validity use the real pending -> decision lifecycle, never cloned approval metadata. */
    const newDecision = ({ scope = f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope,
        sources = [f.source.dataSourceOrganization.id], mode: approvedAccessMode = mode } = {}) => {
        const request = structuredClone(require('../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        request.patient = { identifier: f.strongPatient };
        request.extension.find(item => item.url === require('../src/shared/pcm-contract').EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${f.service.id}`;
        const lifecycle = require('../src/pcm-core/src/fhir/consent-lifecycle'), clock = () => new Date(now * 1000);
        const pending = lifecycle.createConsent({ store: f.store, config: f.config, request, clock, callerOrganization: f.store.get('Organization', f.client.organizationId) });
        return lifecycle.approveConsent({ store: f.store, consent: pending, scopeChoice: 'custom', customScope: scope, sourceOrganizationIds: sources, approvedAccessMode, clock });
    };
    const close = () => { tokenStore.close(); fs.rmSync(directory, { recursive: true, force: true }); };
    return { ...f, newDecision, directory, tokenStore, clients, service, body, issue, inspect, close, findClient,
        counters: () => ({ authentications, replays }), introspectionReplays: () => introspectionReplays, setNow: value => { now = value; },
        setInvocation: value => { invocation = value; } };
}

module.exports = { grantHarness, patients, requested };
