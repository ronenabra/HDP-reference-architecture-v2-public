'use strict';
/** Focused shared-header inspection on the maintained pinned Chromium runtime. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
    testDir: './offline-tests', testMatch: 'foundation.spec.js', workers: 1,
    retries: 0, timeout: 30000, expect: { timeout: 4000 },
    reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]],
    outputDir: '/artifacts/test-results',
    use: { browserName: 'chromium', hasTouch: true, viewport: { width: 1440, height: 1000 } }
});
