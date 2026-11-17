'use strict';

/** Standalone owned-fixture operator qualification; does not reuse a live team. */
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');
const base = 'http://127.0.0.1:43180';
const artifacts = path.resolve(process.env.PCM_LOGS_ARTIFACTS || path.join(__dirname, '../../tmp/logs-ui-qualification'));
process.env.PCM_OPS_FIXTURE_URL = base;

module.exports = defineConfig({
    testDir: './tests',
    testMatch: ['logs-scroll.spec.js', 'ui-ops-rem.spec.js', 'logs-landmarks.spec.js', 'logs-workbench.spec.js', 'logs-bottom-event.spec.js'],
    timeout: 45000,
    expect: { timeout: 10000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['line'], ['json', { outputFile: path.join(artifacts, 'results.json') }]],
    outputDir: path.join(artifacts, 'test-results'),
    use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
    webServer: {
        command: `${JSON.stringify(process.execPath)} ops-fixture-server.js`,
        cwd: __dirname,
        url: `${base}/logs-view`,
        reuseExistingServer: false,
        timeout: 30000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }
    },
    projects: [
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
        { name: 'chromium-mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
        { name: 'firefox-smoke', grep: /@smoke/, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
        { name: 'webkit-smoke', grep: /@smoke/, use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } }
    ]
});
