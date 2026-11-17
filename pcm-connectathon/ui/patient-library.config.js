'use strict';
/** Representative actual-route patient-library qualification; final38 owns the full matrix. */
const base = require('./doctor-ui-review.config');
module.exports = { ...base, timeout: 90000, testDir: '.', testMatch: ['offline-tests/patient-library.spec.js'] };
