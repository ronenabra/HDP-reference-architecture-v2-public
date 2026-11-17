'use strict';
/** Pinned disposable desktop/native-touch mobile search qualification. */
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const artifacts = path.resolve(process.env.PCM_LOGS_ARTIFACTS || path.join(__dirname, '../../tmp/log-search-ui'));
module.exports = defineConfig({ testDir: './tests', testMatch: 'log-search.spec.js', timeout: 60000,
    expect: { timeout: 10000 }, workers: 1, retries: 0,
    reporter: [['line'], ['json', { outputFile: path.join(artifacts, 'results.json') }]],
    outputDir: path.join(artifacts, 'test-results'),
    use: { baseURL: 'http://127.0.0.1:43184', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    webServer: { command: `${JSON.stringify(process.execPath)} log-search-fixture-server.js`, cwd: __dirname,
        url: 'http://127.0.0.1:43184/healthz', reuseExistingServer: false, timeout: 60000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    projects: [
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
        { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }
    ]
});
