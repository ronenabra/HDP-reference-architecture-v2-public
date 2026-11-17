'use strict';
/** R7 reuses the owned Doctor fixtures; final batch qualification belongs to R3. */
const base = require('./doctor-ui-review.config');
const path = require('node:path');
const artifacts = process.env.PCM_DOCTOR_ARTIFACTS || '/artifacts';
module.exports = { ...base, use: { ...base.use, actionTimeout: 10000 }, timeout: 90000, testDir: '.', testMatch: [
    'offline-tests/ui-review-doctor.spec.js', 'offline-tests/patient-library.spec.js',
    'offline-tests/doctor-help.spec.js', 'offline-tests/doctor-ui-review.spec.js',
    'tests/doctor-request.spec.js', 'tests/doctor-request-public.spec.js', 'tests/doctor-public-api.spec.js'
], reporter: [['line'], ['json', { outputFile: path.join(artifacts, 'results.json') }]], outputDir: path.join(artifacts, 'test-results') };
