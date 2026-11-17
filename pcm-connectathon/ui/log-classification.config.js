'use strict';
/** Reuse pinned desktop/native-touch browser settings and a separately owned classification fixture. */
const base = require('./log-search.config');
module.exports = { ...base, testMatch: 'log-classification.spec.js', use: { ...base.use, baseURL: 'http://127.0.0.1:43185' },
    webServer: process.env.PCM_CLASSIFICATION_EXTERNAL_FIXTURE === 'true' ? undefined : { ...base.webServer, command: `${JSON.stringify(process.execPath)} log-classification-fixture-server.js`, url: 'http://127.0.0.1:43185/healthz' } };
