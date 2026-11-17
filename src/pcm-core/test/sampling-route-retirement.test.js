'use strict';
/** Retired private sampler operations have no UI fallback. */
const test = require('node:test'), assert = require('node:assert/strict'), http = require('http');
require('../../../test-support/team-config').installTestRuntime();
const { createUiApp } = require('../src/index');
test('private sampler POST, verify and sources return ordinary 404', async t => {
    const server = http.createServer(createUiApp()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const [method, path] of [['GET', '/sandbox/api/patients'], ['POST', '/sandbox/api/patient-sample'], ['POST', '/sandbox/api/patient-sample/verify'], ['GET', '/sandbox/api/patient-sample/sources']]) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method }); assert.equal(response.status, 404);
    }
});

test('Admin patient ledger remains protected and available to its Admin owner', async t => {
    const previous = process.env.TEAM_ADMIN_PASSWORD;
    process.env.TEAM_ADMIN_PASSWORD = 'inventory-unit-test-only';
    const server = http.createServer(createUiApp()); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve));
        if (previous === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previous; });
    const url = `http://127.0.0.1:${server.address().port}/admin/api/patients`;
    assert.equal((await fetch(url, { redirect: 'manual' })).status, 401);
    const response = await fetch(url, { headers: { 'X-Admin-Password': process.env.TEAM_ADMIN_PASSWORD } });
    assert.equal(response.status, 200); assert.ok(Array.isArray((await response.json()).patients));
});
