'use strict';
/** Complete source-simulation authority fixtures. */
const fs = require('fs'), path = require('path');
const { dataGrantFixture, NOW, rar } = require('./data-grants');
const { createConsent, approveConsent } = require('../src/pcm-core/src/fhir/consent-lifecycle');
const changes = require('../src/pcm-core/src/fhir/sandbox-source-change');
const { EXTENSIONS } = require('../src/shared/pcm-contract');
/** Create a fresh active ordinary Consent and explicit operational source graph. */
function fixture(mode = 'continuous', automatic = false) {
    const f = dataGrantFixture();
    f.config.conformance = { ...f.config.conformance, mode: 'connectathon', preset: 'connectathon-easy' };
    f.now = NOW;
    const clock = () => new Date(f.now * 1000);
    const request = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
    delete request.id; request.patient.identifier = automatic ? f.patient : f.strongPatient;
    request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${f.service.id}`;
    // New disposable approvals opt in to the exact creation model. This is not a
    // retained-state conversion; no historical approval is relabelled.
    const canonicalId = require('../src/pcm-core/src/fhir/healthcare-service-lifecycle').basedOnId(f.service);
    const canonical = f.store.get('HealthcareService', canonicalId);
    require('./private-definition').replaceDefinition(f.store, canonical, {
        name: 'Disposable source lifecycle service', purpose: 'Source and cancellation invariants', category: '35',
        accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: true,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 'rs' }, { type: 'DiagnosticReport', actions: 'rs' }], scopeOrigin: 'generated'
    }, { now: NOW });
    f.consent = createConsent({ store: f.store, callerOrganization: f.store.get('Organization', f.client.organizationId), request, clock });
    f.ids = f.config.healthOrganizations.map(source => source.dataSourceOrganization.id);
    if (!automatic) f.consent = approveConsent({ store: f.store, consent: f.consent, sourceOrganizationIds: [f.ids[0]], approvedAccessMode: mode, clock });
    f.createPending = () => createConsent({ store: f.store, callerOrganization: f.store.get('Organization', f.client.organizationId),
        request: { ...request, patient: { identifier: f.strongPatient } }, clock });
    f.events = [];
    f.change = (ids, version = f.store.get('Consent', f.consent.id).meta.versionId) => changes.simulateSourceChange({ store: f.store, config: f.config, consentId: f.consent.id,
        expectedVersion: version, sourceOrganizationIds: ids, actor: 'test-operator', sessionId: 'test-session', audit: event => f.events.push(event), clock });
    f.request = { ...f.request, requested: rar('Consent', f.consent.identifier[0].value), scope: require('../src/shared/service-grant').inspectScope(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope).requestCeiling, config: f.config };
    return f;
}
module.exports = { fixture };
