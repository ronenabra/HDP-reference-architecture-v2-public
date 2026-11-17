'use strict';
/** Focused actual Maintenance file/paste, reset, scope, keyboard/touch and context journeys. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: 'admin-maintenance.spec.js', workers: 1, retries: 0, timeout: 60000, expect: { timeout: 5000 }, reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]], outputDir: '/artifacts/test-results', use: { browserName: 'chromium', hasTouch: true, viewport: { width: 1440, height: 1000 }, screenshot: 'off' } });
