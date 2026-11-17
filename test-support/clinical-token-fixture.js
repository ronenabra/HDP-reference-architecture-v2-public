'use strict';

/** Explicit disposable new approvals for exact clinical token tests. */
const { dataGrantFixture, rar, NOW } = require('./data-grants');
const { createConsent, approveConsent } = require('../src/pcm-core/src/fhir/consent-lifecycle');
const { EXTENSIONS, IDENTIFIER_SYSTEMS } = require('../src/shared/pcm-contract');
const { SYSTEM } = require('../src/shared/service-confidentiality-policy');
const V = `_security:not=${SYSTEM}|V`;
const EXACT = `patient/Patient.rs?${V} patient/Observation.s?status=final&date=ge2001-01-01&${V} patient/Observation.r?code=abc&${V} patient/Encounter.s?status=finished&${V}`;

/** Create/approve through the lifecycle; never attach synthetic authority to old decisions. */
function clinicalTokenFixture({ scope = EXACT, mode = 'continuous', now = NOW, duration } = {}) {
    const f = dataGrantFixture({ legacy: true });
    const clock = () => new Date(now * 1000);
    // Keep this owned service operational across the Consent deadline table.
    const service = f.store.get('HealthcareService', f.service.id);
    service.extension.find(item => item.url === EXTENSIONS.approvalWindow).valuePeriod.end = '2035-01-01T00:00:00Z';
    if (duration) service.extension.find(item => item.url === EXTENSIONS.accessDuration).valueDuration = { system: 'http://unitsofmeasure.org', ...duration };
    f.store.update(service);
    const request = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'), 'utf8');
    let sequence = 0;
    const approve = (patient = { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' }, customScope = scope, approvalOptions = {}) => {
        const body = JSON.parse(request); body.patient = { identifier: patient };
        body.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${f.service.id}`;
        const pending = createConsent({ store: f.store, callerOrganization: f.store.get('Organization', f.client.organizationId),
            request: body, clock, config: f.config, idGenerator: () => `clinical-new-${++sequence}` });
        return approveConsent({ store: f.store, consent: pending, scopeChoice: 'custom', customScope,
            ...approvalOptions, approvedAccessMode: mode, sourceOrganizationIds: f.config.healthOrganizations.map(source => source.dataSourceOrganization.id), clock });
    };
    const consent = approve();
    // Invalid advisory approvals still need a syntactically valid request to exercise rejection.
    const ceiling = scope.trim() ? require('../src/shared/service-grant').inspectScope(scope).requestCeiling : 'patient/Patient.rs';
    return { ...f, approve, consent, request: { ...f.request, requested: rar('Consent', consent.identifier[0].value), scope: ceiling, now }, scope, clock };
}

module.exports = { clinicalTokenFixture, V, EXACT };
