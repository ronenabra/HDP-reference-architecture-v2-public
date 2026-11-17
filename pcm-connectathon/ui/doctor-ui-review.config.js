'use strict';
/** Offline Doctor presentation checks using the real templates and controllers. */
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
    testDir: './offline-tests', testMatch: 'doctor-ui-review.spec.js', workers: 1,
    retries: 0, timeout: 20000, expect: { timeout: 3000 },
    reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]],
    outputDir: '/artifacts/test-results',
    use: { browserName: 'chromium', screenshot: 'only-on-failure' },
    projects: [
        { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
        { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }
    ]
});
