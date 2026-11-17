'use strict';
/** Focused shell geometry and actual public-only navigation; final38 owns full matrix. */
const base = require('./doctor-ui-review.config');
module.exports = { ...base, timeout: 60000, testDir: '.',
    testMatch: process.env.DOCTOR_SHELL_CONSUMERS ? ['offline-tests/explain-parity.spec.js', 'tests/services.spec.js'] : ['offline-tests/doctor-shell.spec.js'],
    ...(process.env.DOCTOR_SHELL_CONSUMERS ? { grep: /reference hover\/focus|Services Explain opens fields/ } : {})
};
