'use strict';
/** Pinned public Simplifier 0.4.2 fixture regressions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateWriteRequest } = require('../src/fhir/contract');
const { assertSubmitRequest } = require('../src/fhir/consent-lifecycle');
const { classifyRegistrationRequest } = require('../src/fhir/healthcare-service-lifecycle');
const { validateSeedResource, CONSENT_POLICY, EXTENSIONS } = require('../../shared/pcm-contract');
const directory = path.resolve(__dirname, '../../../docs/FHIR-examples');
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));

test('public 0.4.2 request fixtures retain closed writes, proposed names and fixed Consent policy', () => {
    for (const [name, interaction] of [
        ['Organization-org-sp-hospital-a-submit.json', 'create'],
        ['Organization-org-sp-hospital-a-update.json', 'update'],
        ['Endpoint-endpoint-hmo-b-submit.json', 'create'],
        ['Consent-consent-request-hosp-a-cross-org-summary.json', 'create'],
        ['HealthcareService-svc-instance-hosp-a-new-service-submit.json', 'create']
    ]) {
        const resource = read(name);
        assert.doesNotThrow(() => validateWriteRequest(resource, { resourceType: resource.resourceType, interaction, id: resource.id }), name);
        assert.throws(() => validateWriteRequest({ ...resource, meta: { ...resource.meta, versionId: '1' } }, { resourceType: resource.resourceType, interaction, id: resource.id }), /Client-supplied/);
        if (resource.resourceType === 'Consent') {
            assert.doesNotThrow(() => assertSubmitRequest(resource));
            assert.deepEqual(resource.policy, [CONSENT_POLICY]);
            assert.throws(() => assertSubmitRequest({ ...resource, policyRule: {} }), /policyRule/);
        }
        if (resource.resourceType === 'HealthcareService') assert.equal(classifyRegistrationRequest(resource), 'new-service');
    }
});

test('public 0.4.2 Endpoint inventory and absolute Bundle identities remain server response fields', () => {
    for (const name of ['Endpoint-endpoint-hmo-b.json', 'Endpoint-endpoint-pcm-system.json']) {
        const endpoint = read(name);
        assert.deepEqual(validateSeedResource(endpoint), []);
        assert.ok(endpoint.extension.some(extension => extension.url === EXTENSIONS.applicableCertificates));
        assert.throws(() => validateWriteRequest(endpoint, { resourceType: 'Endpoint', interaction: 'update', id: endpoint.id }));
    }
    for (const name of fs.readdirSync(directory).filter(name => name.startsWith('Bundle-'))) {
        const bundle = read(name);
        if (bundle.type !== 'searchset') continue;
        for (const entry of bundle.entry || []) {
            assert.match(entry.fullUrl, /^https:\/\//, `${name}: absolute response identity`);
            assert.ok(entry.fullUrl.endsWith(`/${entry.resource.resourceType}/${entry.resource.id}`), name);
        }
    }
});
