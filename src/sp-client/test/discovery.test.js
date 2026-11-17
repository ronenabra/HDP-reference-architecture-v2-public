'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConsentSourceBundle, recoverConsentCandidates } = require('../src/discovery');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS } = require('../src/constants');
const { planSourceAccess } = require('../src/data-source-access');

const source = index => ({
    resourceType: 'Organization', id: `ho-${index}`, active: true, name: `HO ${index}`,
    identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: `PCM-HO-${index}` }],
    endpoint: [{ reference: `Endpoint/ep-${index}` }]
});
const endpoint = index => ({
    resourceType: 'Endpoint', id: `ep-${index}`, status: 'active',
    address: `https://ho-${index}.example/r4${index === 3 ? '/' : ''}`
});

function bundle() {
    const consent = {
        resourceType: 'Consent', id: 'consent-1', status: 'active',
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.consent, value: 'PCM-CONSENT-1' }],
        patient: { identifier: { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573740' } },
        extension: [
            { url: EXTENSIONS.consentBusinessStatus, valueCoding: { system: CODE_SYSTEMS.consentBusinessStatus, code: 'active' } },
            { url: EXTENSIONS.pcmService, valueReference: { reference: 'HealthcareService/service-1' } }
        ],
        provision: { actor: [1, 2, 3].map(index => ({
            role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] },
            reference: { reference: `Organization/ho-${index}` }
        })) }
    };
    return {
        resourceType: 'Bundle', type: 'searchset', total: 1,
        entry: [
            { search: { mode: 'match' }, resource: consent },
            ...[1, 2, 3].flatMap(index => [{ search: { mode: 'include' }, resource: source(index) }, { search: { mode: 'include' }, resource: endpoint(index) }])
        ]
    };
}

test('SP-001 Consent includes return three distinct active HOs and source-specific access plans', () => {
    const parsed = parseConsentSourceBundle(bundle(), 'consent-1');
    assert.equal(parsed.active, true);
    assert.deepEqual(parsed.discoveredEndpoints.map(item => item.url), [
        'https://ho-1.example/r4', 'https://ho-2.example/r4', 'https://ho-3.example/r4/'
    ]);
    const plans = planSourceAccess('consent-1', parsed.discoveredEndpoints, 'patient/Observation.rs');
    assert.equal(new Set(plans.map(plan => plan.audience)).size, 3);
    assert.equal(new Set(plans.map(plan => plan.tokenCachePartition)).size, 3);
});

test('SP-001 Consent actor discovery never substitutes requestor and recovery preserves ambiguity', () => {
    const value = bundle();
    value.entry[0].resource.provision.actor = [{
        role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] },
        reference: { reference: 'Organization/ho-1' }
    }];
    assert.deepEqual(parseConsentSourceBundle(value, 'consent-1').discoveredEndpoints, []);
    const duplicate = structuredClone(value.entry[0]);
    duplicate.resource.id = 'consent-2';
    value.entry.push(duplicate);
    value.total = 2;
    const candidates = recoverConsentCandidates(value, {
        patientIdentifier: { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573740' }, serviceId: 'service-1'
    });
    assert.equal(candidates.length, 2);
});

test('SP-001 typed discovery rejects missing authoritative PCM business identifiers', () => {
    const missingConsentIdentifier = bundle();
    delete missingConsentIdentifier.entry[0].resource.identifier;
    assert.throws(() => parseConsentSourceBundle(missingConsentIdentifier, 'consent-1'), /Consent.*business identifier/);

    const missingOrganizationIdentifier = bundle();
    delete missingOrganizationIdentifier.entry.find(entry => entry.resource?.id === 'ho-1').resource.identifier;
    assert.throws(() => parseConsentSourceBundle(missingOrganizationIdentifier, 'consent-1'), /Organization\/ho-1.*business identifier/);
});
