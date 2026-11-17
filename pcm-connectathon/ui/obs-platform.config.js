'use strict';
/** Two representative browser projects for the existing actual-trace investigation. */
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const artifacts = process.env.PCM_LOGS_ARTIFACTS;
module.exports = defineConfig({ testDir: './tests', testMatch: 'obs-platform.spec.js', workers: 1, retries: 0, timeout: 60000,
    reporter: [['line'], ['json', { outputFile: path.join(artifacts, 'results.json') }]], outputDir: path.join(artifacts, 'test-results'),
    use: { baseURL: 'http://127.0.0.1:43186', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    webServer: { command: JSON.stringify(process.execPath) + ' obs-platform-fixture-server.js', cwd: '/repo/pcm-connectathon/ui', url: 'http://127.0.0.1:43186/logs-view', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    projects: [{ name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
        { name: 'chromium-mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }] });
