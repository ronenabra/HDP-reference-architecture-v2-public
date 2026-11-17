'use strict';
/** Bounded changed-controller consumers; no broad browser matrix. */
const base = require('./doctor-ui-review.config');
module.exports = { ...base, use: { ...base.use, hasTouch: true }, timeout: 120000, testDir: '.', testMatch: [
    'offline-tests/foundation.spec.js', 'offline-tests/explain-parity.spec.js', 'tests/services-help.spec.js'
], grep: /wrapping header|reference hover|HELP mounted Services/ };
