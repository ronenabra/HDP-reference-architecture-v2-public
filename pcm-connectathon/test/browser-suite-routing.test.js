'use strict';
/** The live-team runner must not collect standalone fixture suites without their servers. */
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
/** Read the maintained Playwright config without needing an unpinned host browser installation. */
function config(workflows) {
    const context = { module: { exports: {} }, process: { env: { PCM_UI_WORKFLOWS: String(workflows) } },
        require: () => ({ defineConfig: value => value, devices: {} }) };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/playwright.config.js'), 'utf8'), context);
    return context.module.exports;
}

test('live runtime and standalone owned-server suites have separate executable entrypoints', () => {
    const ordinary = config(false);
    const bindings = {
        'gateway-derived-level.spec.js': 'gateway-level.config.js', 'gateway-arrival.spec.js': 'gateway-arrival.config.js',
        'log-search.spec.js': 'log-search.config.js', 'log-search-benchmark.spec.js': 'log-search-benchmark.config.js',
        'log-inspection.spec.js': 'log-inspection.config.js', 'log-filter-layout.spec.js': 'log-filter-layout.config.js',
        'log-columns.spec.js': 'log-columns.config.js', 'log-copy.spec.js': 'log-copy.config.js', 'log-coverage.spec.js': 'log-coverage.config.js',
        'log-structured.spec.js': 'log-structured.config.js', 'log-classification.spec.js': 'log-classification.config.js',
        'log-status.spec.js': 'log-status.config.js', 'log-metadata-help.spec.js': 'log-help.config.js'
    };
    assert.deepEqual([...ordinary.testIgnore].sort(), Object.keys(bindings).sort());
    for (const [spec, file] of Object.entries(bindings)) {
        assert.ok(fs.existsSync(path.join(root, 'ui/tests', spec)), spec);
        assert.ok(fs.readFileSync(path.join(root, 'ui', file), 'utf8').includes(spec), file);
    }
    for (const spec of ['event-flow.spec.js', 'help-integration.spec.js', 'doctor-diagnostics.spec.js', 'demo-sources.spec.js']) assert.equal(ordinary.testIgnore.includes(spec), false);
    assert.equal(config(true).testDir, './workflow-tests'); assert.equal(config(true).testIgnore.length, 0);
});
