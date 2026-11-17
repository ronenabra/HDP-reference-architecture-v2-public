'use strict';
/** Run actual browser library handlers against a tiny DOM to check transport and generated form destinations. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
/** Model standard DOM tree/form lookup, independent of library state transitions. */
function element() {
    return { dataset: {}, children: [], listeners: {}, value: '', options: [{}],
        addEventListener(name, callback) { this.listeners[name] = callback; },
        append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
        querySelectorAll(selector) {
            const matches = node => selector === '[data-patient-row]' ? Object.hasOwn(node.dataset, 'patientRow')
                : selector === '[name="patientId"]' ? node.name === 'patientId' : node.tagName === selector;
            return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    };
}
/** Supply the current semantic table controls; no hidden source requests are simulated. */
function documentFor(nodes, base) {
    return { addEventListener() {}, body: { dataset: { browserBase: base } },
        querySelector: selector => nodes[selector] ||= element(), querySelectorAll: () => [],
        createElement: tagName => Object.assign(element(), { tagName }) };
}
const browserWindow = { addEventListener() {} };
for (const base of ['', '/doctor']) test(`library browser requests and newly rendered selections retain ${base || 'root'} mount`, async () => {
    const form = element(); form.elements = { identity: { value: 'hospital-a' } };
    const source = element(); source.value = 'ho-a'; source.selectedOptions = [{ textContent: 'HMO A' }];
    const status = element(), results = element(), cancel = element();
    const nodes = { '#patient-load': form, '#sample-source': source, '#sample-state': status, '#sample-results': results, '#sample-cancel': cancel };
    const calls = [];
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../shared/ui/patient-library.js'), 'utf8'), {
        AbortController, window: browserWindow, document: documentFor(nodes, base),
        fetch: async url => { calls.push(url); return { ok: true, json: async () => ({ state: 'loaded', sourceName: 'HMO A', refreshedAt: 'now', patients: [{ display: '<plain text>', idSystem: 'urn:test', idValue: '0001' }] }) }; }
    });
    await form.listeners.submit({ preventDefault() {} });
    assert.deepEqual(calls, [`${base}/patients/load`]);
    const selection = results.querySelector('form');
    assert.equal(selection.action, `${base}/patients/select`);
    assert.equal(selection.querySelector('[name="patientId"]').value, 'urn:test|0001');
    assert.equal(results.children[0].children[0].textContent, '<plain text>', 'untrusted display remains text in the semantic row');
    source.listeners.change();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.at(-1), `${base}/patients/source`); assert.equal(results.children.length, 0);
});


test('a late browser sample cannot replace a newer source choice or create a selection', async () => {
    const form = element(); form.elements = { identity: { value: 'hospital-a' } };
    const source = element(); source.value = 'ho-a'; source.selectedOptions = [{ textContent: 'Source A' }];
    const state = element(), results = element(), cancel = element(), calls = [];
    let release;
    const nodes = { '#patient-load': form, '#sample-source': source, '#sample-state': state, '#sample-results': results, '#sample-cancel': cancel };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../shared/ui/patient-library.js'), 'utf8'), {
        AbortController, window: browserWindow, document: documentFor(nodes, '/doctor'),
        fetch: async url => { calls.push(url); if (url.endsWith('/load')) return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ generation: 2, state: 'loaded', patients: [{ idSystem: 'urn:old', idValue: 'former', display: 'Old name' }] }) }); }); return { ok: true }; }
    });
    assert.deepEqual(calls, []);
    const pending = form.listeners.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    source.value = 'ho-b'; await source.listeners.change(); release(); await pending;
    assert.equal(results.children.length, 0); assert.match(state.textContent, /^Not loaded — Source A — 0 candidates/);
    assert.deepEqual(calls, ['/doctor/patients/load', '/doctor/patients/source']);
});
