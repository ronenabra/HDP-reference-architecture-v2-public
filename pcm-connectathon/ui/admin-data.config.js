'use strict';
/** Representative data25 forms and maintained whole-Admin pending navigation. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: ['admin-data.spec.js', 'admin-shell.spec.js'],
    grep: /data25|whole Admin navigation|validation keeps/, workers: 1, retries: 0, timeout: 60000,
    expect: { timeout: 5000 }, reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]],
    outputDir: '/artifacts/test-results', use: { browserName: 'chromium', hasTouch: true,
        viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' } });
