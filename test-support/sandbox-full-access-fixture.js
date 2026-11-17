'use strict';
/** Current public producer/private approval fixture for the exact built-in grant. */
const { consentRequestFixture } = require('./consent-request-fixture');
const serviceLifecycle = require('../src/pcm-core/src/fhir/healthcare-service-lifecycle');
const consentLifecycle = require('../src/pcm-core/src/fhir/consent-lifecycle');
const { EXTENSIONS } = require('../src/shared/pcm-contract');
const { rar } = require('./data-grants');

/** Provision the real built-in association, then explicitly approve its whole saved scope. */
function fullAccessFixture(options = {}) {
    const f = consentRequestFixture(options), now = options.now || require('./consent-request-fixture').NOW;
    const clock = () => new Date(now * 1000);
    const service = serviceLifecycle.enrollProviderDefault({ store: f.store, provider: f.store.get('Organization', f.client.organizationId), clock });
    const create = () => {
        const request = structuredClone(require('../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        request.patient.identifier = f.consent.patient.identifier;
        request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${service.id}`;
        return consentLifecycle.createConsent({ store: f.store, config: f.config, callerOrganization: f.store.get('Organization', f.client.organizationId), request, clock });
    };
    const approve = (scope, extra = {}) => consentLifecycle.approveConsent({ store: f.store, consent: create(), clock,
        sourceOrganizationIds: [f.source.dataSourceOrganization.id], approvedAccessMode: options.mode || 'continuous',
        scopeChoice: scope === undefined ? 'service-provided' : 'custom', customScope: scope, ...extra });
    const consent = approve();
    return { ...f, service, consent, create, approve, request: { ...f.request, requested: rar('Consent', consent.identifier[0].value) } };
}
module.exports = { fullAccessFixture };
