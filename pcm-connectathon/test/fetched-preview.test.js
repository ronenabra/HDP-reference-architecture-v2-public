'use strict';

/** Focused extraction guards; the actual DOM/EJS selector proof runs in the pinned browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFetchedPreview } = require('../ui/tests/helpers/fetched-preview');

/** Supply only the requested named region, never an unrelated snapshot pre. */
function card(values, regions = 1) {
    return { getByRole(role, options) {
        assert.equal(role, 'region'); assert.deepEqual(options, { name: 'Fetched FHIR data', exact: true });
        return { count: async () => regions, locator(selector) {
            assert.equal(selector, 'pre'); return { allTextContents: async () => values };
        } };
    } };
}

test('fetched preview returns the actual Bundle and preserves a successful empty first page', async () => {
    for (const entry of [[], [{ resource: { resourceType: 'Patient', id: 'known-patient' } }, { resource: { resourceType: 'Condition', id: 'known-condition' } }]]) {
        const value = { resourceType: 'Bundle', type: 'collection', entry };
        assert.deepEqual(await readFetchedPreview(card([JSON.stringify(value)])), value);
    }
});
for (const [name, values, regions] of [
    ['missing region', ['{"model":"pcm-consent-scope/1"}'], 0],
    ['ambiguous region', ['{}'], 2],
    ['missing result', [], 1],
    ['multiple results', ['{}', '{}'], 1],
    ['malformed JSON', ['{invalid'], 1],
    ['saved approval JSON', ['{"model":"pcm-consent-scope/1","scope":"patient/Patient.rs"}'], 1],
    ['malformed Bundle', ['{"resourceType":"Bundle"}'], 1]
]) test(`fetched preview rejects ${name}`, async () => {
    await assert.rejects(readFetchedPreview(card(values, regions)), /Fetched FHIR/);
});
