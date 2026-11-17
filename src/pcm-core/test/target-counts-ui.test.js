'use strict';
/** Exercise the interactive count deadline, rendering and cancellation without HAPI mutation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../../shared/ui/admin-feedback.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '../../shared/ui/connectathon.js'), 'utf8');

/** Mount one target card with a controllable clock and read-only HTTP client. */
function fixture(fetch) {
    let click, now = 0;
    const timers = new Map();
    const output = { hidden: true, dataset: { target: 'ho-c' },
        replaceChildren(...children) { this.children = children; } };
    const link = { href: '/admin/api/fhir-servers/ho-c/data',
        closest: () => ({ querySelector: () => output }),
        addEventListener: (_name, callback) => { click = callback; } };
    vm.runInNewContext(script, {
        AbortController, fetch,
        setTimeout(callback, milliseconds) { const id = {}; timers.set(id, { callback, at: now + milliseconds }); return id; },
        clearTimeout: id => timers.delete(id),
        window: {}, document: {
            addEventListener: (name, callback) => { if (name === 'DOMContentLoaded') callback(); },
            querySelectorAll: selector => selector === '[data-target-counts]' ? [link] : [],
            querySelector: () => null,
            createElement: () => ({ children: [], append(...children) { this.children.push(...children); } })
        }
    });
    return { output, timers, click: () => click({ preventDefault() {} }),
        advance(milliseconds) {
            now += milliseconds;
            for (const [id, timer] of timers) {
                if (timer.at <= now) { timers.delete(id); timer.callback(); }
            }
        } };
}

test('count UI waits past one minute and cancels at three minutes without implying empty data', async () => {
    let signal;
    const f = fixture((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort',
            () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const pending = f.click();
    assert.match(f.output.textContent, /2\.92 minutes \(175 seconds\) server deadline/);
    f.advance(60000);
    assert.equal(signal.aborted, false);
    f.advance(119999);
    assert.equal(signal.aborted, false);
    f.advance(1);
    await pending;
    assert.equal(signal.aborted, true);
    assert.match(f.output.textContent, /Target state unavailable/);
    assert.match(f.output.textContent, /No zero count or empty state is inferred/);
    assert.equal(f.timers.size, 0);
});

test('count UI renders a slow successful result and clears its timer', async () => {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    const pending = f.click();
    f.advance(174000);
    resolve({ ok: true, json: async () => ({ state: 'unreconciled', actualResourceCount: 117447,
        hasHistory: true, actualCounts: { Encounter: 40000, Observation: 77447 } }) });
    await pending;
    assert.match(f.output.children[1].textContent, /117447 current resources · history present/);
    assert.equal(f.timers.size, 0);
});

test('selecting counts again cancels the active read immediately', async () => {
    let calls = 0;
    const f = fixture((_url, { signal }) => {
        calls++;
        return new Promise((_resolve, reject) => signal.addEventListener('abort',
            () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    const pending = f.click();
    await f.click();
    await pending;
    assert.equal(calls, 1);
    assert.match(f.output.textContent, /request cancelled or timed out/);
    assert.equal(f.timers.size, 0);
});
