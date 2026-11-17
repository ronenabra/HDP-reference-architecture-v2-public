'use strict';
/** Bounded Doctor family acceptance; final38 owns the complete browser and repository matrix. */
const base = require('./doctor-ui-review.config');
module.exports = { ...base, timeout: 90000, testDir: '.', testMatch: [
    'tests/doctor-qualification.spec.js', 'tests/doctor-request.spec.js',
    'tests/doctor-request-public.spec.js', 'tests/doctor-public-api.spec.js',
    'offline-tests/patient-library.spec.js', 'offline-tests/doctor-help.spec.js'
] };
