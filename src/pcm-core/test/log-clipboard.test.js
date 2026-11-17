'use strict';
/** Clipboard outcomes, fidelity, availability and stale-operation fences. */
const test = require('node:test'), assert = require('node:assert/strict');
const { create } = require('../../shared/ui/log-clipboard');
/** Minimal DOM boundary checks restoration and copy-event payload rather than implementation text. */
function fixture(writeText, legacy = false) {
    const events = {}, values = [], statuses = [], manuals = [];
    const active = { isConnected: true, scrollTop: 30, scrollLeft: 7, focus() { this.focused = true; } };
    const document = { activeElement: active, getSelection: () => null,
        defaultView: { scrollX: 0, scrollY: 80, scrollTo(x, y) { assert.deepEqual([x, y], [0, 80]); } },
        body: { append() {} }, createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, remove() {} }),
        addEventListener: (key, handler) => { events[key] = handler; }, removeEventListener: key => { delete events[key]; },
        execCommand() { if (legacy) events.copy({ clipboardData: { setData(type, text) { assert.equal(type, 'text/plain'); values.push(text); } }, preventDefault() {} }); return legacy; }
    };
    const controller = create({ document, navigator: writeText ? { clipboard: { writeText } } : {}, status: text => statuses.push(text), manual: text => manuals.push(text) });
    return { controller, document, values, statuses, manuals, active };
}
test('native write retains complete JSON, raw CR/LF, empty strings and field values', async () => {
    const writes = [], f = fixture(async value => writes.push(value));
    const complete = JSON.stringify({ unknown: { deep: ['x'.repeat(20000), false, null] } });
    for (const value of [complete, '  raw\r\n\tline\nlast\r', '', 'null', 'false', '0', '{}', '[]']) {
        assert.equal(await f.controller.copy(value), 'copied'); assert.equal(writes.at(-1), value);
    }
    assert.equal(await f.controller.copy(null), 'unavailable'); assert.equal(writes.length, 8);
});
for (const api of ['missing', 'rejected']) for (const legacy of [true, false]) test(`${api} API with legacy ${legacy} reports truthful outcome`, async () => {
    const f = fixture(api === 'rejected' ? async () => { throw Error('denied'); } : null, legacy);
    const raw = '  exact\r\n\tend\n';
    assert.equal(await f.controller.copy(raw), legacy ? 'copied' : 'manual');
    if (legacy) { assert.deepEqual(f.values, [raw]); assert.equal(f.active.focused, true); }
    else { assert.equal(f.manuals.at(-1), raw); assert.match(f.statuses.at(-1), /blocked/); assert.ok(!f.statuses.some(s => s === 'Text copied.')); }
});
for (const change of ['selection', 'clear', 'new attempt']) test(`late native completion after ${change} has no stale feedback or fallback`, async () => {
    let resolve, current = true;
    const f = fixture(() => new Promise(r => { resolve = r; }), true);
    const pending = f.controller.copy('old', { current: () => current });
    const finish = resolve;
    if (change === 'selection') current = false;
    else if (change === 'clear') f.controller.cancel();
    else { const newer = f.controller.copy('new'); resolve(); await newer; }
    const count = f.statuses.length; finish();
    assert.equal(await pending, 'stale'); assert.equal(f.statuses.length, count); assert.deepEqual(f.values, []);
});
test('stale rejected native completion never writes the old payload through legacy', async () => {
    let reject, current = true;
    const f = fixture(() => new Promise((_r, j) => { reject = j; }), true);
    const pending = f.controller.copy('old', { current: () => current }); current = false; reject(Error('denied'));
    assert.equal(await pending, 'stale'); assert.deepEqual(f.values, []); assert.deepEqual(f.statuses, ['Copying selected text…']);
});

test('selected payload uses resolved complete record and raw source rather than visible DOM', () => {
    const fs = require('node:fs'), vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../src/views/logs.ejs'), 'utf8');
    const body = source.slice(source.indexOf('function selectedCopyText()'), source.indexOf('/** Reuse one controller', source.indexOf('function selectedCopyText()')));
    const model = source.slice(source.indexOf('function selectedRecordModel('), source.indexOf('function detailPanels(', source.indexOf('function selectedRecordModel(')));
    const record = { id: 'complete', details: { unknown: ['full', false, 0], long: 'x'.repeat(20000) } };
    const context = vm.createContext({ selectedRecord: { id: 'summary' }, selectedResult: { entry: record, provenance: { kind: 'emitted' }, raw: '  original\r\n\tend\n' }, activeDetailTab: 'json' });
    vm.runInContext(model + body, context);
    assert.equal(vm.runInContext('selectedCopyText()', context), JSON.stringify(record, null, 2));
    context.activeDetailTab = 'raw'; assert.equal(vm.runInContext('selectedCopyText()', context), context.selectedResult.raw);
    context.selectedResult.raw = null; assert.equal(vm.runInContext('selectedCopyText()', context), null);
    context.selectedResult.raw = ''; assert.equal(vm.runInContext('selectedCopyText()', context), '');
    context.selectedResult = null; assert.equal(vm.runInContext('selectedCopyText()', context), null);
    context.selectedRecord = null; assert.equal(vm.runInContext('selectedCopyText()', context), null);
});

test('compatible copy inside a native modal uses the active dialog as its focusable host', async () => {
    const f = fixture(null, true); let appended = false;
    f.active.closest = selector => { assert.equal(selector, 'dialog[open]'); return { append() { appended = true; } }; };
    f.document.body.append = () => { throw Error('modal body is inert'); };
    assert.equal(await f.controller.copy('complete-modal-id'), 'copied');
    assert.equal(appended, true); assert.deepEqual(f.values, ['complete-modal-id']); assert.equal(f.active.focused, true);
});
