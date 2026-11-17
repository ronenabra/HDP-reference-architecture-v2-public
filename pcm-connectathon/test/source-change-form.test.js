'use strict';
/** The active direct-Apply form submits one changed set, preserving version/CSRF and conflict handling. */
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
/** Minimal DOM boundary with every source input and a controllable asynchronous response. */
function formFixture() {
    const listeners = {}, boxes = [
        { value: 'A', checked: true, disabled: false, dataset: { label: 'Source A' } },
        { value: 'B', checked: false, disabled: false, dataset: { label: 'Source B' } },
        { value: 'C', checked: false, disabled: true, dataset: { label: 'Unavailable source' } }
    ];
    const node = extra => ({ ...extra, addEventListener(type, fn) { this[type] = fn; } });
    const result = node({ textContent: '' }), apply = node({ disabled: true, dataset: {} }), cancel = node({ disabled: true });
    const submissions = [];
    let complete, reloads = 0;
    const form = { action: 'http://pcm.test/admin/consents/one/sandbox-sources', elements: { expectedVersion: { value: '2' }, csrf: { value: 'signed' } },
        querySelector(selector) { return selector === '[data-source-result]' ? result : selector === '[data-source-apply]' ? apply : selector === '[data-source-cancel]' ? cancel : boxes.find(box => selector.includes(`"${box.value}"`)); },
        // Production requests all inputs, including unchecked choices. Returning
        // only checked inputs masked changes in the obsolete preview-era fixture.
        querySelectorAll() { return boxes; }, addEventListener(type, fn) { listeners[type] = fn; },
        reset() { boxes[0].checked = true; boxes[1].checked = false; boxes[2].checked = false; } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../src/shared/ui/source-change.js'), 'utf8'), {
        document: { querySelector: () => form }, window: { location: { reload: () => reloads++ } },
        fetch: (_url, options) => { submissions.push(JSON.parse(options.body)); return new Promise(resolve => {
            complete = (body, status = 200) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
        }); }
    });
    return { boxes, result, apply, cancel, listeners, submissions,
        submit: () => listeners.submit({ preventDefault() {} }), complete: (body, status) => complete(body, status), reloads: () => reloads };
}

test('direct Apply sends a changed source set once and locks controls while its response is pending', async () => {
    const f = formFixture();
    assert.equal(f.apply.disabled, true); assert.equal(f.cancel.disabled, true);
    assert.equal(f.apply.dataset.helpDisabledKey, 'pcm.source-unchanged');
    await f.submit(); assert.equal(f.submissions.length, 0);
    f.boxes[1].checked = true; f.listeners.change();
    assert.equal(f.apply.disabled, false); assert.equal(f.cancel.disabled, false);
    const pending = f.submit();
    assert.equal(f.apply.dataset.helpDisabledKey, 'pcm.source-saving');
    assert.deepEqual(f.submissions, [{ action: 'apply', sourceIds: ['A', 'B'], expectedVersion: '2', csrf: 'signed' }]);
    assert.equal(f.apply.disabled, true); assert.equal(f.cancel.disabled, true);
    assert.ok(f.boxes.every(box => box.disabled));
    await f.submit(); assert.equal(f.submissions.length, 1, 'a repeated submit cannot duplicate an in-flight command');
    f.complete({ state: 'applied' }); await pending;
    assert.equal(f.reloads(), 1);
    assert.equal(f.boxes[0].disabled, false); assert.equal(f.boxes[1].disabled, false);
    assert.equal(f.boxes[2].disabled, true, 'initially unavailable choices stay disabled');
});

test('direct explicit empty selection can be cancelled and conflicts require refresh without automatic retry', async () => {
    const f = formFixture();
    f.boxes[0].checked = false; f.listeners.change();
    assert.equal(f.apply.disabled, false); assert.equal(f.cancel.disabled, false);
    f.cancel.click();
    assert.equal(f.boxes[0].checked, true); assert.equal(f.boxes[1].checked, false);
    assert.equal(f.apply.disabled, true); assert.equal(f.cancel.disabled, true);
    assert.equal(f.submissions.length, 0, 'cancel has no preview or application traffic');
    f.boxes[0].checked = false; f.listeners.change();
    const pending = f.submit();
    assert.deepEqual(f.submissions, [{ action: 'apply', sourceIds: [], expectedVersion: '2', csrf: 'signed' }]);
    f.complete({ error: 'Synthetic version conflict' }, 409); await pending;
    assert.match(f.result.textContent, /Synthetic version conflict.*Refresh the details/);
    assert.equal(f.apply.dataset.helpDisabledKey, 'pcm.source-stale');
    assert.equal(f.apply.disabled, true); assert.equal(f.reloads(), 0);
    f.boxes[1].checked = true; f.listeners.change();
    await f.submit(); assert.equal(f.submissions.length, 1, 'editing after a conflict must not authorize a retry');
    f.cancel.click();
    assert.equal(f.boxes[0].checked, true); assert.equal(f.boxes[1].checked, false);
    assert.equal(f.apply.disabled, true); assert.equal(f.boxes[2].disabled, true);
    assert.match(f.result.textContent, /Refresh the details/);
});
