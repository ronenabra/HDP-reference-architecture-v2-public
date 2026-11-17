'use strict';
/** Focused current composer qualification; the final batch owns the full browser matrix. */
const base = require('./doctor-ui-review.config');
module.exports = { ...base, timeout: 90000, testDir: '.', testMatch: process.env.DOCTOR_REQUEST_STATES ? ['tests/doctor-services.spec.js'] : ['tests/doctor-request.spec.js', 'tests/doctor-request-public.spec.js'], ...(process.env.DOCTOR_REQUEST_STATES ? { grep: /Doctor LIST/ } : {}) };
