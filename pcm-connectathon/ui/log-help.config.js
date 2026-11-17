'use strict';
/** Final legacy Logs integration plus complete metadata help on desktop and native touch. */
const { devices } = require('@playwright/test');
const base = require('./logs-qualification.config');
module.exports = { ...base,
    testMatch: [...base.testMatch, 'log-status.spec.js', 'log-metadata-help.spec.js'],
    projects: base.projects.map(project => project.name === 'chromium-mobile'
        ? { ...project, use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } } : project) };
