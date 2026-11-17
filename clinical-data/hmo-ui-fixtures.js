'use strict';

/** Derive disposable ordinary-HMO UI data from maintained clinical and OTP fixtures. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { candidateWorkflowFixtures } = require('./pcm-ig-042-workflows');

/** Preserve the CI clinical records and add one explicitly eligible same-source PRN dependent.
 * @param {number} now Current milliseconds for the synthetic contact verification timestamp.
 * @returns {object} Transaction bundles and hashes; no enrollment configuration or credentials.
 */
function ordinaryHmoFixtures(now = Date.now()) {
    const maintained = candidateWorkflowFixtures().bundles['ho-a'].entry.find(entry => entry.resource.resourceType === 'Patient'
        && entry.resource.identifier?.some(id => id.system.endsWith('/il-national-id') && id.value === '000000018')).resource;
    return Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].map(id => {
        const original = fs.readFileSync(path.join(__dirname, 'ci', `${id}.source.transaction.json`));
        const bundle = JSON.parse(original);
        const parent = bundle.entry.find(entry => entry.resource.resourceType === 'Patient' && entry.resource.identifier?.some(identifier => identifier.value === '000000018'));
        parent.resource.birthDate = '1980-01-02'; parent.resource.telecom = structuredClone(maintained.telecom);
        for (const contact of parent.resource.telecom) for (const extension of contact.extension || []) for (const item of extension.extension || []) {
            if (item.url === 'verifiedAt') item.valueDateTime = new Date(now).toISOString();
        }
        // Existing explicit HTEST fixtures get test contact data only; enrollment remains optional and private.
        for (const entry of bundle.entry) if (entry.resource.resourceType === 'Patient' && entry.resource.identifier?.some(identifier => identifier.system.endsWith('/il-hdp-test-id'))) {
            entry.resource.birthDate = '1990-01-01'; entry.resource.telecom = structuredClone(parent.resource.telecom);
        }
        const child = structuredClone(parent);
        child.fullUrl = `urn:uuid:${crypto.randomUUID()}`; child.resource.id = `owned-dependent-${id}`;
        child.resource.identifier = [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000026' }];
        child.resource.name = [{ text: 'Owned HMO UI dependent' }]; child.resource.birthDate = '2010-01-01'; delete child.resource.telecom;
        child.request = { method: 'PUT', url: `Patient/${child.resource.id}` };
        bundle.entry.push(child, { fullUrl: `urn:uuid:${crypto.randomUUID()}`, resource: {
            resourceType: 'RelatedPerson', id: `owned-relationship-${id}`, meta: { ...structuredClone(parent.resource.meta), tag: [...structuredClone(parent.resource.meta.tag), { system: 'http://fhir.health.gov.il/cs/il-hdp-resource-tags', code: 'hmo-dependent-discovery' }] }, active: true,
            identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }], patient: { reference: `Patient/${child.resource.id}` },
            relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'PRN' }] }]
        }, request: { method: 'PUT', url: `RelatedPerson/owned-relationship-${id}` } });
        for (const entry of bundle.entry) for (const tag of entry.resource.meta?.tag || []) if (tag.system === 'urn:hdp-test-bundle:synthetic-dataset') tag.code = 'pcm-hmo-ui-owned-v1';
        return [id, { bundle, originalSha256: crypto.createHash('sha256').update(original).digest('hex') }];
    }));
}
module.exports = { ordinaryHmoFixtures };
