'use strict';
/** Execute the shipped selection handler across deferred fetch/body delivery and changed UI context. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

/** Minimal page ports keep these tests about observable draft, navigation and status effects. */
function page() {
    const element = () => ({ dataset: {}, listeners: {}, textContent: '', value: '', options: [{}],
        addEventListener(name, listener) { this.listeners[name] = listener; },
        querySelectorAll() { return []; }, replaceChildren() {} });
    const form = element(); form.elements = { identity: { value: 'hospital-a' } };
    const source = element(); source.value = 'ho-a'; source.selectedOptions = [{ textContent: 'Source A' }];
    const feedback = element(), nodes = { '#patient-load': form, '#sample-source': source, '#library-selection-state': feedback };
    const requests = [], locations = [], storage = new Map([['pcm-doctor-draft:/doctor:hospital-a', JSON.stringify({ selectedPatient: 'urn:original|0001', serviceId: 'service-1' })]]);
    const document = { body: { dataset: { browserBase: '/doctor' } }, listeners: {},
        addEventListener(name, listener) { this.listeners[name] = listener; },
        querySelector(selector) { return nodes[selector] ||= element(); }, querySelectorAll() { return []; } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../shared/ui/patient-library.js'), 'utf8'), {
        document, AbortController, URLSearchParams, FormData: class { constructor(selection) { return Object.entries(selection.elements).map(([key, field]) => [key, field.value]); } },
        sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        window: { addEventListener() {}, location: { assign: location => locations.push(location) } },
        fetch: url => url.endsWith('/select') ? new Promise(resolve => requests.push(resolve)) : Promise.resolve({ ok: true, json: async () => ({ patients: [], state: 'empty', rejected: 0 }) })
    });
    return { source, form, feedback, locations, storage, requests,
        select(value) {
            const button = { disabled: false }, selection = { action: '/doctor/patients/select', isConnected: true,
                elements: { patientId: { value }, identity: { value: 'hospital-a' } }, querySelector: () => button };
            return { button, selection, pending: document.listeners.submit({ target: selection, preventDefault() {} }) };
        } };
}

test('accepted current selection writes the exact patient and preserves the rest of the draft', async () => {
    const ui = page(), selected = ui.select('urn:passport|001aB');
    ui.requests[0]({ ok: true, json: async () => ({ location: '/doctor/?identity=hospital-a' }) }); await selected.pending;
    assert.deepEqual(JSON.parse([...ui.storage.values()][0]), { selectedPatient: 'urn:passport|001aB', serviceId: 'service-1' });
    assert.deepEqual(ui.locations, ['/doctor/?identity=hospital-a']);
});

test('successful selection body arriving after a source change has no draft or navigation effects', async () => {
    const ui = page(), before = [...ui.storage.values()][0], selected = ui.select('urn:passport|obsolete');
    let release, started;
    const bodyStarted = new Promise(resolve => { started = resolve; });
    ui.requests[0]({ ok: true, json: () => new Promise(resolve => { release = resolve; started(); }) });
    await bodyStarted;
    ui.source.value = 'ho-b'; ui.source.listeners.change();
    release({ location: '/doctor/?identity=hospital-a' }); await selected.pending;
    assert.equal([...ui.storage.values()][0], before); assert.deepEqual(ui.locations, []);
    assert.equal(ui.feedback.textContent, '');
});

test('new load and detached row fence an accepted selection, while rejection preserves the draft', async () => {
    for (const change of ['load', 'detached', 'rejected']) {
        const ui = page(), before = [...ui.storage.values()][0], selected = ui.select('urn:passport|obsolete');
        if (change === 'load') await ui.form.listeners.submit({ preventDefault() {} });
        if (change === 'detached') selected.selection.isConnected = false;
        ui.requests[0]({ ok: change !== 'rejected', text: async () => 'Selection rejected', json: async () => ({ location: '/doctor/' }) });
        await selected.pending;
        assert.equal([...ui.storage.values()][0], before, change); assert.deepEqual(ui.locations, [], change);
        assert.equal(ui.feedback.textContent, change === 'rejected' ? 'Patient not selected: Selection rejected' : '', change);
        assert.equal(selected.button.disabled, false, change);
    }
});

test('latest deliberate row selection wins and an older rejection cannot replace its status', async () => {
    for (const rejected of [false, true]) {
        const ui = page(), old = ui.select('urn:passport|obsolete'), current = ui.select('urn:passport|current');
        ui.requests[1]({ ok: true, json: async () => ({ location: '/doctor/?current' }) }); await current.pending;
        ui.requests[0]({ ok: !rejected, text: async () => 'Old error', json: async () => ({ location: '/doctor/?obsolete' }) }); await old.pending;
        assert.equal(JSON.parse([...ui.storage.values()][0]).selectedPatient, 'urn:passport|current');
        assert.deepEqual(ui.locations, ['/doctor/?current']); assert.doesNotMatch(ui.feedback.textContent, /Old error/);
        assert.equal(old.button.disabled, false);
    }
});
