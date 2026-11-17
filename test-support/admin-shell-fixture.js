'use strict';
/** Start one disposable mounted Admin app for exact route and browser qualification. */
async function startAdminShellFixture(overrides = {}, options = {}) {
    const fs = require('node:fs');
    const custom = require('../src/pcm-core/src/data-sources').toConfigDataSource({ id: 'admin22-custom', name: 'Owned unavailable source', endpoint: 'http://127.0.0.1:9/fhir', clientId: 'pcm-ds-admin22-custom', enabled: true });
    custom.pcmClientAuth.certThumbprint = 'A'.repeat(43);
    const config = require('./team-config').installTestRuntime({
        publicBaseUrls: { pcmUi: 'http://localhost:14100/pcm', spClient: 'http://localhost:13100/doctor' },
        organizations: { teamDataSource: { enabled: false }, dataSources: [custom] }, ...overrides
    });
    if (options.logToInventory) process.env.LOG_DIR = require('node:path').join(process.env.SHARED_LOGS_DIR, 'pcm-core');
    process.env.TEAM_ADMIN_PASSWORD = 'admin22-disposable';
    const express = require('express');
    const inner = require('../src/pcm-core/src/index').createUiApp();
    const app = express(); app.use('/pcm', inner);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const baseline = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    return { base: `http://127.0.0.1:${server.address().port}/pcm`, config,
        password: process.env.TEAM_ADMIN_PASSWORD,
        unchanged: () => baseline.equals(fs.readFileSync(process.env.TEAM_CONFIG_PATH)),
        async close() {
            inner.locals.closeLogSearch(); server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            delete process.env.TEAM_ADMIN_PASSWORD;
        } };
}
module.exports = { startAdminShellFixture };
