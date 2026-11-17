'use strict';
/** Exercise browser command state without mutating a runtime Consent. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../../shared/ui/source-change.js'), 'utf8');

/** Create a minimal source form with injectable command responses. */
function fixture(fetch) {
    const listeners = {}, apply = { disabled: true, dataset: {} }, result = { textContent: '' };
    const cancel = { addEventListener: (_, fn) => { listeners.cancel = fn; } };
    const inputs = [
        { value: 'A', checked: true, disabled: false, dataset: {} },
        { value: 'B', checked: false, disabled: false, dataset: {} },
        { value: 'C', checked: false, disabled: true, dataset: {} }
    ];
    const form = {
        action: '/command', elements: { expectedVersion: { value: '2' }, csrf: { value: 'token' } },
        querySelector: selector => ({ '[data-source-result]': result, '[data-source-apply]': apply, '[data-source-cancel]': cancel })[selector],
        querySelectorAll: () => inputs,
        addEventListener: (name, fn) => { listeners[name] = fn; },
        reset: () => { inputs.forEach((input, index) => { input.checked = index === 0; }); }
    };
    let reloads = 0;
    vm.runInNewContext(script, { document: { querySelector: () => form }, fetch, window: { location: { reload: () => { reloads++; } } } });
    return { inputs, apply, cancel, result, listeners, submit: () => listeners.submit({ preventDefault() {} }), reloads: () => reloads };
}

test('unchanged and cancelled selections cannot submit; Apply directly saves zero sources', async () => {
    const commands = [];
    const f = fixture(async (_, options) => { commands.push(JSON.parse(options.body)); return { ok: true, json: async () => ({}) }; });
    assert.equal(f.apply.dataset.helpDisabledKey, 'pcm.source-unchanged');
    await f.submit(); assert.equal(commands.length, 0); assert.equal(f.cancel.disabled, true);
    f.inputs[1].checked = true; f.listeners.change(); assert.equal(f.apply.disabled, false); assert.equal(f.cancel.disabled, false);
    f.inputs[1].checked = false; f.listeners.change(); assert.equal(f.apply.disabled, true); assert.equal(f.cancel.disabled, true);
    f.inputs[1].checked = true; f.listeners.change();
    f.listeners.cancel(); assert.equal(f.apply.disabled, true); assert.equal(f.cancel.disabled, true);
    f.inputs[0].checked = false; f.listeners.change(); await f.submit();
    assert.deepEqual(commands, [{ action: 'apply', sourceIds: [], expectedVersion: '2', csrf: 'token' }]);
    assert.equal(f.reloads(), 1); assert.equal(f.inputs[2].disabled, true);
});

test('an in-flight Apply blocks duplicate submissions and locks source choices', async () => {
    let resolve, count = 0;
    const f = fixture(() => { count++; return new Promise(done => { resolve = done; }); });
    f.inputs[1].checked = true; f.listeners.change();
    const pending = f.submit(); assert.equal(f.apply.disabled, true);
    assert.equal(f.apply.dataset.helpDisabledKey, 'pcm.source-saving');
    assert.equal(f.cancel.disabled, true);
    assert.ok(f.inputs.every(input => input.disabled)); await f.submit(); assert.equal(count, 1);
    resolve({ ok: true, json: async () => ({}) }); await pending;
});

for (const status of [403, 409]) {
    test(`status ${status} prevents another Apply until refresh`, async () => {
        const f = fixture(async () => ({ ok: false, status, json: async () => ({ error: 'Refresh required' }) }));
        f.inputs[1].checked = true; f.listeners.change(); await f.submit();
        assert.equal(f.apply.disabled, true); assert.match(f.result.textContent, /Refresh/);
        assert.equal(f.apply.dataset.helpDisabledKey, 'pcm.source-stale');
        f.listeners.cancel(); f.inputs[1].checked = true; f.listeners.change(); assert.equal(f.apply.disabled, true);
    });
}

test('Admin login errors keep the changed selection and unavailable choices', async () => {
    const f = fixture(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    f.inputs[1].checked = true; f.listeners.change(); await f.submit();
    assert.match(f.result.textContent, /Admin login/); assert.equal(f.inputs[1].checked, true);
    assert.equal(f.inputs[2].disabled, true); assert.equal(f.apply.disabled, false);
});

test('uncertain network outcomes require refreshing rather than another Apply', async () => {
    const f = fixture(async () => { throw new Error('Network unavailable'); });
    f.inputs[1].checked = true; f.listeners.change(); await f.submit();
    assert.equal(f.apply.disabled, true); assert.match(f.result.textContent, /check the saved sources/);
});
