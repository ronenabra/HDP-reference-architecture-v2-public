'use strict';
/** Filters-only qualification reuses the owned source fixture and pinned browser. */
const base = require('./log-structured.config');
module.exports = { ...base, testMatch: 'log-filter-layout.spec.js', timeout: 90000 };
