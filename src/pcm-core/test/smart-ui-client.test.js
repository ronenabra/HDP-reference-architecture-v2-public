'use strict';
/** The browser keeps the actual submitter decision and checked scopes while suppressing repeated submits. */
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
test('identity change enables approval, busy state preserves submitter and Back revalidates', () => {
    const handlers = {}, lifecycle = {}, attrs = {}; let selected = false, focused = false, prevented = false, reloaded = false;
    const approve = { disabled: true }, busy = { hidden: true, focus() { focused = true; } };
    const form = { querySelector(selector) { return selector === '[data-smart-approve]' ? approve : selector === '[data-smart-busy]' ? busy : selected ? {} : null; },
        addEventListener(name, callback) { handlers[name] = callback; }, getAttribute(name) { return attrs[name]; }, setAttribute(name, value) { attrs[name] = value; } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../shared/ui/smart-authorization.js'), 'utf8'), {
        addEventListener(name, callback) { lifecycle[name] = callback; }, location: { reload() { reloaded = true; } },
        document: { querySelector() { return form; }, addEventListener(name, callback) { callback(); } }
    });
    assert.equal(approve.disabled, true); selected = true; handlers.change(); assert.equal(approve.disabled, false);
    handlers.submit({ preventDefault() { prevented = true; } }); assert.equal(approve.disabled, false); assert.equal(prevented, false); assert.equal(busy.hidden, false); assert.equal(focused, true);
    handlers.submit({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    lifecycle.pageshow({ persisted: true }); assert.equal(reloaded, true);
});
