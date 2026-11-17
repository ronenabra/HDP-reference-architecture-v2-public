'use strict';
/** Exercise actual shared middleware emission and flow propagation on owned loopback HTTP. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createLogger } = require('../../src/shared/logger');

test('Doctor selection emits diagnostic request/response without a new flow while token calls retain real evidence', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-middleware-'));
    const prior = process.env.LOG_DIR; process.env.LOG_DIR = root;
    const logger = createLogger({ service: 'sp-client', onFinished: require('on-finished') });
    if (prior === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = prior;
    const app = express(); app.use(logger.requestLogger);
    app.post('/selection', (_req, res) => res.status(200).send('local clear'));
    app.post('/token', (_req, res) => res.status(401).send('denied'));
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const selection = await fetch(base + '/selection', { method: 'POST' }); await selection.text();
    assert.equal(selection.headers.get('x-flow-id'), null);
    const protocol = await fetch(base + '/token', { method: 'POST' }); await protocol.text();
    assert.ok(protocol.headers.get('x-flow-id'));
    const entries = fs.readFileSync(path.join(root, 'current.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 4);
    for (const row of entries.filter(row => row.details.url === '/selection')) {
        assert.equal(row.details.visibility, 'diagnostic'); assert.equal(row.details.causesSystemFlow, false);
        assert.equal(row.details.flowId, undefined); assert.equal(row.event.source.role, 'doctor');
    }
    for (const row of entries.filter(row => row.details.url === '/token')) {
        assert.equal(row.details.visibility, 'default'); assert.equal(row.details.causesSystemFlow, true);
        assert.equal(row.details.flowId, protocol.headers.get('x-flow-id'));
    }
    assert.deepEqual(entries.map(row => row.details.type), ['REQUEST', 'RESPONSE', 'REQUEST', 'RESPONSE']);
});
