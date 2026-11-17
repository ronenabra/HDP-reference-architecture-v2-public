'use strict';
/** Focused pinned desktop/native-touch browser qualification on an owned fixture. */
const base = require('./log-search.config');
module.exports = { ...base, testMatch: 'log-structured.spec.js', timeout: 90000,
    use: { ...base.use, baseURL: 'http://127.0.0.1:43188' },
    webServer: { ...base.webServer, command: `${JSON.stringify(process.execPath)} log-structured-fixture-server.js`, url: 'http://127.0.0.1:43188/healthz' } };
