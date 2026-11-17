require('../../../test-support/team-config').installTestRuntime();
'use strict';
/** Private route authentication, CSRF, closed commands, preview/cancel and optimistic conflict behavior. */
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { fixture } = require('../../../test-support/demo-sources');
const { csrf, handler } = require('../src/sandbox-source-command');
const store = require('../src/fhir/store');
const { loadTeamConfig, saveTeamConfig } = require('../src/team-config');

test('Admin protected source route rejects unauthenticated, cross-origin, stale and forged commands atomically', async () => {
    const f = fixture(), initial = f.store.get('Consent', f.consent.id);
    // Route uses actual application store/config and actual Admin middleware, not a substitute auth guard.
    const checkpoint = require('../src/migration-checkpoint');
    checkpoint.hydrate(store, checkpoint.snapshot(f.store, { privateState: true }));
    const saved = loadTeamConfig(); saveTeamConfig(f.config);
    const oldPassword = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'source-test-admin';
    const app = express(); app.use(require('../src/routes/ui'));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const current = () => store.get('Consent', f.consent.id);
    const body = action => ({ action, sourceIds: f.ids.slice(0, 2), expectedVersion: current().meta.versionId, csrf: csrf(f.consent.id, current().meta.versionId) });
    const send = (data, headers = {}) => fetch(`${url}/admin/consents/${f.consent.id}/sandbox-sources`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(data) });
    const auth = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD };
    try {
        assert.equal((await send(body('apply'))).status, 401);
        assert.equal((await send(body('apply'), { ...auth, Origin: 'https://foreign.example' })).status, 403);
        assert.equal((await send({ ...body('apply'), csrf: 'wrong' }, auth)).status, 403);
        assert.equal((await send({ ...body('apply'), actor: 'forged' }, auth)).status, 400);
        const before = current();
        assert.equal((await send(body('preview'), { ...auth, Origin: new URL(f.config.publicBaseUrls.pcmUi).origin })).status, 200); assert.deepEqual(current(), before);
        assert.equal((await send(body('cancel'), auth)).status, 200); assert.deepEqual(current(), before);
        const stale = body('apply');
        assert.equal((await send(stale, auth)).status, 200);
        const newer = current();
        const conflict = await send({ ...stale, sourceIds: [] }, auth); assert.equal(conflict.status, 409);
        const state = await conflict.json(); assert.deepEqual(state.current.current, f.ids.slice(0, 2)); assert.equal(typeof state.csrf, 'string'); assert.deepEqual(current(), newer);
        saveTeamConfig(require('../../../test-support/team-config').buildTeamConfig({}, 'strict'));
        assert.equal((await send(body('apply'), auth)).status, 403); assert.deepEqual(current(), newer);
    } finally { server.close(); server.closeAllConnections(); saveTeamConfig(saved); if (oldPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = oldPassword; }
});
