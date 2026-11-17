'use strict';
/** Representative real-route identifier journeys; final38 owns the full browser matrix. */
const base = require('./doctor-ui-review.config');
module.exports = { ...base, timeout: 60000, testDir: '.', testMatch: ['offline-tests/identifier-entry.spec.js'] };
