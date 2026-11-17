'use strict';
/** Focused Admin30 central Logs handoff, scope and shared Explain journeys. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: 'admin-logs.spec.js', workers: 1, retries: 0, timeout: 60000, expect: { timeout: 10000 }, reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]], outputDir: '/artifacts/test-results', use: { browserName: 'chromium', hasTouch: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' } });
