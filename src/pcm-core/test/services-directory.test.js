'use strict';
/** Focused sequencing tests execute the browser's actual ordinary lifecycle coordinator. */
const test = require('node:test'), assert = require('node:assert/strict');
const { disconnect } = require('../../shared/ui/services-lifecycle');
const original = { id: 'connection-a', providerId: 'provider-a', role: 'configured-extra-role', state: 'active', version: '2', csrf: 'first-proof' };

/** Record callbacks and supply independently versioned readback; no transition is auto-retried. */
function fixture({ state = 'active', fail, readback = {} } = {}) {
    const calls = [];
    return { calls, registration: { ...original, state },
        async transition(current, next) {
            calls.push({ id: current.id, provider: current.providerId, role: current.role, version: current.version, csrf: current.csrf, next });
            if (fail === next) throw new Error('Owned API failure');
            return { id: current.id, state: next };
        },
        async inspect(current) { calls.push({ inspect: current.id }); return { ...current, version: '3', state: 'suspended', csrf: 'new-proof', ...readback }; } };
}

test('active Disconnect verifies Pause, exact fresh version and End independently', async () => {
    const f = fixture(), result = await disconnect(f);
    assert.deepEqual(result.steps, { pause: 'confirmed', end: 'confirmed' });
    assert.deepEqual(f.calls.map(call => call.next || 'inspect'), ['suspended', 'inspect', 'cancelled']);
    assert.equal(f.calls[2].version, '3'); assert.equal(f.calls[2].csrf, 'new-proof');
    assert.ok(f.calls.filter(call => call.next).every(call => call.provider === original.providerId && call.role === original.role));
    assert.match(result.message, /not atomic.*new pending registration.*old approvals stay terminal/);
});

test('paused Disconnect uses one End and does not invent another Pause', async () => {
    const f = fixture({ state: 'suspended' }); assert.equal((await disconnect(f)).steps.pause, 'already-paused');
    assert.deepEqual(f.calls.map(call => call.next), ['cancelled']);
});

test('failed Pause stops immediately; failed End preserves visible partial outcome without replay', async () => {
    let f = fixture({ fail: 'suspended' });
    await assert.rejects(disconnect(f), error => !error.paused && /Pause is not confirmed/.test(error.message)); assert.equal(f.calls.length, 1);
    f = fixture({ fail: 'cancelled' });
    await assert.rejects(disconnect(f), error => error.paused && /Partial Disconnect: Pause confirmed; End is not confirmed/.test(error.message)); assert.equal(f.calls.length, 3);
});

test('changed identity, unchanged version, frozen readback and missing proof stop before End', async () => {
    for (const readback of [{ id: 'other' }, { providerId: 'other' }, { role: 'other' }, { version: '2' }, { state: 'frozen' }, { csrf: '' }]) {
        const f = fixture({ readback });
        await assert.rejects(disconnect(f), /Partial Disconnect.*not atomic/); assert.equal(f.calls.filter(call => call.next === 'cancelled').length, 0);
    }
    for (const state of ['frozen', 'rejected', 'cancelled', 'pending', 'unknown']) {
        const f = fixture({ state }); await assert.rejects(disconnect(f), /cannot be disconnected/); assert.equal(f.calls.length, 0);
    }
});

test('unconfirmed ordinary reply cannot advance to the next lifecycle step', async () => {
    const f = fixture(); f.transition = async () => ({ id: 'foreign-connection', state: 'suspended' });
    await assert.rejects(disconnect(f), /Unexpected lifecycle result/); assert.equal(f.calls.length, 0);
});
