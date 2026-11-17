'use strict';
/** Navigation guards must cover uploads before an operation ID exists and all polls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../shared/ui/connectathon.js'), 'utf8');

/** Control both scheduled and already-captured callbacks without real wall-clock waits. */
function fixture() {
    const timers = new Map();
    let reloaded = 0, state;
    const options = { reload: () => reloaded++, onChange: value => { state = value; },
        setTimer(callback, delay) { assert.equal(delay, 500); const id = {}; timers.set(id, callback); return id; },
        clearTimer(id) { timers.delete(id); } };
    const coordinator = vm.runInNewContext(`${source}\ncreateAdminRefreshCoordinator(options)`, {
        options, document: { addEventListener() {} }
    });
    return { coordinator, timers, get reloaded() { return reloaded; }, get state() { return state; },
        fire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}

test('one completed HO waits for another upload without an operation ID and its later poll', () => {
    const f = fixture(), c = f.coordinator;
    const a = c.begin(), pendingB = c.begin();
    c.success(); a();
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.busy, true);
    assert.equal(c.refresh(), false);
    const pollB = c.begin(); pendingB();
    assert.equal(f.timers.size, 0);
    c.success(); pollB();
    assert.equal(f.timers.size, 1);
    f.fire(); assert.equal(f.reloaded, 1);
});

test('new work during the success grace period fences even an already captured callback', () => {
    const f = fixture(), c = f.coordinator;
    c.success();
    const staleCallback = [...f.timers.values()][0];
    const b = c.begin();
    staleCallback();
    assert.equal(f.reloaded, 0);
    assert.equal(f.timers.size, 0);
    b(); b(); // A duplicate completion cannot release another request.
    assert.equal(f.timers.size, 1);
    f.fire(); assert.equal(f.reloaded, 1);
});

test('failed or uncertain work preserves feedback and allows only explicit idle refresh', () => {
    const f = fixture(), c = f.coordinator;
    const pending = c.begin(); c.success(); c.attention(); pending();
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.needsAttention, true);
    f.fire(); assert.equal(f.reloaded, 0);
    assert.equal(c.refresh(), true);
    assert.equal(f.reloaded, 1);
});

test('a completed neighbouring import cannot erase a prior refused-request attention state', () => {
    const f = fixture(), c = f.coordinator;
    const refused = c.begin(); c.attention(); refused();
    const neighbour = c.begin(); c.success();
    assert.equal(c.refresh(), false);
    neighbour();
    assert.equal(f.state.needsAttention, true);
    assert.equal(f.state.busy, false);
    assert.equal(f.timers.size, 0);
    f.fire(); assert.equal(f.reloaded, 0);
    assert.equal(c.refresh(), true);
    assert.equal(f.reloaded, 1);
});

test('unsent file/config changes prevent automatic navigation until those forms are submitted', () => {
    const f = fixture(), c = f.coordinator, upload = {}, config = {};
    c.edited(upload); c.edited(config); c.success();
    c.submitted(upload); assert.equal(f.timers.size, 0);
    assert.equal(f.state.dirty, true);
    c.submitted(config); assert.equal(f.timers.size, 1);
    f.fire(); assert.equal(f.reloaded, 1);
});

test('resumed polling and interrupted status reads remain guarded; a single success still reloads', () => {
    const f = fixture(), c = f.coordinator;
    const resumedPoll = c.begin(), submit = c.begin(); c.success(); submit();
    assert.equal(f.timers.size, 0); // No final status: do not release the poll guard.
    resumedPoll(); f.fire(); assert.equal(f.reloaded, 1);
    const single = fixture(), end = single.coordinator.begin();
    single.coordinator.success(); end(); single.fire(); assert.equal(single.reloaded, 1);
});

/** Navigation uses the same overlapping operation tokens as refresh. */
test('whole Admin navigation remains blocked until every upload and poll finishes', () => {
    const { coordinator: c } = fixture();
    assert.equal(c.navigationBlocked(), false);
    const upload = c.begin(), poll = c.begin();
    upload(); upload(); assert.equal(c.navigationBlocked(), true);
    poll(); assert.equal(c.navigationBlocked(), false);
});
