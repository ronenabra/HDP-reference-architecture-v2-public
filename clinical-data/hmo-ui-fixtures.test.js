'use strict';
/** Ordinary fixture compatibility with maintained import and source-specific relationship joining. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ordinaryHmoFixtures } = require('./hmo-ui-fixtures');
const { inspectTransactionBundle } = require('./transaction-bundle');
test('derived HMO fixtures retain clinical IDs and valid same-source dependent references', () => {
    for (const [id, { bundle, originalSha256 }] of Object.entries(ordinaryHmoFixtures(Date.parse('2026-11-06T00:00:00Z')))) {
        const original = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci', `${id}.source.transaction.json`)));
        assert.match(originalSha256, /^[a-f0-9]{64}$/);
        for (const entry of original.entry) assert.ok(bundle.entry.some(item => item.resource.resourceType === entry.resource.resourceType && item.resource.id === entry.resource.id));
        const related = bundle.entry.find(item => item.resource.resourceType === 'RelatedPerson').resource;
        const child = bundle.entry.find(item => `Patient/${item.resource.id}` === related.patient.reference).resource;
        assert.equal(child.identifier[0].value, '000000026'); assert.equal(related.relationship[0].coding[0].code, 'PRN');
        assert.equal(child.telecom, undefined);
        assert.ok(related.meta.tag.some(tag => tag.system === 'http://fhir.health.gov.il/cs/il-hdp-resource-tags' && tag.code === 'hmo-dependent-discovery'));
        const inspected = inspectTransactionBundle(Buffer.from(JSON.stringify(bundle)));
        assert.equal(inspected.entries, original.entry.length + 2);
    }
});
