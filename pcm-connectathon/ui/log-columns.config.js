'use strict';
/** Columns-only qualification reuses the owned source fixture and pinned browser. */
const base = require('./log-structured.config');
module.exports = { ...base, testMatch: 'log-columns.spec.js', timeout: 90000 };
