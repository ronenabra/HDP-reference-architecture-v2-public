'use strict';
/** Explicit disposable candidate fixtures; existing 0.4.0 and retained datasets stay unchanged. */
const { CONTACT_EVIDENCE, OTP_PURPOSE, PURPOSE_SYSTEM } = require('../src/pcm-core/src/system-workflows');
const crypto = require('node:crypto');
const { DATASET_TAG_SYSTEM, inspectTransactionBundle } = require('./transaction-bundle');
const ID = 'http://fhir.health.gov.il/identifier/il-hdp-test-id';
const DEMOGRAPHICS = { system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'patientDemographics' };
const DISCOVERY = { system: 'http://fhir.health.gov.il/cs/il-hdp-resource-tags', code: 'hmo-dependent-discovery' };

/** Build small independently labelled HTEST lookup fixtures with fresh local contact evidence. */
function candidateWorkflowFixtures(now = Date.now()) {
    const configuration = structuredClone(require('./pcm-ig-040/workflow-config.json'));
    configuration.memberships[0].localSso = { birthDate: '1980-01-02', display: 'Fabricated Israeli national identity', name: [{ text: 'Fabricated trusted SSO representative' }] };
    for (const value of ['1', '2']) {
        const identifier = { system: ID, value };
        configuration.memberships.push({ identifier, homeHmoId: value === '1' ? 'ho-a' : 'ho-b', sandboxFixture: true, fixtureBirthDate: '1990-01-01' });
        configuration.presenceEligiblePatients.push(identifier);
    }
    const portalIdentities = [{ system: 'http://fhir.health.gov.il/identifier/pna-national-id', value: '000123' },
        { system: 'http://hl7.org/fhir/sid/passport-USA', value: 'FABRICATED042' }];
    for (const identifier of portalIdentities) configuration.memberships.push({ identifier, homeHmoId: 'ho-c',
        ...(identifier.system.includes('passport') ? { loginEligibility: { foreignPassportEligible: true, israeliNationalWithId: false } } : {}),
        localSso: { birthDate: '1990-01-01', display: `Fabricated ${identifier.value}`, name: [{ text: 'Fabricated eligible identity' }] } });
    const bundles = Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].map(ho => {
        const bundle = structuredClone(require(`./pcm-ig-040/${ho}.transaction.json`));
        for (const entry of bundle.entry) {
            const resource = entry.resource;
            resource.meta.security = [...(resource.meta.security || []), DEMOGRAPHICS];
            if (resource.resourceType === 'RelatedPerson') resource.meta.tag.push(DISCOVERY);
            for (const contact of resource.telecom || []) for (const extension of contact.extension || []) if (extension.url === CONTACT_EVIDENCE) {
                extension.extension.find(value => value.url === 'verifiedAt').valueDateTime = new Date(now).toISOString();
            }
        }
        for (const value of ['1', '2']) {
            const other = value === '1' ? '2' : '1';
            const resources = [{ resourceType: 'Patient', id: `htest-${value}`, identifier: [{ system: ID, value }], name: [{ text: `HTEST ${value} fixture simulation` }], birthDate: '1990-01-01',
                telecom: [{ system: 'sms', value: '+972500000000', extension: [
                    { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
                    { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(now).toISOString() }] }
                ] }], meta: { security: [DEMOGRAPHICS, { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }], tag: [{ system: 'urn:hdp-test-bundle:synthetic-source', code: ho }] } },
            { resourceType: 'RelatedPerson', id: `htest-representative-${value}`, identifier: [{ system: ID, value }], patient: { reference: `Patient/htest-${other}` }, active: true,
                relationship: [{ coding: configuration.eligibleRelationships }], meta: { security: [DEMOGRAPHICS, { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }], tag: [DISCOVERY, { system: 'urn:hdp-test-bundle:synthetic-source', code: ho }] } }];
            bundle.entry.push(...resources.map(resource => ({ resource, request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` } })));
        }
        if (ho === 'ho-c') for (const [index, identifier] of portalIdentities.entries()) {
            const resource = structuredClone(bundle.entry.find(entry => entry.resource.id === 'htest-1').resource);
            resource.id = `portal-eligible-${index}`; resource.identifier = [identifier]; resource.name = [{ text: 'Fabricated eligible identity' }];
            bundle.entry.push({ resource, request: { method: 'PUT', url: `Patient/${resource.id}` } });
        }
        const sample = { resourceType: 'Patient', id: 'candidate-sample', identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-sandbox-synthetic-id', value: '11111111-1111-4111-8111-111111111111' }], name: [{ text: 'Candidate synthetic sampler' }],
            meta: { security: [DEMOGRAPHICS, { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }], tag: [{ system: 'urn:hdp-test-bundle:synthetic-source', code: ho }] } };
        bundle.entry.push({ resource: sample, request: { method: 'PUT', url: 'Patient/candidate-sample' } });
        // Every added resource must satisfy the same maintained import boundary as the original fixtures.
        for (const entry of bundle.entry) {
            if (!entry.fullUrl) {
                const hex = crypto.createHash('sha256').update(`pcm-ig-042:${ho}:${entry.request.url}`).digest('hex');
                entry.fullUrl = `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
            }
            entry.resource.meta.tag = [...entry.resource.meta.tag.filter(tag => tag.system !== DATASET_TAG_SYSTEM),
                { system: DATASET_TAG_SYSTEM, code: 'pcm-ig-042-system-workflows' }];
        }
        inspectTransactionBundle(Buffer.from(JSON.stringify(bundle)), { expectedSource: ho });
        return [ho, bundle];
    }));
    return { configuration, bundles };
}
module.exports = { candidateWorkflowFixtures };
