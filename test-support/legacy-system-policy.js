'use strict';

/** Synthetic retained graph for application migration tests; not a canonical 0.4.0 payload. */
const BASE = 'http://pcm.fhir.health.gov.il';

/** Build an independent legacy pair with explicit historical permission-bearing fields. */
function legacyPair(suffix, owner = 'Organization/org-pcm-system') {
    if (!['presence', 'patient-authentication', 'dependent-discovery'].includes(suffix)) throw new TypeError('Unknown legacy fixture scenario');
    const scenario = suffix === 'presence' ? 'presence-check' : suffix;
    const coding = (system, code) => ({ coding: [{ system: `${BASE}/cs/${system}`, code }] });
    const issued = '2025-01-01T00:00:00Z';
    // Match the sandbox catalog identities so retained catalog reconciliation remains exercised.
    const service = {
        resourceType: 'HealthcareService', id: `system-service-${suffix}`,
        meta: { profile: [`${BASE}/StructureDefinition/pcm-system-healthcareservice`],
            tag: [{ system: `${BASE}/cs/pcm-meta-tag`, code: 'system-service' }], lastUpdated: issued },
        identifier: [{ use: 'official', system: `${BASE}/identifier/pcm-system-healthcareservice-id`, value: `PCM-SERVICE-${suffix.toUpperCase()}-001` }],
        type: [coding('pcm-authorization-scenario', scenario)], active: true, providedBy: { reference: owner },
        name: `Synthetic migration ${scenario}`, extraDetails: `Synthetic retained ${scenario} graph for migration safety.`,
        extension: [{ url: `${BASE}/StructureDefinition/ext-example-query`, valueString: 'GET [FHIR BASE]/Patient?identifier=[SYSTEM]|[VALUE]' }]
    };
    const contract = {
        resourceType: 'Contract', id: `policy-${suffix}`,
        meta: { profile: [`${BASE}/StructureDefinition/pcm-${suffix}-authorization-contract`], lastUpdated: issued },
        identifier: [{ use: 'official', system: `${BASE}/identifier/pcm-data-access-authorization-id`, value: `PCM-POLICY-${suffix.toUpperCase()}-001` }],
        status: 'policy', issued, applies: { start: issued, end: '2035-01-01T00:00:00Z' }, author: { reference: owner },
        topicReference: { reference: `HealthcareService/${service.id}` },
        type: coding('pcm-authorization-vocabulary', 'data-access-authorization'), subType: [coding('pcm-authorization-scenario', scenario)],
        term: [{ offer: { party: [{ reference: [{ reference: owner }], role: coding('pcm-authorization-vocabulary', 'grantee') }] },
            asset: [{ type: [coding('pcm-authorization-target', suffix === 'presence' ? 'all-active-data-sources' : 'participating-hmos')] }],
            action: [{ type: coding('pcm-authorization-vocabulary', 'access-fhir-data'),
                intent: coding('pcm-authorization-scenario', scenario), status: coding('pcm-authorization-vocabulary', 'authorized') }] }]
    };
    return { contract, service };
}

module.exports = { legacyPair };
