'use strict';
/** Representative Doctor/library and affected reference consumers on pinned Chromium. */
const base = require('./doctor-ui-review.config');
const consumers = Boolean(process.env.EXPLAIN_CONSUMERS);
module.exports = { ...base,
    testDir: consumers ? '.' : './offline-tests',
    testMatch: consumers ? ['**/doctor-services.spec.js', '**/doctor-help.spec.js'] : ['doctor-ui-review.spec.js', 'explain-parity.spec.js'],
    ...(consumers ? { grep: process.env.EXPLAIN_CONSUMERS === 'live' ? /Doctor icon-free live verifier/ : /Close tools opens|Doctor LIST empty/ } : {})
};
