'use strict';
/** Execute the actual browser controller to distinguish passive restoration from changed context. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

/** Minimal DOM event surface; fetched panels and token facts remain observable state. */
async function restore(overrides = {}, { summary = false, fetched = true, serverEndpoint = 'https://source.test/fhir', sourceMembership } = {}) {
    const listeners = new Map(), calls = [], windowEvents = new Map(), windowHandlers = new Map();
    const field = (value = '', extra = {}) => ({ value, dataset: {}, options: [], addEventListener(name, callback) { const key = this.id + ':' + name; const handlers = listeners.get(key) || []; handlers.push(callback); listeners.set(key, handlers); },
        setCustomValidity() {}, setAttribute() {}, ...extra });
    const patient = field('urn:test|0001', { id: 'patient-id' }), system = field('urn:test', { id: 'patient-system-value' });
    const service = field('service', { id: 'service-id', options: [{ value: 'service', disabled: false }], selectedOptions: [{ value: 'service', dataset: {} }] });
    const request = { elements: { patientId: patient, patientSystem: system, serviceId: service }, identity: { value: 'app' }, serviceId: service, querySelector: () => null, addEventListener() {} };
    const facts = { removed: 0, token: { textContent: 'Fresh wildcard grant' }, status: { textContent: 'Current token' } };
    const inputs = [field(serverEndpoint, { id: 'source-1', name: 'endpointUrl' }), field('patient/Observation.s', { id: 'query-1', name: 'requestedScope' }), field('', { id: 'get-1', name: 'fhirGetRequest' })];
    const sourceForm = { dataset: { sourceConsentId: 'consent' }, consentId: { value: 'consent' }, querySelector: () => null }; inputs.forEach(input => { input.form = sourceForm; });
    const card = { dataset: { consentCard: 'consent', ...(sourceMembership === undefined ? {} : { sourceMembership }) }, querySelector: selector => selector === '[aria-label="Fetched FHIR data"]' && fetched ? {} : null,
        querySelectorAll(selector) {
            if (selector === '[aria-label="Fetched FHIR data"]') return [{ remove() { facts.removed++; } }];
            if (selector === '[data-token-details]') return [facts.token];
            if (selector === '[data-token-status]') return [facts.status];
            return [];
        } };
    inputs.forEach(input => { input.closest = selector => selector === '[data-consent-card]' ? card : null; });
    const nodes = { '.patient-modes': { addEventListener() {} }, '#patient-system': field('urn:test', { options: [{ value: 'urn:test' }] }), '#patient-system-feedback': {}, '#patient-resolved': {},
        '#configured-patient': field('', { options: [{ value: 'urn:test|0001', dataset: { patientName: 'Patient' } }] }), '#patient-feedback': {}, '#patient-name': {},
        '[data-patient-choices]': {}, '[data-patient-manual]': {}, '[data-manual-system]': {} };
    const summaryName = { dataset: { serviceFact: 'name' }, textContent: '' }, details = { open: true }, selectionStatus = { textContent: '' };
    const summaryPanel = { hidden: true, querySelectorAll: () => [summaryName], querySelector: () => details };
    if (summary) {
        nodes['[data-selected-service-summary]'] = summaryPanel; nodes['#service-selection-status'] = selectionStatus;
        service.selectedOptions[0].dataset.serviceSummary = JSON.stringify({ name: 'First service', readiness: 'Ready to request' });
    }
    const document = { body: { dataset: { browserBase: '/doctor' } },
        addEventListener(name, callback) { if (name === 'DOMContentLoaded') callback(); },
        querySelector(selector) { return selector === 'form[action$="/create-consent"]' ? request : nodes[selector] || null; },
        querySelectorAll(selector) {
            if (selector === '[data-consent-card]') return [card];
            if (selector.startsWith('[data-request-suggestion]') || selector.startsWith('input[name="endpointUrl"]')) return inputs;
            if (selector === '[aria-label="Fetched FHIR data"]') return [{ remove() { facts.removed++; } }];
            if (selector === '[data-token-details]') return [facts.token];
            if (selector === '[data-token-status]') return [facts.status];
            return [];
        } };
    const draft = { patientId: '0001', patientSystem: 'urn:test', serviceId: 'service', mode: 'manual', fields: { 'source-1': inputs[0].value, 'query-1': inputs[1].value }, ...overrides };
    const storage = new Map([['pcm-doctor-draft:/doctor:app', JSON.stringify(draft)]]);
    vm.runInNewContext(fs.readFileSync(process.env.PCM_DOCTOR_SELECTION_FIXTURE_SOURCE || path.resolve(__dirname, '../../shared/ui/doctor-selection.js'), 'utf8'), {
        document, window: {
            addEventListener(name, callback) {
                const handlers = windowHandlers.get(name) || new Set();
                handlers.add(callback); windowHandlers.set(name, handlers);
                windowEvents.set(name, (...args) => handlers.forEach(handler => handler(...args)));
            },
            removeEventListener(name, callback) { windowHandlers.get(name)?.delete(callback); }
        }, localStorage: { setItem() {} },
        sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; }
    });
    await new Promise(resolve => setImmediate(resolve));
    return { facts, calls, patient, system, service, inputs, listeners, summaryPanel, summaryName, details, selectionStatus, storage, windowEvents };
}

