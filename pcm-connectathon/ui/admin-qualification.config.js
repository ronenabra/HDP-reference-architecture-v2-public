'use strict';
/** Focused Admin family smoke; final38 owns the complete browser/preset matrix. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: 'admin-qualification.spec.js', workers: 1,
    retries: 0, timeout: 120000, expect: { timeout: 5000 },
    reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]], outputDir: '/artifacts/test-results',
    use: { hasTouch: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
    projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({ name: browserName, use: { browserName } })) });
