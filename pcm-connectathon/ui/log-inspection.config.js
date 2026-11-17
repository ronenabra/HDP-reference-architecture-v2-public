'use strict';
/** Disposable exact-ID desktop/native-touch qualification; optionally share owned external service. */
process.env.PCM_INSPECT_FIXTURE = 'true';
const base = require('./log-search.config');
module.exports = { ...base, ...(process.env.PCM_SEARCH_EXTERNAL_FIXTURE === 'true' ? { webServer: undefined } : {}),
    testMatch: 'log-inspection.spec.js', timeout: 90000 };
