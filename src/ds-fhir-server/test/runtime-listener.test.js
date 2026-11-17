'use strict';

/** Deterministic failure/continuity checks for the legacy listener coordinator. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRuntimeListener } = require('../src/runtime-listener');

/** Model bind/drain failures without relying on a host port race. */
class FakeServer extends EventEmitter {
    constructor({ error, drain } = {}) {
        super();
        this.error = error;
        this.drain = drain;
        this.listening = false;
        this.binds = 0;
        this.closes = 0;
    }

    /** Complete the next bind on a later turn, like a real Node listener. */
    listen() {
        this.binds++;
        setImmediate(() => {
            if (this.error) this.emit('error', this.error);
            else { this.listening = true; this.emit('listening'); }
        });
    }

    /** Allow a test to hold the drain boundary across multiple watcher ticks. */
    close(done) {
        this.closes++;
        this.listening = false;
        if (this.drain) this.drain(done);
        else setImmediate(done);
    }
}

/** Return a runtime with controllable selected-file reads and TLS preparation. */
function fixture() {
    let snapshot = { revision: '1:0:https', policy: { preset: 'easy' } };
    let readError;
    let prepareError;
    const entries = [];
    const servers = [];
    const runtime = createRuntimeListener({
        readSnapshot: () => { if (readError) throw readError; return snapshot; },
        createServer: () => {
            if (prepareError) throw prepareError;
            const server = new FakeServer();
            servers.push(server);
            return server;
        },
        port: 1234, configPath: '/owned/team-config.json',
        logger: Object.fromEntries(['info', 'error'].map(level => [level, (message, details) => entries.push({ level, message, ...details })]))
    });
    return { runtime, servers, entries,
        next: value => { snapshot = value; },
        failRead: error => { readError = error; },
        failPrepare: error => { prepareError = error; } };
}

test('valid revisions publish only after bind and unchanged revisions do not replace listeners', async () => {
    const f = fixture();
    await f.runtime.start();
    const old = f.runtime.getActive();
    const next = { revision: '2:1:https', policy: { preset: 'balanced' } };
    f.next(next);
    const transition = f.runtime.check();
    assert.equal(f.runtime.getActive(), old);
    await transition;
    assert.equal(f.runtime.getActive(), next);
    assert.equal(f.servers[0].listening, false);
    assert.equal(f.servers[1].listening, true);
    const complete = f.entries.find(row => row.type === 'PROCESS_RELOAD_COMPLETE');
    assert.equal(complete.previousRevision, '1:0:https');
    assert.equal(complete.activeRevision, '2:1:https');
    await f.runtime.check();
    assert.equal(f.servers.length, 2);
    await f.runtime.stop();
});

test('repeated invalid/unreadable input retains listener/revision and correction recovers', async () => {
    const f = fixture();
    await f.runtime.start();
    for (const error of [new SyntaxError('invalid JSON'), new Error('EACCES selected file'), new Error('policy invalid')]) {
        f.failRead(error);
        await f.runtime.check();
        await f.runtime.check();
        assert.equal(f.runtime.getActive().revision, '1:0:https');
        assert.equal(f.servers[0].closes, 0);
    }
    assert.equal(f.entries.filter(row => row.message === 'DS FHIR config reload rejected').length, 6);
    assert.ok(f.entries.filter(row => row.stage === 'config').every(row => row.visibility === 'diagnostic' && row.causesSystemFlow === false));
    assert.ok(f.entries.filter(row => row.stage === 'config').every(row => row.configPath === '/owned/team-config.json' && row.activeRevision === '1:0:https'));
    f.failRead(null);
    f.next({ revision: '2:0:https', policy: {} });
    await f.runtime.check();
    assert.equal(f.runtime.getActive().revision, '2:0:https');
    await f.runtime.stop();
});

test('TLS preparation failure preserves the old listener and retries the same corrected revision', async () => {
    const f = fixture();
    await f.runtime.start();
    f.next({ revision: '2:1:https', policy: {} });
    f.failPrepare(new Error('ENOENT TLS key'));
    await f.runtime.check();
    assert.equal(f.servers[0].closes, 0);
    assert.equal(f.runtime.getActive().revision, '1:0:https');
    assert.equal(f.entries.at(-1).stage, 'prepare-listener');
    f.failPrepare(null);
    await f.runtime.check();
    assert.equal(f.runtime.getActive().revision, '2:1:https');
    await f.runtime.stop();
});

test('asynchronous bind failure restores old TLS listener and retries without another revision bump', async () => {
    const f = fixture();
    await f.runtime.start();
    f.next({ revision: '2:0:https', policy: {} });
    const draining = [];
    f.servers[0].drain = done => draining.push(done);
    const transition = f.runtime.check();
    f.servers[1].error = new Error('EADDRINUSE');
    draining.shift()();
    await transition;
    assert.equal(f.runtime.getActive().revision, '1:0:https');
    assert.equal(f.servers[0].binds, 2);
    assert.equal(f.servers[0].listening, true);
    assert.equal(f.entries.at(-1).type, 'PROCESS_RELOAD_ROLLBACK');
    f.servers[0].drain = null;
    await f.runtime.check();
    assert.equal(f.runtime.getActive().revision, '2:0:https');
    await f.runtime.stop();
});

test('watcher ticks serialize while draining and shutdown prevents a pending replacement', async () => {
    const f = fixture();
    await f.runtime.start();
    f.next({ revision: '2:0:https', policy: {} });
    let finishDrain;
    f.servers[0].drain = done => { finishDrain = done; };
    const transition = f.runtime.check();
    assert.equal(f.runtime.check(), transition);
    assert.equal(f.servers.length, 2);
    const stopped = f.runtime.stop();
    finishDrain();
    await stopped;
    assert.equal(f.servers[1].binds, 0);
    assert.equal(f.runtime.getActive().revision, '1:0:https');
    await f.runtime.check();
    assert.equal(f.servers.length, 2);
});

test('rollback bind failure is explicit and a later watcher tick still recovers', async () => {
    const f = fixture();
    await f.runtime.start();
    f.next({ revision: '2:0:https', policy: {} });
    let finishDrain;
    f.servers[0].drain = done => { finishDrain = done; };
    const transition = f.runtime.check();
    f.servers[0].error = new Error('rollback EADDRINUSE');
    f.servers[1].error = new Error('candidate EADDRINUSE');
    finishDrain();
    await transition;
    assert.equal(f.entries.at(-1).stage, 'rollback');
    assert.equal(f.runtime.getActive().revision, '1:0:https');
    await f.runtime.check();
    assert.equal(f.runtime.getActive().revision, '2:0:https');
    await f.runtime.stop();
});

test('startup rejects unreadable selected input or asynchronous bind failure', async () => {
    const f = fixture();
    f.failRead(new Error('ENOENT selected file'));
    await assert.rejects(f.runtime.start(), /ENOENT/);
    f.failRead(null);
    const startup = f.runtime.start();
    f.servers[0].error = new Error('startup EADDRINUSE');
    await assert.rejects(startup, /EADDRINUSE/);
    assert.equal(f.runtime.getActive(), null);
    await f.runtime.stop();
});
