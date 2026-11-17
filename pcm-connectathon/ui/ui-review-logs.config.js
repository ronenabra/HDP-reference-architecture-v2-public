'use strict';
/** R4 only: existing isolated operator harness with pinned desktop/native-touch browsers. */
const { devices } = require('@playwright/test');
const base = require('./logs-qualification.config');
module.exports = { ...base, testMatch: 'ui-review-logs.spec.js', projects: [base.projects[0],
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }] };