test('identical normalized tab draft preserves fresh clinical panels and grant without selection requests', async () => {
    const result = await restore();
    assert.equal(result.patient.value, '0001'); assert.equal(result.system.value, 'urn:test');
    assert.equal(result.facts.removed, 0); assert.equal(result.facts.token.textContent, 'Fresh wildcard grant');
    assert.equal(result.facts.status.textContent, 'Current token'); assert.deepEqual(result.calls, []);
});

test('GET override drafts restore and edits clear stale results through the existing selection fence', async () => {
    const result = await restore({ fields: { 'get-1': '/Observation?_summary=count' } });
    assert.equal(result.inputs[2].value, '/Observation?_summary=count');
    assert.equal(result.facts.removed, 1);
    result.calls.length = 0;
    result.inputs[2].value = '/Patient';
    for (const handler of result.listeners.get('get-1:input')) handler();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.facts.removed, 2);
    assert.deepEqual(result.calls, [{ identity: 'app', sourceConsentId: 'consent', fhirGetRequest: '/Patient' }]);
    result.windowEvents.get('pagehide')();
    assert.equal(JSON.parse(result.storage.get('pcm-doctor-draft:/doctor:app')).fields['get-1'], '/Patient');
});

test('a different restored patient still clears displayed authority and saves the exact changed context', async () => {
    const result = await restore({ patientId: '0002' });
    assert.equal(result.facts.removed, 1); assert.match(result.facts.token.textContent, /changed context/);
    assert.deepEqual(result.calls, [{ identity: 'app', patientId: '0002', patientSystem: 'urn:test', serviceId: 'service' }]);
});

test('changed restored source/query fields retain the existing invalidation fence', async () => {
    const result = await restore({ fields: { 'source-1': 'https://other-source.test/fhir', 'query-1': 'patient/Condition.s' } });
    assert.equal(result.inputs[0].value, 'https://other-source.test/fhir'); assert.equal(result.inputs[1].value, 'patient/Condition.s');
    assert.equal(result.facts.removed, 1); assert.equal(result.calls.length, 1);
});

test('an earlier empty source draft cannot erase a successful server-resolved source and its fresh results', async () => {
    const result = await restore({ fields: { 'source-1': '', 'query-1': 'patient/Observation.s' } });
    assert.equal(result.inputs[0].value, 'https://source.test/fhir');
    assert.equal(result.facts.removed, 0); assert.equal(result.facts.token.textContent, 'Fresh wildcard grant');
    assert.equal(result.facts.status.textContent, 'Current token'); assert.deepEqual(result.calls, []);
});

