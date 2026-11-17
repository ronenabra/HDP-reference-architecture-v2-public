'use strict';
/** Coverage-only desktop and native-touch qualification against an owned source fixture. */
const base = require('./log-search.config');
module.exports = { ...base, testMatch: 'log-coverage.spec.js', timeout: 90000,
    use: { ...base.use, baseURL: 'http://127.0.0.1:43189' },
    webServer: { ...base.webServer, command: `${JSON.stringify(process.execPath)} log-coverage-fixture-server.js`, url: 'http://127.0.0.1:43189/healthz' } };
