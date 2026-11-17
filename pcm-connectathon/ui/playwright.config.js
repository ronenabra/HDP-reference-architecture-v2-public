'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: process.env.PCM_UI_SMART_ADDRESSES === 'true' ? './smart-tests' : process.env.PCM_UI_HMO_JOURNEY === 'true' ? './hmo-tests' : process.env.PCM_UI_WORKFLOWS === 'true' ? './workflow-tests' : './tests',
    // Dedicated family configs own their local servers and native-touch fixtures.
    // Collect the live-team gate explicitly so --list never starts/imports those owners.
    testMatch: process.env.PCM_UI_SMART_ADDRESSES === 'true' || process.env.PCM_UI_HMO_JOURNEY === 'true' || process.env.PCM_UI_WORKFLOWS === 'true'
        ? '**/*.spec.js' : ['event-flow.spec.js', 'doctor-diagnostics.spec.js', 'help-integration.spec.js',
            'batch-integration.spec.js', 'demo-catalog.spec.js', 'demo-access.spec.js', 'demo-patients.spec.js', 'demo-sources.spec.js'],
    // These suites require the owned servers and native-touch settings in their
    // dedicated configs. Collecting them here imports unavailable fixtures or
    // accidentally targets a different job's local listener.
    testIgnore: process.env.PCM_UI_WORKFLOWS === 'true' ? [] : [
        'gateway-derived-level.spec.js', 'gateway-arrival.spec.js',
        'log-search.spec.js', 'log-search-benchmark.spec.js', 'log-inspection.spec.js',
        'log-filter-layout.spec.js', 'log-columns.spec.js', 'log-copy.spec.js',
        'log-coverage.spec.js', 'log-structured.spec.js', 'log-classification.spec.js',
        'log-status.spec.js', 'log-metadata-help.spec.js'
    ],
    timeout: 45000,
    expect: { timeout: 10000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['line'], ['json', { outputFile: '/artifacts/results.json' }]],
    outputDir: '/artifacts/test-results',
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        ignoreHTTPSErrors: true
    },
    projects: [
        { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
        { name: 'chromium-mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
        { name: 'firefox-smoke', grep: /@smoke/, use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
        { name: 'webkit-smoke', grep: /@smoke/, use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } }
    ]
});
