'use strict';

/** Isolated PCM resources and explicit synthetic workflow entitlements. */
const { buildTeamConfig } = require('./team-config');
const { FHIRStore } = require('../src/pcm-core/src/fhir/store');
const { buildSeedDrafts } = require('../src/pcm-core/src/bootstrap');
const { syncDataSourcesToStore } = require('../src/pcm-core/src/data-sources');
const { provisionSystemPolicies } = require('../src/pcm-core/src/fhir/system-policy');
const { TYPE, ROLE_BASE, BASIS_SYSTEMS, parseAuthorizationDetails } = require('../src/pcm-core/src/rar-request');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS } = require('../src/shared/pcm-contract');
const NOW = Date.parse('2026-10-04T12:00:00Z') / 1000;

/** Serialize and parse the same RAR shape used by the HTTP request classifier. */
function rar(type, value, patients = []) {
    return parseAuthorizationDetails(JSON.stringify([{ type: TYPE, fhirContext: [
        { type, role: `${ROLE_BASE}authorization-basis`, identifier: { system: BASIS_SYSTEMS[type], value } },
        ...patients.map(identifier => ({ type: 'Patient', role: `${ROLE_BASE}authorization-patient`, identifier }))
    ] }]));
}

/** Build a fresh authority graph and a transparent local first-use repository. */
function dataGrantFixture({ legacy = false, mode = 'continuous', now = NOW } = {}) {
    const config = buildTeamConfig();
    config.service.accessMode = mode;
    const store = new FHIRStore();
    syncDataSourcesToStore(store, config, 'A'.repeat(43));
    for (const resource of buildSeedDrafts(config, {}, () => new Date(now * 1000))) require('../src/pcm-core/src/public-fhir').publishNewResource(store, resource);
    const patient = { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' };
    const strongPatient = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
    config.systemAuthorization.presenceEligiblePatients = [patient];
    config.systemAuthorization.participatingHmos = [config.healthOrganizations[0].id];
    config.systemAuthorization.memberships = [{ identifier: strongPatient, homeHmoId: config.healthOrganizations[0].id }];
    provisionSystemPolicies(store, config, now);
    const service = store.get('HealthcareService', config.service.id);
    const source = config.healthOrganizations[0];
    let consent = legacy ? store.add({ resourceType: 'Consent', id: 'consent-test',
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.consent, value: 'BUSINESS-CONSENT-1' }],
        status: 'active', patient: { identifier: patient },
        category: [{ coding: [{ system: CODE_SYSTEMS.consentAccessMode, code: 'continuous' }] }],
        extension: [{ url: EXTENSIONS.consentBusinessStatus, valueCoding: { system: CODE_SYSTEMS.consentBusinessStatus, code: 'active' } },
            { url: EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${service.id}` } }],
        provision: { period: { start: new Date((now - 1) * 1000).toISOString(), end: new Date((now + 100000) * 1000).toISOString() },
            actor: [{ reference: { reference: `Organization/${config.organizations.serviceProvider.id}` }, role: { coding: [{ code: 'IRCP' }] } },
                { reference: { reference: `Organization/${source.dataSourceOrganization.id}` }, role: { coding: [{ code: 'CST' }] } }] }
    }) : null;
    if (!legacy) {
        const body = structuredClone(require('../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        body.patient = { identifier: patient };
        body.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${service.id}`;
        consent = require('../src/pcm-core/src/fhir/consent-lifecycle').createConsent({ store, config,
            callerOrganization: store.get('Organization', config.organizations.serviceProvider.id), request: body,
            clock: () => new Date(now * 1000), idGenerator: () => 'consent-test' });
        // Initial fixture source selection is an allowed source-only change; the exact approval stays frozen.
        consent.provision.actor = consent.provision.actor.filter(actor => !actor.role?.coding?.some(code => code.code === 'CST')
            || actor.reference.reference === `Organization/${source.dataSourceOrganization.id}`);
        consent = store.update(consent);
    }
    const windows = new Map();
    const firstUseStore = {
        get: key => windows.get(key) || null,
        getOrStart(key, duration, now) {
            if (!windows.has(key)) windows.set(key, { ok: true, startedAt: now, expiresAt: now + duration });
            return windows.get(key);
        }
    };
    // Deliberate test-double role evidence; real HTTPS qualification uses owned certificates.
    const client = { clientId: config.organizations.serviceProvider.clientId, organizationId: config.organizations.serviceProvider.id, role: 'service-provider',
        mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) };
    const request = { store, config, firstUseStore, client, requested: rar('Consent', consent.identifier[0].value), scope: legacy ? 'patient/Observation.rs' : require('../src/shared/service-grant').inspectScope(store.privateRecords.approvals.getDecision(consent.id).snapshot.scope).requestCeiling, resource: source.endpoint, now };
    return { store, config, patient, strongPatient, service, source, consent, windows, firstUseStore, client, request };
}

module.exports = { NOW, dataGrantFixture, rar };
