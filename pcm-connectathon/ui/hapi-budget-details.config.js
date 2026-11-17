'use strict';
/** One representative desktop journey through real APIs and the maintained owned Logs fixture. */
const config = require('./log-search.config');
module.exports = { ...config, testMatch: 'hapi-budget-details.spec.js', projects: config.projects.slice(0, 1) };
