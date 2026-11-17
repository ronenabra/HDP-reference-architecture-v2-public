'use strict';
/** Full-path benchmark shares real view/API fixture and pinned browser tooling. */
process.env.PCM_SEARCH_CORPUS_MIB = '733';
const base = require('./log-search.config');
module.exports = { ...base, ...(process.env.PCM_SEARCH_EXTERNAL_FIXTURE === 'true' ? { webServer: undefined } : {}),
    testMatch: 'log-search-benchmark.spec.js', timeout: 240000,
    projects: base.projects.filter(project => project.name === 'chromium-desktop') };