test('empty drafts without successful results and later deliberate source clearing retain invalidation', async () => {
    const unavailable = await restore({ fields: { 'source-1': '', 'query-1': 'patient/Observation.s' } }, { fetched: false });
    assert.equal(unavailable.inputs[0].value, ''); assert.equal(unavailable.facts.removed, 1); assert.equal(unavailable.calls.length, 1);
    const result = await restore(); result.inputs[0].value = '';
    for (const handler of result.listeners.get('source-1:input')) handler();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.facts.removed, 1);
    assert.deepEqual(result.calls, [{ identity: 'app', sourceConsentId: 'consent', endpointUrl: '' }]);
});

test('removed public sources cannot resurrect an old endpoint draft or trigger a passive selection', async () => {
    for (const sourceMemberships of [undefined, { consent: '["Organization/source-a"]' }]) {
        const result = await restore({ fields: { 'source-1': 'https://source.test/fhir', 'query-1': 'patient/Observation.s' }, sourceMemberships },
            { fetched: false, serverEndpoint: '', sourceMembership: '[]' });
        assert.equal(result.inputs[0].value, ''); assert.deepEqual(result.calls, []); assert.equal(result.facts.removed, 0);
    }
});

test('changed public source context keeps the current server endpoint while unchanged context preserves a deliberate override', async () => {
    const fields = { 'source-1': 'https://old-source.test/fhir', 'query-1': 'patient/Observation.s' };
    const changed = await restore({ fields, sourceMemberships: { consent: '["Organization/source-a"]' } },
        { fetched: false, serverEndpoint: 'https://current-source.test/fhir', sourceMembership: '["Organization/source-b"]' });
    assert.equal(changed.inputs[0].value, 'https://current-source.test/fhir'); assert.deepEqual(changed.calls, []);
    const deliberate = await restore({ fields, sourceMemberships: { consent: '["Organization/source-a"]' } },
        { sourceMembership: '["Organization/source-a"]' });
    assert.equal(deliberate.inputs[0].value, 'https://old-source.test/fhir'); assert.equal(deliberate.facts.removed, 1); assert.equal(deliberate.calls.length, 1);
});

test('tab drafts record only the visible public source membership beside existing non-secret fields', async () => {
    const result = await restore({}, { sourceMembership: '["Organization/source-a"]' });
    result.windowEvents.get('pagehide')();
    const draft = JSON.parse([...result.storage.values()][0]);
    assert.deepEqual(draft.sourceMemberships, { consent: '["Organization/source-a"]' });
    assert.equal(draft.fields['source-1'], 'https://source.test/fhir');
});

test('a deliberate target in the same empty source context remains an editable tab draft', async () => {
    const result = await restore({ fields: { 'source-1': 'https://manual-source.test/fhir', 'query-1': 'patient/Observation.s' }, sourceMemberships: { consent: '[]' } },
        { fetched: false, serverEndpoint: '', sourceMembership: '[]' });
    assert.equal(result.inputs[0].value, 'https://manual-source.test/fhir');
    assert.deepEqual(result.calls, [{ identity: 'app', patientId: '0001', patientSystem: 'urn:test', serviceId: 'service' }]);
    assert.equal(result.facts.removed, 1);
});


test('service changes replace one summary, close details, and empty selection removes stale readiness', async () => {
    const result = await restore({}, { summary: true });
    assert.equal(result.summaryPanel.hidden, false); assert.equal(result.summaryName.textContent, 'First service');
    assert.equal(result.details.open, false); result.details.open = true;
    result.service.value = 'second'; result.service.selectedOptions = [{ value: 'second', disabled: false, dataset: { serviceSummary: JSON.stringify({ name: 'Second service', readiness: 'Ready to request' }) } }];
    for (const handler of result.listeners.get('service-id:change')) handler();
    assert.equal(result.summaryName.textContent, 'Second service'); assert.equal(result.details.open, false);
    result.service.value = ''; result.service.selectedOptions = [{ value: '', disabled: false, dataset: {} }];
    for (const handler of result.listeners.get('service-id:change')) handler();
    assert.equal(result.summaryPanel.hidden, true);
    assert.equal(result.selectionStatus.textContent, 'Choose a connected service and review its details.');
    assert.deepEqual(result.calls, []);
});
