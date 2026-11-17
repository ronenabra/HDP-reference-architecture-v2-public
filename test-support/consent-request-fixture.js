'use strict';

/** Current producer/private-owner fixture for advisory Consent requests only. */
const { buildTeamConfig } = require('./team-config');
const { FHIRStore } = require('../src/pcm-core/src/fhir/store');
const { buildSeedDrafts } = require('../src/pcm-core/src/bootstrap');
const { publishNewResource } = require('../src/pcm-core/src/public-fhir');
const lifecycle = require('../src/pcm-core/src/fhir/consent-lifecycle');
const { EXTENSIONS } = require('../src/shared/pcm-contract');
const { rar } = require('./data-grants');
const NOW = Date.parse('2026-11-13T12:00:00Z') / 1000;
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
const EXACT = `patient/Patient.rs?${V} patient/Observation.rs?status=final&${V}`;
const REQUESTS = Object.freeze({ equal: 'patient/Patient.rs patient/Observation.rs',
    narrower: 'patient/Observation.s', broader: 'patient/Patient.rs patient/Observation.rs patient/Condition.rs',
    different: 'patient/Unknown.rs patient/Organization.s' });
const PRESETS = ['strict', 'connectathon-mtls', 'connectathon-balanced', 'connectathon-easy'];
const CATALOG = { file: 'config/demo-services.json', bindings: [{ serviceKey: 'lab-follow-up', application: 'serviceProvider',
    providerRole: 'serviceProvider', instanceId: 'request-lab-follow-up', instanceIdentifier: 'REQUEST-LAB' }] };

/** Publish a fresh graph and freeze a real approval; never reconstruct legacy authority. */
function consentRequestFixture({ preset = 'strict', now = NOW, mode = 'continuous', store, config } = {}) {
    config ||= buildTeamConfig({ serviceCatalog: CATALOG }, preset);
    const clock = () => new Date(now * 1000);
    store ||= new FHIRStore({ clock });
    for (const draft of buildSeedDrafts(config, {}, clock)) publishNewResource(store, draft);
    require('../src/pcm-core/src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    const client = { clientId: config.organizations.serviceProvider.clientId, organizationId: config.organizations.serviceProvider.id,
        role: 'service-provider', scopes: ['system/*.crus'], mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43) };
    const source = config.healthOrganizations[0];
    const service = store.get('HealthcareService', 'request-lab-follow-up');
    const create = () => {
        const request = structuredClone(require('../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        request.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
        request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${service.id}`;
        return lifecycle.createConsent({ store, config, callerOrganization: store.get('Organization', client.organizationId), request, clock });
    };
    const approve = (scope = EXACT) => lifecycle.approveConsent({ store, consent: create(), scopeChoice: 'custom', customScope: scope,
        approvedAccessMode: mode, sourceOrganizationIds: [source.dataSourceOrganization.id], clock });
    const consent = approve(), windows = new Map();
    const firstUseStore = { get: key => windows.get(key) || null, getOrStart(key, seconds, at) {
        if (!windows.has(key)) windows.set(key, { ok: true, startedAt: at, expiresAt: at + seconds });
        return windows.get(key);
    } };
    return { store, config, client, source, service, consent, create, approve, windows, firstUseStore,
        request: { store, config, client, firstUseStore, requested: rar('Consent', consent.identifier[0].value),
            scope: REQUESTS.equal, resource: source.endpoint, now } };
}

module.exports = { consentRequestFixture, NOW, V, EXACT, REQUESTS, PRESETS, CATALOG };
