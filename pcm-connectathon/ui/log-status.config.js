'use strict';
/** STATUS-only source-bound browser acceptance in an owned disposable runtime. */
const { devices } = require('@playwright/test');
const base = require('./logs-qualification.config');
module.exports = { ...base, testMatch: ['log-status.spec.js', 'logs-scroll.spec.js', 'logs-workbench.spec.js'],
    projects: [base.projects[0], { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }] };
