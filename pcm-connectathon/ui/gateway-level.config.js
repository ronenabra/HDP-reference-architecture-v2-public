'use strict';

/** Standalone real-route qualification using fabricated owned gateway completions. */
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const baseURL = 'http://127.0.0.1:43183';
const artifacts = path.resolve(process.env.PCM_LOGS_ARTIFACTS || path.join(__dirname, '../../tmp/gateway-level-ui'));
module.exports = defineConfig({
    testDir: './tests', testMatch: 'gateway-derived-level.spec.js',
    timeout: 45000, expect: { timeout: 10000 }, workers: 1, retries: 0,
    reporter: [['line'], ['json', { outputFile: path.join(artifacts, 'results.json') }]],
    outputDir: path.join(artifacts, 'test-results'),
    use: { baseURL, launchOptions: { timeout: 30000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    webServer: {
        command: `${JSON.stringify(process.execPath)} gateway-level-fixture-server.js`, cwd: __dirname,
        url: `${baseURL}/healthz`, reuseExistingServer: false, timeout: 30000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }
    },
    projects: [
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
        { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
        { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } }
    ]
});
