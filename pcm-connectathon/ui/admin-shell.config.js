'use strict';
/** Sprint22 focused real Admin shell; shared consumers run their maintained selections. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests', testMatch: 'admin-shell.spec.js', workers: 1,
    retries: 0, timeout: 60000, expect: { timeout: 5000 },
    reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]], outputDir: '/artifacts/test-results',
    use: { browserName: 'chromium', hasTouch: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' } });
