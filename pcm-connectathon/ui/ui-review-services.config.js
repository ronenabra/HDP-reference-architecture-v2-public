'use strict';
/** R6 owns focused Services fixtures, with no retained preview application. */
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const artifacts = path.resolve(process.env.PCM_SERVICES_ARTIFACTS || '../../tmp/ui-review-services');
module.exports = defineConfig({
    testDir: './tests', testMatch: ['ui-review-services.spec.js', 'services-scopes.spec.js', 'services-directory.spec.js', 'services-admin.spec.js', 'services-master-data.spec.js', 'services-help.spec.js'],
    timeout: 60000, expect: { timeout: 10000 }, fullyParallel: false, workers: 1, retries: 0,
    reporter: [['line'], ['json', { outputFile: path.join(artifacts, 'results.json') }]],
    outputDir: path.join(artifacts, 'test-results'),
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
    projects: [
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
        { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }
    ]
});
