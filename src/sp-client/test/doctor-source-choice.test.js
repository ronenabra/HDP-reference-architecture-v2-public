'use strict';
/** Exact UI source/address reconciliation never grants discovery or changes audiences. */
const test = require('node:test'), assert = require('node:assert/strict');
const { reconcileSourceChoice } = require('../../shared/ui/doctor-selection');
/** Minimal select supports the production projection; real DOM/controller is tested in browsers. */
function picker() {
    const node = { options: [], value: '', ownerDocument: { createElement: () => ({ dataset: {} }) }, append(option) {
        option.remove = () => { this.options = this.options.filter(item => item !== option); }; this.options.push(option);
    } };
    for (const [value, textContent] of [['', 'Choose a discovered data source'], ['https://a.example/fhir', 'Source A'], ['https://b.example/fhir', 'Source B']]) node.append({ value, textContent, dataset: {} });
    return node;
}
test('restored B and advanced known edits reflect the exact named source without rewriting addresses', () => {
    const control = picker(), target = { value: 'https://b.example/fhir' };
    reconcileSourceChoice(control, target); assert.equal(control.value, target.value); assert.equal(control.options.length, 3);
    target.value = 'https://a.example/fhir'; reconcileSourceChoice(control, target); assert.equal(control.value, target.value);
    assert.equal(control.options.find(option => option.value === target.value).textContent, 'Source A');
});
test('custom/whitespace targets are explicit, obsolete custom options clear, cards remain independent', () => {
    const first = picker(), second = picker();
    for (const value of ['https://custom.example/fhir', ' https://b.example/fhir ', 'https://custom.example/fhir?deliberate=1']) {
        const target = { value }; reconcileSourceChoice(first, target);
        assert.equal(first.value, value); assert.equal(target.value, value); assert.equal(first.options.length, 4);
        assert.equal(first.options.at(-1).textContent, 'Advanced target (not a discovered source)');
    }
    reconcileSourceChoice(second, { value: 'https://a.example/fhir' }); assert.equal(second.value, 'https://a.example/fhir');
    reconcileSourceChoice(first, { value: 'https://b.example/fhir' }); assert.equal(first.options.length, 3); assert.equal(second.value, 'https://a.example/fhir');
    reconcileSourceChoice(first, { value: '' }); assert.equal(first.value, ''); assert.equal(first.options.length, 3);
});

test('actual server render marks an advanced target instead of selecting a different discovered source', () => {
    const fs = require('node:fs'), path = require('node:path'), ejs = require('ejs');
    const fixture = require('../../../test-support/clinical-token-fixture').clinicalTokenFixture(), consent = fixture.consent;
    const A = 'https://a.example/fhir', B = 'https://b.example/fhir', custom = 'https://custom.example/fhir?literal=1';
    consent.discoveredEndpoint = A; consent.discoveredEndpoints = [{ name: 'Source A', url: A }, { name: 'Source B', url: B }];
    for (const target of [B, custom]) {
        const html = ejs.render(fs.readFileSync(path.resolve(__dirname, '../src/views/index.ejs'), 'utf8'), {
            teamId: 'source-unit', browserBase: '', identities: [{ id: 'hospital-a', label: 'Doctor' }], currentIdentity: 'hospital-a', publicBaseUrls: { pcmUi: 'http://pcm.test' },
            flash: null, conformance: { resultLabel: 'Sandbox', warnings: [] }, services: [], selectedPatientId: '000000018', patients: [],
            consents: [{ id: consent.id, consent, selectedEndpoint: target, data: null, service: { available: true, name: 'Owned service' }, approval: require('../src/approval-presentation').approvalPresentation(consent) }]
        });
        const select = html.slice(html.indexOf('<select id="source-'), html.indexOf('</select>', html.indexOf('<select id="source-')));
        assert.equal((select.match(/ selected/g) || []).length, 1);
        assert.match(select, new RegExp(`value="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*selected`));
        if (target === custom) assert.match(select, /Advanced target \(not a discovered source\)/);
        else assert.doesNotMatch(select, /Advanced target/);
        assert.match(html, new RegExp(`name="endpointUrl"[^>]*value="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    }
});
