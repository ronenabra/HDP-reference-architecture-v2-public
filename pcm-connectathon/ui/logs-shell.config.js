'use strict';
/** Focused mounted central/local shell journeys in representative Chromium contexts. */
const { defineConfig, devices } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: 'logs-shell.spec.js', workers: 1, retries: 0,
    timeout: 60000, expect: { timeout: 10000 }, reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]],
    outputDir: '/artifacts/test-results', use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
        { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 1000 } } }] });
